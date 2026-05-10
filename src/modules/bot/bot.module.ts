import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TelegrafModule, InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { BotUpdate } from './bot.update';
import { BotService } from './bot.service';
import { BotWebhookController } from './bot-webhook.controller';
import { UserModule } from '@/modules/user/user.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { PricingModule } from '@/modules/pricing/pricing.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { FragmentModule } from '@/shared/services/fragment/fragment.module';
import { I18nModule } from '@/shared/services/i18n/i18n.module';
import { SubscriptionMiddleware } from './middleware/subscription.middleware';
import { createTelegrafConfig } from '@/shared/utils/telegraf-config.factory';
import { HealthTrackerService } from '@/modules/health/health-tracker.service';
import { isIgnorableTelegramUserError } from '@/shared/utils/telegram-errors';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      useFactory: async () => {
        return createTelegrafConfig({
          token: process.env.BOT_TOKEN!,
          includeModule: BotModule,
        });
      },
    }),
    UserModule,
    SettingsModule,
    PrismaModule,
    PricingModule,
    PaymentsModule,
    FragmentModule,
    I18nModule,
  ],
  controllers: [BotWebhookController],
  providers: [BotUpdate, BotService, SubscriptionMiddleware],
  exports: [BotService],
})
export class BotModule implements OnModuleInit {
  private readonly logger = new Logger(BotModule.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly healthTracker: HealthTrackerService,
  ) {}

  async onModuleInit() {
    this.bot.catch((err: any) => {
      const msg: string = err?.message ?? String(err);
      if (isIgnorableTelegramUserError(err)) {
        this.logger.debug(`Telegram user action (ignored): ${msg}`);
        return;
      }
      if (msg.includes('timed out') || msg.includes('TimeoutError')) {
        this.healthTracker.recordError();
      }
      this.logger.error(`Unhandled bot error: ${msg}`);
    });

    const isCronWorker = process.env.ENABLE_CRON === 'true';
    const isBroadcastWorker = process.env.ENABLE_BROADCAST === 'true';
    const isScreenshotWorker = process.env.ENABLE_SCREENSHOT === 'true';
    const shouldManageWebhook =
      !isCronWorker && !isBroadcastWorker && !isScreenshotWorker;

    if (!shouldManageWebhook) {
      this.logger.log('Skipping webhook setup in worker pod');
      return;
    }

    const webhookDomain = process.env.WEBHOOK_DOMAIN;
    const webhookPath = process.env.WEBHOOK_PATH || '/api/bot/webhook';

    if (webhookDomain) {
      const webhookUrl = `${webhookDomain}${webhookPath}`;
      // Do not block Nest bootstrap on Telegram API availability.
      void this.setWebhookWithRetry(webhookUrl, 3);
    }
  }

  private async setWebhookWithRetry(
    url: string,
    maxAttempts: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.bot.telegram.setWebhook(url);
        this.logger.log(`Webhook set: ${url}`);
        return;
      } catch (error: any) {
        const retryAfter = error.parameters?.retry_after || 2;
        if (attempt < maxAttempts && error.message?.includes('429')) {
          this.logger.warn(
            `Webhook 429, retrying in ${retryAfter}s (attempt ${attempt}/${maxAttempts})`,
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          this.logger.error(`Failed to set webhook: ${error.message}`);
        }
      }
    }
  }
}
