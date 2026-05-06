import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup } from 'telegraf';
import { BotContext } from '@/shared/types/bot-context.interface';
import { SettingsService } from '@/modules/settings/settings.service';

const SUBSCRIPTION_CACHE_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class SubscriptionMiddleware {
  private readonly logger = new Logger(SubscriptionMiddleware.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly settingsService: SettingsService,
  ) {}

  async handle(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) {
      return next();
    }

    if (
      ctx.session?.subscriptionCheckedAt &&
      Date.now() - ctx.session.subscriptionCheckedAt < SUBSCRIPTION_CACHE_TTL_MS
    ) {
      return next();
    }

    const channels = await this.settingsService.getRequiredChannels();

    if (!channels || channels.length === 0) {
      return next();
    }

    const checkResults = await Promise.allSettled(
      channels.map(async (channel) => {
        try {
          const member = await this.bot.telegram.getChatMember(
            channel.channel_id,
            userId,
          );

          return {
            channel,
            isSubscribed: ['member', 'administrator', 'creator'].includes(
              member.status,
            ),
          };
        } catch (error: any) {
          if (
            error?.message?.includes('chat not found') ||
            error?.message?.includes('bot is not a member') ||
            error?.response?.error_code === 400
          ) {
            return { channel, isSubscribed: true };
          }

          this.logger.error(
            `Error checking subscription for channel ${channel.channel_id}: ${error?.message || error}`,
          );
          return { channel, isSubscribed: false };
        }
      }),
    );

    const unsubscribed: any[] = [];
    for (const result of checkResults) {
      if (result.status === 'fulfilled' && !result.value.isSubscribed) {
        unsubscribed.push(result.value.channel);
      }
    }

    if (unsubscribed.length > 0) {
      await this.sendSubscriptionRequired(ctx, unsubscribed);
      return;
    }

    ctx.session.subscriptionCheckedAt = Date.now();
    return next();
  }

  private async sendSubscriptionRequired(
    ctx: BotContext,
    unsubscribed: any[],
  ): Promise<void> {
    const buttons = unsubscribed.map((channel) => [
      Markup.button.url(
        `📺 ${channel.channel_name || 'Канал'}`,
        channel.channel_link ||
          `https://t.me/${channel.channel_id.replace('@', '')}`,
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        '✅ Проверить подписку',
        'check_subscription',
      ) as any,
    ]);

    try {
      await ctx.replyWithPhoto(
        { source: './images/main_menu.webp' },
        {
          caption:
            '📺 <b>Для использования бота необходимо подписаться на каналы:</b>\n\n',
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
        },
      );
    } catch (error) {
      this.logger.error(
        `SubscriptionMiddleware: error sending photo, trying text: ${error}`,
      );
      try {
        await ctx.reply(
          '📺 <b>Для использования бота необходимо подписаться на каналы:</b>\n\n',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
          },
        );
      } catch (fallbackError) {
        this.logger.error(
          `SubscriptionMiddleware: error sending message to userId=${ctx.from?.id}: ${fallbackError}`,
        );
      }
    }
  }
}
