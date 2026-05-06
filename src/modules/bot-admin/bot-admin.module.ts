import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { TelegrafModule, InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { BotAdminUpdate } from './bot-admin.update';
import { BotAdminService } from './bot-admin.service';
import { BotAdminWebhookController } from './bot-admin-webhook.controller';
import { UserModule } from '@/modules/user/user.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { PricingModule } from '@/modules/pricing/pricing.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { BotModule } from '@/modules/bot/bot.module';
import { FraudModule } from '@/modules/fraud/fraud.module';
import { AdminHandlers as SharedAdminHandlers } from '@/shared/handlers/admin.handlers';
import { UserService } from '@/modules/user/user.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { PaymentsService } from '@/modules/payments/payments.service';
import { BotService } from '@/modules/bot/bot.service';
import { createTelegrafConfig } from '@/shared/utils/telegraf-config.factory';
import { I18nModule } from '@/shared/services/i18n/i18n.module';
import { I18nService } from '@/shared/services/i18n/i18n.service';

@Module({
  imports: [
    TelegrafModule.forRootAsync({
      botName: 'admin',
      useFactory: async () => {
        const token = process.env.BOT_ADMIN_TOKEN!;

        if (!token) {
          throw new Error('BOT_ADMIN_TOKEN is not set');
        }

        return createTelegrafConfig({
          token,
          botName: 'admin',
          includeModule: BotAdminModule,
        });
      },
    }),
    UserModule,
    SettingsModule,
    PrismaModule,
    PricingModule,
    PaymentsModule,
    BotModule,
    FraudModule,
    I18nModule,
  ],
  controllers: [BotAdminWebhookController],
  providers: [
    BotAdminUpdate,
    BotAdminService,
    {
      provide: 'AdminHandlers',
      useFactory: (
        settingsService: SettingsService,
        paymentsService: PaymentsService,
        userService: UserService,
        botService: BotService,
        i18nService: I18nService,
      ) => {
        return new SharedAdminHandlers(
          settingsService,
          paymentsService,
          userService,
          botService,
          i18nService,
          false,
          false,
        );
      },
      inject: [
        SettingsService,
        PaymentsService,
        UserService,
        BotService,
        I18nService,
      ],
    },
  ],
  exports: [BotAdminService],
})
export class BotAdminModule implements OnModuleInit {
  private readonly logger = new Logger(BotAdminModule.name);

  constructor(@InjectBot('admin') private readonly bot: Telegraf) {}

  async onModuleInit() {
    const webhookDomain = process.env.WEBHOOK_DOMAIN;

    if (webhookDomain) {
      const webhookUrl = `${webhookDomain}/api/bot-admin/webhook`;
      await this.setWebhookWithRetry(webhookUrl, 3);
    }
  }

  private async setWebhookWithRetry(
    url: string,
    maxAttempts: number,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.bot.telegram.setWebhook(url);
        this.logger.log(`Admin webhook set: ${url}`);
        return;
      } catch (error: any) {
        const retryAfter = error.parameters?.retry_after || 2;
        if (attempt < maxAttempts && error.message?.includes('429')) {
          this.logger.warn(
            `Admin webhook 429, retrying in ${retryAfter}s (attempt ${attempt}/${maxAttempts})`,
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          this.logger.error(`Failed to set admin webhook: ${error.message}`);
        }
      }
    }
  }
}
