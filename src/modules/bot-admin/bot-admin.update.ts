import { Update, Ctx, Action, On, Start, Command } from 'nestjs-telegraf';
import { Logger, Inject, Optional } from '@nestjs/common';
import { Markup, Input, Telegraf } from 'telegraf';
import { UserService } from '@/modules/user/user.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { AdminHandlers } from '@/shared/handlers/admin.handlers';
import { AdminKeyboard } from '@/shared/keyboards/admin.keyboard';
import { BotContext } from '@/shared/types/bot-context.interface';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { PaymentAdminService } from '@/modules/payments/payment-admin.service';
import { PaymentsService } from '@/modules/payments/payments.service';
import { FragmentAccountService } from '@/shared/services/fragment/fragment-account.service';
import { FragmentService } from '@/shared/services/fragment/fragment.service';
import { RapiraService } from '@/shared/services/rapira/rapira.service';
import { FraudService } from '@/modules/fraud/fraud.service';
import { PaymentHealthService } from '@/modules/payments/payment-health.service';
import { BroadcastQueueService } from '@/modules/cron/broadcast-queue.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { escapeHtml } from '@/shared/utils/product.utils';
import { toMoscowTime, formatShortDateTimeMoscow } from '@/shared/utils';
import { normalizeSnapshotStorageUrl } from '@/shared/utils/storage-url.utils';
import { InjectBot } from 'nestjs-telegraf';
@Update()
export class BotAdminUpdate {
  private readonly logger = new Logger(BotAdminUpdate.name);

  constructor(
    private readonly userService: UserService,
    private readonly settingsService: SettingsService,
    @Inject('AdminHandlers')
    private readonly adminHandlers: AdminHandlers,
    private readonly prisma: PrismaService,
    private readonly paymentAdmin: PaymentAdminService,
    private readonly paymentsService: PaymentsService,
    private readonly fragmentAccountService: FragmentAccountService,
    private readonly fragmentService: FragmentService,
    private readonly rapiraService: RapiraService,
    private readonly fraudService: FraudService,
    private readonly paymentHealthService: PaymentHealthService,
    @Optional() private readonly broadcastQueueService: BroadcastQueueService,
    private readonly redisLock: RedisLockService,
    @InjectBot() private readonly mainBot: Telegraf,
  ) {}

  @Start()
  @Command('admin')
  async onStart(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingPaymentSearch = false;
    ctx.session.searchUserPurchases = false;
    ctx.session.awaitingBlockUser = false;
    ctx.session.awaitingUnblockUser = false;
    ctx.session.awaitingMassBlock = false;
    ctx.session.awaitingStatsStartDate = false;
    ctx.session.awaitingStatsEndDate = false;
    ctx.session.awaitingServiceMarkup = false;
    ctx.session.serviceMarkupSystem = undefined;
    ctx.session.awaitingPaymentFee = false;
    ctx.session.paymentFeeSystem = undefined;
    ctx.session.awaitingFailoverThreshold = false;
    ctx.session.awaitingFailoverCooldown = false;
    ctx.session.fromAdminSearch = false;
    ctx.session.awaitingSalesChannel = false;
    ctx.session.awaitingSalesNotificationMinRub = false;
    ctx.session.awaitingInsufficientFundsChannel = false;
    ctx.session.awaitingFraudChannel = false;
    ctx.session.awaitingChannel = false;
    ctx.session.awaitingChannelInviteLink = false;
    ctx.session.pendingChannelId = undefined;
    ctx.session.pendingChannelName = undefined;
    ctx.session.lastBotMessageId = undefined;
    ctx.session.awaitingMinTonRate = false;
    ctx.session.awaitingMinUsdtRate = false;
    ctx.session.awaitingPurchaseLimit = false;
    ctx.session.pendingPurchaseLimitField = undefined;
    ctx.session.awaitingFraudAmount = false;
    ctx.session.pendingFraudAmountField = undefined;
    ctx.session.awaitingFraudUser = false;
    ctx.session.awaitingFraudUnban = false;
    ctx.session.awaitingCaptchaUnban = false;
    ctx.session.fraudList = undefined;
    ctx.session.fraudCurrentPage = undefined;
    ctx.session.awaitingFragmentAccountName = false;
    ctx.session.awaitingFragmentAccountTokens = false;
    ctx.session.awaitingFragmentAccountUpdate = false;
    ctx.session.pendingFragmentAccountName = undefined;
    ctx.session.pendingFragmentAccountId = undefined;
    ctx.session.awaitingButtonTemplateName = false;
    ctx.session.pendingButtonTemplateButtons = undefined;
    ctx.session.buttonTemplateEditId = undefined;
    ctx.session.awaitingStuckPaymentUsername = false;
    ctx.session.pendingStuckPaymentId = undefined;
    ctx.session.broadcastTargetAudience = undefined;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);

    if (isAdmin) {
      await this.adminHandlers.showAdminMenu(ctx);
    } else {
      await ctx.reply(
        '❌ <b>Доступ запрещен</b>\n\nУ вас нет доступа к админ панели.',
        { parse_mode: 'HTML' },
      );
    }
  }

  @Command('fix_usernames')
  async fixUsernames(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);

    if (!isAdmin) {
      await ctx.reply('❌ <b>Доступ запрещен</b>', { parse_mode: 'HTML' });
      return;
    }

    try {
      await ctx.reply('🔧 <b>Исправление пустых username в очереди...</b>', {
        parse_mode: 'HTML',
      });

      const result = await this.paymentsService.fixEmptyUsernamesInQueue();

      let message = `✅ <b>Исправление завершено!</b>\n\n`;
      message += `📊 <b>Статистика:</b>\n`;
      message += `├ Найдено: ${result.found}\n`;
      message += `├ Исправлено: ${result.fixed} ✅\n`;
      message += `└ Ошибок: ${result.failed} ❌\n`;

      if (result.details.length > 0) {
        message += `\n📋 <b>Детали:</b>\n`;
        for (const detail of result.details.slice(0, 10)) {
          const orderNum = detail.orderNumber || 'N/A';
          const status = detail.status === 'fixed' ? '✅' : '❌';
          const username = detail.targetUsername || 'не найден';
          message += `${status} Заказ #${orderNum}: ${username}\n`;
        }
        if (result.details.length > 10) {
          message += `\n... и ещё ${result.details.length - 10}\n`;
        }
      }

      await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error: any) {
      this.logger.error(`Error fixing usernames: ${error.message}`);
      await ctx.reply(
        `❌ <b>Ошибка при исправлении:</b>\n<code>${error.message}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  }

  private async checkAccess(ctx: BotContext): Promise<boolean> {
    const userId = ctx.from?.id.toString();
    if (!userId) {
      try {
        await ctx.reply('❌ Ошибка идентификации');
      } catch {}
      return false;
    }

    const isAdmin = await this.userService.isAdmin(userId);
    if (isAdmin) return true;

    const isCallback = !!(ctx as any).callbackQuery;
    try {
      if (isCallback) {
        await (ctx as any).answerCbQuery('❌ Нет доступа');
      } else {
        await ctx.reply('❌ Нет доступа');
      }
    } catch {}
    return false;
  }

  private paymentSystemAdminLabel(system: string): string {
    switch (system) {
      case 'PLATEGA':
        return 'Platega';
      case 'HELEKET':
        return 'Heleket';
      case 'SBP2':
        return 'СБП 2';
      case 'AURAPAY_SBP':
      case 'AURAPAY_CARD':
        return 'СБП 3 / Карта (Aurapay)';
      case 'TON':
        return 'TON';
      default:
        return system;
    }
  }

  @Action('admin_back')
  async adminBack(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    ctx.session.searchResults = undefined;
    ctx.session.currentPage = undefined;
    ctx.session.searchQuery = undefined;
    ctx.session.fromAdminSearch = false;

    const userId = ctx.from?.id.toString();
    if (!userId) return;
    const isAdmin = await this.userService.isAdmin(userId);
    if (isAdmin) {
      await this.adminHandlers.showAdminMenu(ctx);
    }
  }

  @Action('admin_stats')
  async adminStats(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}
    await this.adminHandlers.showStats(ctx);
  }

  @Action('stats_period')
  async statsPeriod(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
📅 <b>Статистика за период</b>

Введите дату начала периода в формате ДД.ММ.ГГГГ

<b>Пример:</b> <code>01.01.2024</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToStats().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingStatsStartDate = true;
    ctx.session.statsStartDate = undefined;
    ctx.session.statsEndDate = undefined;
  }

  @Action('stats_refresh')
  async statsRefresh(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await ctx.answerCbQuery('Обновление статистики...');
    try {
      await ctx.deleteMessage();
    } catch {}
    await this.adminHandlers.showStats(ctx);
  }

  @Action('admin_broadcast')
  async adminBroadcast(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    if (this.broadcastQueueService) {
      const active = await this.broadcastQueueService.getActiveBroadcast();
      if (active) {
        const percent =
          active.total_users > 0
            ? Math.round((active.processed_users / active.total_users) * 100)
            : 0;

        const statusEmoji = active.status === 'PROCESSING' ? '🔄' : '⏳';

        const startedAt = active.created_at
          ? new Date(active.created_at).toLocaleString('ru-RU', {
              timeZone: 'Europe/Moscow',
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—';

        const aud =
          (active as any).target_audience === 'premium'
            ? '⭐ Premium'
            : (active as any).target_audience === 'non_premium'
              ? '👤 Без Premium'
              : '👥 Все';

        const text = `📢 <b>Рассылка в процессе</b>

${statusEmoji} Статус: <b>${active.status === 'PROCESSING' ? 'Отправляется' : 'В очереди'}</b>
👥 Аудитория: <b>${aud}</b>
📊 Прогресс: <b>${active.processed_users} / ${active.total_users || '?'}</b>${active.total_users > 0 ? ` (${percent}%)` : ''}
✅ Успешно: <b>${active.success_count}</b>
❌ Ошибок: <b>${active.failed_count}</b>
🕐 Запущена: <b>${startedAt}</b>

Создать новую рассылку нельзя, пока текущая не завершится.`;

        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '🛑 Остановить рассылку',
                `broadcast_stop_${active.id}`,
              ),
            ],
            [Markup.button.callback('◀️ Назад', 'admin_back')],
          ]).reply_markup,
        });
        return;
      }
    }

    await ctx.reply('📢 <b>Рассылка</b>\n\nВыберите действие:', {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBroadcastSubmenu().reply_markup,
    });
  }

  @Action('broadcast_start')
  async broadcastStart(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}
    await this.adminHandlers.showBroadcastMenu(ctx);
  }

  @Action('channels_menu')
  async channelsMenu(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}
    await ctx.reply('📺 <b>Каналы</b>\n\nВыберите тип каналов для настройки:', {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getChannelsSubmenu().reply_markup,
    });
  }

  @Action(/^broadcast_stop_(.+)$/)
  async broadcastStop(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const broadcastId = (ctx as any).match[1];
    if (!broadcastId || !this.broadcastQueueService) return;

    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      await this.broadcastQueueService.stopBroadcast(broadcastId);
      await ctx.reply(
        '🛑 <b>Рассылка остановлена.</b>\n\nТекущий батч дошлётся, после чего рассылка прекратится.',
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        },
      );
    } catch (err: any) {
      await ctx.reply(`❌ Ошибка: ${err.message}`, {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
    }
  }

  @Action('broadcast_test')
  async broadcastTest(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const message =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption;
    const photo = ctx.session.broadcastPhoto;
    const photoFileId = ctx.session.broadcastPhotoFileId;
    const animation = ctx.session.broadcastAnimation;
    const animationFileId = ctx.session.broadcastAnimationFileId;
    const video = ctx.session.broadcastVideo;
    const videoFileId = ctx.session.broadcastVideoFileId;
    const stickerFileId = ctx.session.broadcastStickerFileId;
    const audioFileId = ctx.session.broadcastAudioFileId;
    const audio = ctx.session.broadcastAudio;
    const entities = ctx.session.broadcastEntities;
    const captionEntities = ctx.session.broadcastCaptionEntities;
    const buttons = ctx.session.broadcastButtons || [];

    if (!message && !stickerFileId) {
      await ctx.reply('❌ Ошибка: сообщение не найдено');
      return;
    }

    const result = await this.adminHandlers.sendBroadcast(ctx, message || '', {
      photo,
      animation,
      video,
      sticker: stickerFileId,
      audio: audioFileId || audio || undefined,
      testMode: true,
      entities,
      caption_entities: captionEntities,
      buttons,
    });

    ctx.session.lastBroadcastStats = {
      total: result.total,
      success: result.success,
      failed: result.failed,
      date: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    };

    await ctx.reply(
      `✅ Тест отправлен админам\n👥 Всего: ${result.total}\n✅ Доставлено: ${result.success}\n❌ Ошибок: ${result.failed}`,
    );

    const previewText = message || '';
    const previewEntities = entities || captionEntities;

    let sentMessage;
    if (photoFileId) {
      sentMessage = await ctx.telegram.sendPhoto(ctx.chat!.id, photoFileId, {
        caption: previewText,
        caption_entities: previewEntities,
        ...AdminKeyboard.getBroadcastConfirm(true),
      });
    } else if (photo) {
      try {
        const photoBuffer = Buffer.from(photo, 'base64');
        sentMessage = await ctx.telegram.sendPhoto(
          ctx.chat!.id,
          Input.fromBuffer(photoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      } catch {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      }
    } else if (animationFileId) {
      sentMessage = await ctx.telegram.sendAnimation(
        ctx.chat!.id,
        animationFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastConfirm(true),
        },
      );
    } else if (animation) {
      try {
        const animBuffer = Buffer.from(animation, 'base64');
        sentMessage = await ctx.telegram.sendAnimation(
          ctx.chat!.id,
          Input.fromBuffer(animBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      } catch {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      }
    } else if (videoFileId) {
      sentMessage = await ctx.telegram.sendVideo(ctx.chat!.id, videoFileId, {
        caption: previewText,
        caption_entities: previewEntities,
        ...AdminKeyboard.getBroadcastConfirm(true),
      });
    } else if (video) {
      try {
        const videoBuffer = Buffer.from(video, 'base64');
        sentMessage = await ctx.telegram.sendVideo(
          ctx.chat!.id,
          Input.fromBuffer(videoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      } catch {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      }
    } else if (stickerFileId) {
      sentMessage = await ctx.telegram.sendSticker(
        ctx.chat!.id,
        stickerFileId,
        {
          ...AdminKeyboard.getBroadcastConfirm(true),
        } as any,
      );
    } else if (audioFileId) {
      sentMessage = await ctx.telegram.sendAudio(ctx.chat!.id, audioFileId, {
        caption: previewText,
        caption_entities: previewEntities,
        ...AdminKeyboard.getBroadcastConfirm(true),
      });
    } else if (audio) {
      try {
        const audioBuffer = Buffer.from(audio, 'base64');
        sentMessage = await ctx.telegram.sendAudio(
          ctx.chat!.id,
          Input.fromBuffer(audioBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      } catch {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(true),
          },
        );
      }
    } else {
      sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, previewText, {
        entities: previewEntities,
        ...AdminKeyboard.getBroadcastConfirm(true),
      });
    }

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @Action('broadcast_send_all')
  async broadcastSendAll(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try { await ctx.deleteMessage(); } catch {}

    await ctx.reply(
      '👥 <b>Выберите аудиторию для рассылки:</b>',
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBroadcastAudienceMenu().reply_markup,
      },
    );
  }

  @Action('broadcast_add_button')
  async broadcastAddButton(@Ctx() ctx: BotContext): Promise<void> {
    const isTemplateMode =
      ctx.session.pendingButtonTemplateButtons !== undefined;

    if (!isTemplateMode) {
      if (!ctx.session.broadcastButtons) {
        ctx.session.broadcastButtons = [];
      }

      if (ctx.session.broadcastButtons.length >= 10) {
        await ctx.answerCbQuery('❌ Максимум 10 кнопок', { show_alert: true });
        return;
      }
    } else {
      if ((ctx.session.pendingButtonTemplateButtons?.length ?? 0) >= 10) {
        await ctx.answerCbQuery('❌ Максимум 10 кнопок', { show_alert: true });
        return;
      }
    }

    ctx.session.awaitingBroadcastButton = true;
    ctx.session.currentBroadcastButtonText = undefined;

    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    const buttonNum = isTemplateMode
      ? (ctx.session.pendingButtonTemplateButtons?.length ?? 0) + 1
      : (ctx.session.broadcastButtons?.length ?? 0) + 1;

    const sentMessage = await ctx.reply(
      `📝 <b>Добавление кнопки ${buttonNum}</b>\n\n` +
        `Отправьте кнопку в формате:\n` +
        `<code>Текст кнопки - https://ссылка</code>\n\n` +
        `<i>Пример: ⭐️КУПИТЬ STARS⭐️ - https://t.me/MopsStarsBot?start=stars</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '🔙 Назад к кнопкам',
              isTemplateMode ? 'btn_tpl_create' : 'broadcast_back_to_buttons',
            ),
          ],
        ]).reply_markup,
      },
    );

    ctx.session.lastBotMessageId = sentMessage.message_id;
  }

  @Action('broadcast_remove_button')
  async broadcastRemoveButton(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const isTemplateMode =
      ctx.session.pendingButtonTemplateButtons !== undefined;

    if (isTemplateMode) {
      if (
        !ctx.session.pendingButtonTemplateButtons ||
        ctx.session.pendingButtonTemplateButtons.length === 0
      ) {
        await ctx.answerCbQuery('❌ Нет кнопок для удаления', {
          show_alert: true,
        });
        return;
      }
      ctx.session.pendingButtonTemplateButtons.pop();

      try {
        await ctx.deleteMessage();
      } catch {}

      const tplButtons = ctx.session.pendingButtonTemplateButtons;
      const msg = await ctx.reply(
        `📋 <b>Создание шаблона кнопок</b>\n\n` +
          (tplButtons.length > 0
            ? `Кнопки:\n` +
              tplButtons.map((b, i) => `${i + 1}. ${b.text}`).join('\n') +
              `\n\n`
            : '') +
          `Добавьте кнопки для шаблона.\n` +
          `Формат: <code>Текст кнопки - https://ссылка.ru</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getBroadcastButtonsMenu([], false)
            .reply_markup,
        },
      );
      ctx.session.lastBotMessageId = msg.message_id;
      return;
    }

    if (
      !ctx.session.broadcastButtons ||
      ctx.session.broadcastButtons.length === 0
    ) {
      await ctx.answerCbQuery('❌ Нет кнопок для удаления', {
        show_alert: true,
      });
      return;
    }

    ctx.session.broadcastButtons.pop();

    try {
      await ctx.deleteMessage();
    } catch {}

    const previewText =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption || '';
    const previewEntities =
      ctx.session.broadcastEntities || ctx.session.broadcastCaptionEntities;

    let sentMessage;
    if (ctx.session.broadcastPhotoFileId) {
      sentMessage = await ctx.telegram.sendPhoto(
        ctx.chat!.id,
        ctx.session.broadcastPhotoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
          ),
        },
      );
    } else if (ctx.session.broadcastPhoto) {
      try {
        const photoBuffer = Buffer.from(ctx.session.broadcastPhoto, 'base64');
        sentMessage = await ctx.telegram.sendPhoto(
          ctx.chat!.id,
          Input.fromBuffer(photoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      }
    } else if (ctx.session.broadcastAnimationFileId) {
      sentMessage = await ctx.telegram.sendAnimation(
        ctx.chat!.id,
        ctx.session.broadcastAnimationFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
          ),
        },
      );
    } else if (ctx.session.broadcastAnimation) {
      try {
        const animBuffer = Buffer.from(
          ctx.session.broadcastAnimation,
          'base64',
        );
        sentMessage = await ctx.telegram.sendAnimation(
          ctx.chat!.id,
          Input.fromBuffer(animBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      }
    } else if (ctx.session.broadcastVideoFileId) {
      sentMessage = await ctx.telegram.sendVideo(
        ctx.chat!.id,
        ctx.session.broadcastVideoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
          ),
        },
      );
    } else if (ctx.session.broadcastVideo) {
      try {
        const videoBuffer = Buffer.from(ctx.session.broadcastVideo, 'base64');
        sentMessage = await ctx.telegram.sendVideo(
          ctx.chat!.id,
          Input.fromBuffer(videoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons,
            ),
          },
        );
      }
    } else {
      sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, previewText, {
        entities: previewEntities,
        ...AdminKeyboard.getBroadcastButtonsMenu(ctx.session.broadcastButtons),
      });
    }

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
    ctx.session.lastBotMessageId = sentMessage.message_id;
  }

  @Action('broadcast_back_to_buttons')
  async broadcastBackToButtons(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    ctx.session.awaitingBroadcastButton = false;
    ctx.session.currentBroadcastButtonText = undefined;

    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    const previewText =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption || '';
    const previewEntities =
      ctx.session.broadcastEntities || ctx.session.broadcastCaptionEntities;

    let sentMessage;
    if (ctx.session.broadcastPhotoFileId) {
      sentMessage = await ctx.telegram.sendPhoto(
        ctx.chat!.id,
        ctx.session.broadcastPhotoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons || [],
          ),
        },
      );
    } else if (ctx.session.broadcastPhoto) {
      try {
        const photoBuffer = Buffer.from(ctx.session.broadcastPhoto, 'base64');
        sentMessage = await ctx.telegram.sendPhoto(
          ctx.chat!.id,
          Input.fromBuffer(photoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      }
    } else if (ctx.session.broadcastAnimationFileId) {
      sentMessage = await ctx.telegram.sendAnimation(
        ctx.chat!.id,
        ctx.session.broadcastAnimationFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons || [],
          ),
        },
      );
    } else if (ctx.session.broadcastAnimation) {
      try {
        const animBuffer = Buffer.from(
          ctx.session.broadcastAnimation,
          'base64',
        );
        sentMessage = await ctx.telegram.sendAnimation(
          ctx.chat!.id,
          Input.fromBuffer(animBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      }
    } else if (ctx.session.broadcastVideoFileId) {
      sentMessage = await ctx.telegram.sendVideo(
        ctx.chat!.id,
        ctx.session.broadcastVideoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons || [],
          ),
        },
      );
    } else if (ctx.session.broadcastVideo) {
      try {
        const videoBuffer = Buffer.from(ctx.session.broadcastVideo, 'base64');
        sentMessage = await ctx.telegram.sendVideo(
          ctx.chat!.id,
          Input.fromBuffer(videoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastButtonsMenu(
              ctx.session.broadcastButtons || [],
            ),
          },
        );
      }
    } else {
      sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, previewText, {
        entities: previewEntities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons || [],
        ),
      });
    }

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
    ctx.session.lastBotMessageId = sentMessage.message_id;
  }

  @Action('broadcast_finish_buttons')
  async broadcastFinishButtons(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    if (ctx.session.pendingButtonTemplateButtons !== undefined) {
      const tplButtons = ctx.session.pendingButtonTemplateButtons;
      if (tplButtons.length === 0) {
        await ctx.answerCbQuery('❌ Добавьте хотя бы одну кнопку');
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}

      ctx.session.awaitingButtonTemplateName = true;
      const msg = await ctx.reply(
        `✅ Кнопки добавлены (${tplButtons.length} шт.):\n` +
          tplButtons.map((b, i) => `${i + 1}. ${b.text}`).join('\n') +
          `\n\nВведите название шаблона:`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('❌ Отменить', 'btn_tpl_list')],
          ]).reply_markup,
        },
      );
      ctx.session.lastBotMessageId = msg.message_id;
      return;
    }

    try {
      await ctx.deleteMessage();
    } catch {}

    const previewText =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption || '';
    const previewEntities =
      ctx.session.broadcastEntities || ctx.session.broadcastCaptionEntities;

    let sentMessage;
    if (ctx.session.broadcastPhotoFileId) {
      sentMessage = await ctx.telegram.sendPhoto(
        ctx.chat!.id,
        ctx.session.broadcastPhotoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastConfirm(false),
        },
      );
    } else if (ctx.session.broadcastPhoto) {
      try {
        const photoBuffer = Buffer.from(ctx.session.broadcastPhoto, 'base64');
        sentMessage = await ctx.telegram.sendPhoto(
          ctx.chat!.id,
          Input.fromBuffer(photoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      }
    } else if (ctx.session.broadcastAnimationFileId) {
      sentMessage = await ctx.telegram.sendAnimation(
        ctx.chat!.id,
        ctx.session.broadcastAnimationFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastConfirm(false),
        },
      );
    } else if (ctx.session.broadcastAnimation) {
      try {
        const animBuffer = Buffer.from(
          ctx.session.broadcastAnimation,
          'base64',
        );
        sentMessage = await ctx.telegram.sendAnimation(
          ctx.chat!.id,
          Input.fromBuffer(animBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      }
    } else if (ctx.session.broadcastVideoFileId) {
      sentMessage = await ctx.telegram.sendVideo(
        ctx.chat!.id,
        ctx.session.broadcastVideoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastConfirm(false),
        },
      );
    } else if (ctx.session.broadcastVideo) {
      try {
        const videoBuffer = Buffer.from(ctx.session.broadcastVideo, 'base64');
        sentMessage = await ctx.telegram.sendVideo(
          ctx.chat!.id,
          Input.fromBuffer(videoBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      } catch (error) {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      }
    } else if (ctx.session.broadcastStickerFileId) {
      sentMessage = await ctx.telegram.sendSticker(
        ctx.chat!.id,
        ctx.session.broadcastStickerFileId,
        {
          ...AdminKeyboard.getBroadcastConfirm(false),
        },
      );
    } else if (ctx.session.broadcastAudioFileId) {
      sentMessage = await ctx.telegram.sendAudio(
        ctx.chat!.id,
        ctx.session.broadcastAudioFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastConfirm(false),
        },
      );
    } else if (ctx.session.broadcastAudio) {
      try {
        const audioBuffer = Buffer.from(ctx.session.broadcastAudio, 'base64');
        sentMessage = await ctx.telegram.sendAudio(
          ctx.chat!.id,
          Input.fromBuffer(audioBuffer),
          {
            caption: previewText,
            caption_entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      } catch {
        sentMessage = await ctx.telegram.sendMessage(
          ctx.chat!.id,
          previewText,
          {
            entities: previewEntities,
            ...AdminKeyboard.getBroadcastConfirm(false),
          },
        );
      }
    } else {
      sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, previewText, {
        entities: previewEntities,
        ...AdminKeyboard.getBroadcastConfirm(false),
      });
    }

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @Action('broadcast_cancel')
  async broadcastCancel(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingBroadcastButton = false;
    ctx.session.currentBroadcastButtonText = undefined;
    ctx.session.broadcastMessage = undefined;
    ctx.session.broadcastPhoto = undefined;
    ctx.session.broadcastPhotoFileId = undefined;
    ctx.session.broadcastAnimation = undefined;
    ctx.session.broadcastAnimationFileId = undefined;
    ctx.session.broadcastVideo = undefined;
    ctx.session.broadcastVideoFileId = undefined;
    ctx.session.broadcastSticker = undefined;
    ctx.session.broadcastStickerFileId = undefined;
    ctx.session.broadcastAudio = undefined;
    ctx.session.broadcastAudioFileId = undefined;
    ctx.session.broadcastCaption = undefined;
    ctx.session.broadcastMessageId = undefined;
    ctx.session.broadcastFromChatId = undefined;
    ctx.session.broadcastEntities = undefined;
    ctx.session.broadcastCaptionEntities = undefined;
    ctx.session.broadcastButtons = undefined;
    ctx.session.broadcastTargetAudience = undefined;

    await this.adminBroadcast(ctx);
  }

  @Action('admin_settings')
  async adminSettings(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    await ctx.reply('⚙️ Настройки в разработке', {
      reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
    });
  }

  @Action('admin_search')
  async adminSearch(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    ctx.session.fromAdminSearch = true;
    ctx.session.fromFailedDeliveries = false;

    ctx.session.searchResults = undefined;
    ctx.session.currentPage = undefined;
    ctx.session.searchQuery = undefined;

    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🔍 <b>Поиск</b>

Выберите тип поиска:
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getSearchMenu().reply_markup,
    });
  }

  @Action('search_specific')
  async searchSpecific(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🔍 <b>Поиск конкретного платежа</b>

📝 Отправьте один из параметров для поиска:
• Номер заказа (UUID или числовой)
• ID транзакции из платежной системы
• ID пользователя (числовой Telegram ID) — список <b>всех</b> его заказов, включая подарки
• @Username покупателя или получателя
• TON комментарий (payload из Fragment)
• Hash транзакции в TON блокчейне (tx_hash)

<b>Примеры:</b>
<code>a1b2c3d4-5678-90ef-ghij-klmnopqrstuv</code>
<code>123456789</code>
<code>@username</code>
<code>95bfa61b8e34cc2de6424c046cb8653f...</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToSearch().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingPaymentSearch = true;
  }

  @Action('search_user_purchases')
  async searchUserPurchases(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
📋 <b>Поиск всех покупок пользователя</b>

Отправьте ID пользователя или @username для поиска всех его покупок.

<b>Пример:</b>
<code>123456789</code>
<code>@username</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToSearch().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingPaymentSearch = true;
    ctx.session.searchUserPurchases = true;
  }

  @Action('admin_channels')
  async adminChannels(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    ctx.session.awaitingChannel = false;
    ctx.session.awaitingChannelInviteLink = false;
    ctx.session.pendingChannelId = undefined;
    ctx.session.pendingChannelName = undefined;

    const channels = await this.settingsService.getRequiredChannels();

    let text = '<b>📺 Управление обязательными каналами</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Текущие обязательные каналы:</b>\n\n';
      for (const channel of channels) {
        const channelInfo = channel.channel_name || channel.channel_id;
        text += `<b>• ${channelInfo}</b>\n`;
        if (channel.channel_link) {
          text += `<b>  └ Ссылка: <code>${channel.channel_link}</code></b>\n`;
        }
        text += `<b>  └ ID: <code>${channel.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>❌ Обязательные каналы не добавлены</b>\n\n';
    }

    text += '<b>Выберите действие:</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getChannelsMenu(channels).reply_markup,
    });
  }

  @Action('channel_add')
  async channelAdd(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
<b>➕ Добавление канала</b>

<b>Для добавления канала отправьте сообщение в формате:</b>

<b><code>@channel_username</code> или <code>-100XXXXXXXXXX</code></b>

<b>📝 Пример:</b>
<b>• <code>@my_channel</code></b>
<b>• <code>-1001234567890</code></b>

<b>⚠️ Важно:</b>
<b>• Бот должен быть администратором канала</b>
<b>• Укажите username канала с @ или числовой ID</b>
    `;

    ctx.session.awaitingChannel = true;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'admin_channels')],
      ]).reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
  }

  @Action('channel_remove')
  async channelRemove(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getRequiredChannels();

    if (channels.length === 0) {
      await ctx.answerCbQuery('❌ Нет каналов для удаления', {
        show_alert: true,
      });
      return;
    }

    const text =
      '<b>➖ Удаление канала</b>\n\n<b>Выберите канал для удаления:</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getChannelDeleteMenu(channels).reply_markup,
    });
  }

  @Action(/^channel_delete_(.+)$/)
  async channelDelete(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const channelId = match[1];

    try {
      await this.settingsService.removeRequiredChannel(channelId);
      await ctx.answerCbQuery('✅ Канал удалён', { show_alert: true });
    } catch (error: any) {
      this.logger.error(`Error removing channel: ${error.message}`);
      await ctx.answerCbQuery('❌ Ошибка при удалении', { show_alert: true });
    }

    const channels = await this.settingsService.getRequiredChannels();

    let text = '<b>📺 Управление обязательными каналами</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Текущие обязательные каналы:</b>\n\n';
      for (const channel of channels) {
        const channelInfo = channel.channel_name || channel.channel_id;
        text += `<b>• ${channelInfo}</b>\n`;
        if (channel.channel_link) {
          text += `<b>  └ Ссылка: <code>${channel.channel_link}</code></b>\n`;
        }
        text += `<b>  └ ID: <code>${channel.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>❌ Обязательные каналы не добавлены</b>\n\n';
    }

    text += '<b>Выберите действие:</b>';

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getChannelsMenu(channels).reply_markup,
      });
    } catch (error: any) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getChannelsMenu(channels).reply_markup,
      });
    }
  }

  @Action('admin_blocking')
  async adminBlocking(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🚫 <b>Блокировка пользователя</b>

Выберите действие:
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBlockingMenu().reply_markup,
    });
  }

  @Action('block_user')
  async blockUser(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🚫 <b>Блокировка пользователя</b>

Отправьте ID или @username пользователя для блокировки:

<b>Примеры:</b>
• <code>123456789</code>
• <code>@username</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingBlockUser = true;
  }

  @Action('unblock_user')
  async unblockUser(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
✅ <b>Разблокировка пользователя</b>

Отправьте ID или @username пользователя для разблокировки:

<b>Примеры:</b>
• <code>123456789</code>
• <code>@username</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingUnblockUser = true;
  }

  @Action('mass_block_user')
  async massBlockUser(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🚫 <b>Массовая блокировка пользователей</b>

Отправьте ID или @username пользователей через запятую или с новой строки:

<b>Примеры:</b>
• <code>123456789, 987654321, @username</code>
• Каждый ID/username с новой строки

<b>Формат:</b> Каждый ID или @username на отдельной строке или через запятую
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingMassBlock = true;
  }

  @Action('captcha_unban')
  async captchaUnban(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🔓 <b>Снятие ограничений капчи</b>

Отправьте ID или @username пользователя для снятия ограничений:

<b>Примеры:</b>
• <code>123456789</code>
• <code>@username</code>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingCaptchaUnban = true;
  }

  @Action('admin_failed_deliveries')
  @Action(/^failed_deliveries_page_(\d+)$/)
  @Action('back_to_failed_deliveries')
  async adminFailedDeliveries(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    let page = 0;
    if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;

      if (data === 'back_to_failed_deliveries') {
        page = ctx.session.failedDeliveriesPage || 0;
      } else {
        const match = data.match(/^failed_deliveries_page_(\d+)$/);
        if (match) {
          page = parseInt(match[1]);
        }
      }

      this.logger.debug(
        `Failed deliveries pagination: data="${data}", page=${page}`,
      );
    } else {
      this.logger.debug('Failed deliveries: first page (no callback data)');
    }

    if (isNaN(page) || page < 0) {
      this.logger.warn(`Invalid page number: ${page}, resetting to 0`);
      page = 0;
    }

    try {
      const fraudList = await this.prisma.fraudList.findMany({
        select: {
          telegram_id: true,
          username: true,
        },
      });

      const fraudTelegramIds = new Set(
        fraudList
          .filter((f) => f.telegram_id)
          .map((f) => f.telegram_id as string),
      );
      const fraudUsernames = new Set(
        fraudList
          .filter((f) => f.username)
          .map((f) => f.username?.toLowerCase() as string),
      );

      const includeStuck = {
        fragment_queue: true,
        user: {
          select: {
            telegram_id: true,
            username: true,
            first_name: true,
          },
        },
      } as const;

      const stuckPayments = await this.prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          stuck_resolved_at: null,
          OR: [
            {
              fragment_queue: {
                some: {
                  status: { in: ['FAILED', 'PROCESSING'] },
                },
              },
            },
            { fragment_queue: { none: {} } },
          ],
        },
        include: includeStuck,
        orderBy: { created_at: 'desc' },
        take: 500,
      });

      const failedDeliveries = stuckPayments.sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime(),
      );

      const allStuckPayments = failedDeliveries.filter((payment) => {
        const userTelegramId = payment.user_telegram_id;
        const username = payment.user?.username?.toLowerCase();

        const isFraud =
          fraudTelegramIds.has(userTelegramId) ||
          (username && fraudUsernames.has(username));

        return !isFraud;
      });

      this.logger.debug(
        `Filtered out ${failedDeliveries.length - allStuckPayments.length} fraud payments from stuck deliveries`,
      );

      if (allStuckPayments.length === 0) {
        try {
          await ctx.editMessageText(
            '✅ <b>Застрявших платежей нет</b>\n\n' +
              'Все платежи обрабатываются нормально.',
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
            },
          );
        } catch {
          await ctx.reply(
            '✅ <b>Застрявших платежей нет</b>\n\n' +
              'Все платежи обрабатываются нормально.',
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
            },
          );
        }
        return;
      }

      const totalAmount = allStuckPayments.reduce(
        (sum, p) => sum + Number(p.amount_rub || 0),
        0,
      );

      const statusCounts = {
        delivery_failed: 0,
        delivery_processing: 0,
        delivery_no_queue: 0,
      };

      allStuckPayments.forEach((p) => {
        const fq = p.fragment_queue?.[0];
        if (!fq) {
          statusCounts.delivery_no_queue++;
        } else if (fq.status === 'FAILED') {
          statusCounts.delivery_failed++;
        } else if (fq.status === 'PROCESSING') {
          statusCounts.delivery_processing++;
        }
      });

      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.ceil(allStuckPayments.length / ITEMS_PER_PAGE);

      this.logger.debug(
        `Failed deliveries: total=${allStuckPayments.length}, page=${page}, totalPages=${totalPages}`,
      );

      ctx.session.fromFailedDeliveries = true;
      ctx.session.fromAdminSearch = false;
      ctx.session.failedDeliveriesPage = page;

      let text = `❗️ <b>Застрявшие платежи</b>\n\n`;
      text += `Оплаченные платежи с проблемами на этапе доставки.\n\n`;
      text += `📊 <b>Всего:</b> ${allStuckPayments.length}\n`;
      text += `💰 <b>Сумма:</b> ${totalAmount.toFixed(2)} ₽\n\n`;

      text += `<b>Статусы доставки:</b>\n`;
      if (statusCounts.delivery_failed > 0) {
        text += `❌ Провалено: ${statusCounts.delivery_failed}\n`;
      }
      if (statusCounts.delivery_processing > 0) {
        text += `⏳ В обработке: ${statusCounts.delivery_processing}\n`;
      }
      if (statusCounts.delivery_no_queue > 0) {
        text += `🚫 Без очереди: ${statusCounts.delivery_no_queue}\n`;
      }

      text += `\n<i>Нажмите на платёж для просмотра деталей:</i>`;

      try {
        await ctx.editMessageText(text, {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getFailedDeliveriesMenu(
            allStuckPayments,
            page,
            totalPages,
          ).reply_markup,
        });
      } catch {
        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getFailedDeliveriesMenu(
            allStuckPayments,
            page,
            totalPages,
          ).reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error fetching failed deliveries: ${error.message}`);
      await ctx.reply('❌ Ошибка при загрузке застрявших платежей');
    }
  }

  @Action('export_stuck_txids')
  async exportStuckTxIds(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    try {
      const stuckPayments = await this.prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          stuck_resolved_at: null,
          OR: [
            {
              fragment_queue: {
                some: { status: 'FAILED' },
                none: { status: 'COMPLETED' },
              },
            },
          ],
        },
        select: {
          id: true,
          order_number: true,
          payment_method: true,
          external_payment_id: true,
          provider_transaction_id: true,
          amount_rub: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
      });

      if (stuckPayments.length === 0) {
        await ctx.reply('✅ Застрявших платежей с проваленной доставкой нет');
        return;
      }

      const lines = stuckPayments.map((p) => {
        const txId =
          p.external_payment_id ||
          p.provider_transaction_id ||
          `#${p.order_number}`;
        const method = p.payment_method;
        const date = new Date(p.created_at).toLocaleDateString('ru-RU', {
          timeZone: 'Europe/Moscow',
        });
        const amount = Number(p.amount_rub || 0).toFixed(2);
        return `${txId}\t${method}\t${amount} ₽\t${date}`;
      });

      const header = `ID транзакции\tПлатёжная система\tСумма\tДата`;
      const content = [header, ...lines].join('\n');
      const buffer = Buffer.from(content, 'utf-8');

      await ctx.replyWithDocument(
        { source: buffer, filename: 'stuck_payments.txt' },
        {
          caption:
            `📋 Застрявшие платежи — ${stuckPayments.length} шт.\n` +
            `✅ Проверено: ни один из них не имеет статуса COMPLETED в очереди доставки`,
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '🗑 Удалить экспортированные',
                'delete_exported_stuck',
              ),
            ],
          ]).reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error exporting stuck txids: ${error.message}`);
      await ctx.reply('❌ Ошибка при формировании файла');
    }
  }

  @Action('delete_exported_stuck')
  async deleteExportedStuck(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    try {
      const updated = await this.prisma.payment.updateMany({
        where: {
          status: 'COMPLETED',
          stuck_resolved_at: null,
          OR: [
            {
              fragment_queue: {
                some: { status: 'FAILED' },
                none: { status: 'COMPLETED' },
              },
            },
          ],
        },
        data: { stuck_resolved_at: new Date() },
      });

      const msg = ctx.callbackQuery?.message;
      if (msg && 'message_id' in msg && ctx.chat?.id) {
        await ctx.telegram.editMessageCaption(
          ctx.chat.id,
          msg.message_id,
          undefined,
          '✅ Застрявшие платежи успешно удалены',
          { reply_markup: { inline_keyboard: [] } },
        );
      }
      await ctx.answerCbQuery(
        updated.count > 0
          ? `Убрано из застрявших: ${updated.count} шт.`
          : 'Нечего убирать',
        { show_alert: false },
      );
    } catch (error: any) {
      this.logger.error(`Error delete_exported_stuck: ${error.message}`);
      await ctx.answerCbQuery('❌ Ошибка при обновлении', {
        show_alert: true,
      });
    }
  }

  @Action('admin_fraud')
  async adminFraud(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
🕵️ <b>Управление мошенниками</b>

При добавлении пользователя в список мошенников:
• Его платеж будет проходить (списание средств)
• Товар НЕ будет отправлен
• Уведомление об успешной оплате будет отправлено

Выберите действие:
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
    });
  }

  @Action('fraud_add')
  async fraudAdd(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
➕ <b>Добавить мошенника</b>

Отправьте ID или @username пользователя для добавления в список мошенников:

<b>Примеры:</b>
• <code>123456789</code>
• <code>@username</code>

ℹ️ После добавления, платежи пользователя будут приниматься, но товар не будет доставлен.
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingFraudUser = true;
  }

  @Action('fraud_unban')
  async fraudUnban(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const message = await ctx.reply(
      `➖ <b>Убрать из мошенников</b>\n\nОтправьте ID или @username пользователя:\n\n<b>Примеры:</b>\n• <code>123456789</code>\n• <code>@username</code>\n\nℹ️ Пользователь будет удалён из списка мошенников и добавлен в белый список (система не будет заносить его повторно).`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
      },
    );
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingFraudUnban = true;
  }

  @Action('fraud_list')
  async fraudList(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    await this.showFraudList(ctx, 0);
  }

  @Action(/^fraud_page_(\d+)$/)
  async fraudPage(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    const match = ctx.match;
    if (!match) return;
    const page = parseInt(match[1]);
    await this.showFraudList(ctx, page);
  }

  @Action('fraud_page_info')
  async fraudPageInfo(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await ctx.answerCbQuery('Информация о странице');
  }

  @Action('fraud_export')
  async fraudExport(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    try {
      const fraudsters = await this.fraudService.getFraudList();

      if (fraudsters.length === 0) {
        await ctx.answerCbQuery('Список мошенников пуст', { show_alert: true });
        return;
      }

      const lines = fraudsters.map((f) => f.telegram_id || f.username || '');
      const content = lines.filter(Boolean).join('\n');
      const buffer = Buffer.from(content, 'utf-8');

      await ctx.replyWithDocument(
        { source: buffer, filename: 'fraud_list.txt' },
        { caption: `📋 Список мошенников — ${fraudsters.length} записей` },
      );
    } catch (error: any) {
      this.logger.error(`Error exporting fraud list: ${error.message}`);
      await ctx.reply('❌ Ошибка при формировании файла');
    }
  }

  @Action(/^fraud_remove_(.+)$/)
  async fraudRemove(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    const match = ctx.match;
    if (!match) return;
    const fraudId = match[1];
    await this.handleRemoveFraud(ctx, fraudId);
  }

  @Action('payment_systems')
  async paymentSystems(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const [
      plategaFeeRecord,
      heleketFeeRecord,
      tonFeeRecord,
      sbp2FeeRecord,
      aurapayFeeRecord,
    ] = await Promise.all([
      this.prisma.paymentFee.findUnique({
        where: { payment_system: 'PLATEGA' },
      }),
      this.prisma.paymentFee.findUnique({
        where: { payment_system: 'HELEKET' },
      }),
      this.prisma.paymentFee.findUnique({
        where: { payment_system: 'TON' },
      }),
      this.prisma.paymentFee.findUnique({
        where: { payment_system: 'SBP2' },
      }),
      this.prisma.paymentFee.findUnique({
        where: { payment_system: 'AURAPAY_SBP' },
      }),
    ]);

    const plategaFee = plategaFeeRecord
      ? Number(plategaFeeRecord.fee_percent)
      : 0;
    const heleketFee = heleketFeeRecord
      ? Number(heleketFeeRecord.fee_percent)
      : 0;
    const tonFee = tonFeeRecord ? Number(tonFeeRecord.fee_percent) : 0;
    const sbp2Fee = sbp2FeeRecord ? Number(sbp2FeeRecord.fee_percent) : 0;
    const aurapayFee = aurapayFeeRecord
      ? Number(aurapayFeeRecord.fee_percent)
      : 0;

    const text = `
💳 <b>Платежные системы</b>

Текущие комиссии:
• Platega: ${plategaFee.toFixed(1)}%
• Heleket: ${heleketFee.toFixed(1)}%
• TON: ${tonFee.toFixed(1)}%
• СБП 2: ${sbp2Fee.toFixed(1)}%
• СБП 3 / Карта (Aurapay): ${aurapayFee.toFixed(1)}%

Выберите систему для изменения:
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getPaymentSystemsMenu(
        plategaFee,
        heleketFee,
        tonFee,
        sbp2Fee,
        aurapayFee,
      ).reply_markup,
    });
  }

  @Action('fee_platega')
  async feePlatega(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await this.handleFeeSelection(ctx, 'PLATEGA', 'Platega');
  }

  @Action('fee_heleket')
  async feeHeleket(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await this.handleFeeSelection(ctx, 'HELEKET', 'Heleket');
  }

  @Action('fee_ton')
  async feeTon(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await this.handleFeeSelection(ctx, 'TON', 'TON');
  }

  @Action('fee_sbp2')
  async feeSbp2(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await this.handleFeeSelection(ctx, 'SBP2', 'СБП 2');
  }

  @Action('fee_aurapay')
  async feeAurapay(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    await this.handleFeeSelection(
      ctx,
      'AURAPAY_SBP',
      'СБП 3 / Карта (Aurapay)',
    );
  }

  private async handleFeeSelection(
    ctx: BotContext,
    system: string,
    systemName: string,
  ): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const feeRecord = await this.prisma.paymentFee.findUnique({
      where: { payment_system: system },
    });
    const currentFee = feeRecord ? Number(feeRecord.fee_percent) : 0;

    const text = `
💳 <b>${systemName}</b>

Текущая комиссия: ${currentFee.toFixed(1)}%

📝 Введите новое значение комиссии (например: 5.5):
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToPaymentSystems().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingPaymentFee = true;
    ctx.session.paymentFeeSystem = system;
  }

  @Action('service_markup')
  async serviceMarkup(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const [
      plategaMarkupRecord,
      heleketMarkupRecord,
      tonMarkupRecord,
      sbp2MarkupRecord,
      aurapayMarkupRecord,
    ] = await Promise.all([
      this.prisma.serviceMarkup.findUnique({
        where: { payment_system: 'PLATEGA' },
      }),
      this.prisma.serviceMarkup.findUnique({
        where: { payment_system: 'HELEKET' },
      }),
      this.prisma.serviceMarkup.findUnique({
        where: { payment_system: 'TON' },
      }),
      this.prisma.serviceMarkup.findUnique({
        where: { payment_system: 'SBP2' },
      }),
      this.prisma.serviceMarkup.findUnique({
        where: { payment_system: 'AURAPAY_SBP' },
      }),
    ]);

    const plategaMarkup = plategaMarkupRecord
      ? Number(plategaMarkupRecord.markup_percent)
      : 0;
    const heleketMarkup = heleketMarkupRecord
      ? Number(heleketMarkupRecord.markup_percent)
      : 0;
    const tonMarkup = tonMarkupRecord
      ? Number(tonMarkupRecord.markup_percent)
      : 0;
    const sbp2Markup = sbp2MarkupRecord
      ? Number(sbp2MarkupRecord.markup_percent)
      : 0;
    const aurapayMarkup = aurapayMarkupRecord
      ? Number(aurapayMarkupRecord.markup_percent)
      : 0;

    const text = `
💰 <b>Наша наценка</b>

Текущая наценка сервиса (чистая прибыль):
• Platega: ${plategaMarkup.toFixed(1)}%
• Heleket: ${heleketMarkup.toFixed(1)}%
• TON: ${tonMarkup.toFixed(1)}%
• СБП 2: ${sbp2Markup.toFixed(1)}%
• СБП 3 / Карта (Aurapay): ${aurapayMarkup.toFixed(1)}%

Выберите систему для изменения наценки:
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getServiceMarkupMenu(
        plategaMarkup,
        heleketMarkup,
        tonMarkup,
        sbp2Markup,
        aurapayMarkup,
      ).reply_markup,
    });
  }

  @Action(/^markup_(platega|heleket|ton|sbp2|aurapay)$/)
  async selectMarkupSystem(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    const match = ctx.match;
    if (!match) return;

    const system =
      match[1].toUpperCase() === 'AURAPAY'
        ? 'AURAPAY_SBP'
        : match[1].toUpperCase();
    const systemName = this.paymentSystemAdminLabel(system);

    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const markupRecord = await this.prisma.serviceMarkup.findUnique({
      where: { payment_system: system },
    });
    const currentMarkup = markupRecord
      ? Number(markupRecord.markup_percent)
      : 0;

    const text = `
💰 <b>Изменение наценки для ${systemName}</b>

Текущая наценка: ${currentMarkup.toFixed(1)}%

📝 Введите новое значение наценки сервиса в % (например: 5.5):
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToServiceMarkup().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingServiceMarkup = true;
    ctx.session.serviceMarkupSystem = system;
  }

  @Action('payment_methods_toggle')
  async paymentMethodsToggle(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const methods = await this.settingsService.getAllPaymentMethodStatuses();

    const text = `
🔀 <b>Методы оплаты</b>

Текущий порядок и статус:
${methods
  .map((m) => {
    const names: Record<string, string> = {
      PLATEGA: 'СБП (Platega)',
      HELEKET: 'Криптовалюта',
      TON: 'TON',
      SBP2: 'СБП 2',
    };
    return `${m.enabled ? '🟢' : '🔴'} ${names[m.method] || m.method}`;
  })
  .join('\n')}

Нажмите на метод чтобы включить/выключить.
Используйте стрелки для изменения порядка.
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup:
        AdminKeyboard.getPaymentMethodsToggleMenu(methods).reply_markup,
    });
  }

  @Action(/^toggle_pm_(.+)$/)
  async togglePaymentMethod(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    const match = ctx.match;
    if (!match) return;

    const method = match[1].toUpperCase();
    const currentEnabled =
      await this.settingsService.isPaymentMethodEnabled(method);
    await this.settingsService.setPaymentMethodEnabled(method, !currentEnabled);

    const METHOD_NAMES: Record<string, string> = {
      PLATEGA: 'СБП (Platega)',
      HELEKET: 'Криптовалюта',
      TON: 'TON',
      SBP2: 'СБП 2',
    };
    const name = METHOD_NAMES[method] || method;

    await ctx.answerCbQuery(
      `${!currentEnabled ? '🟢' : '🔴'} ${name} ${!currentEnabled ? 'включен' : 'выключен'}`,
    );

    const methods = await this.settingsService.getAllPaymentMethodStatuses();

    const text = `
🔀 <b>Методы оплаты</b>

Текущий порядок и статус:
${methods
  .map((m) => {
    const names: Record<string, string> = {
      PLATEGA: 'СБП (Platega)',
      HELEKET: 'Криптовалюта',
      TON: 'TON',
      SBP2: 'СБП 2',
    };
    return `${m.enabled ? '🟢' : '🔴'} ${names[m.method] || m.method}`;
  })
  .join('\n')}

Нажмите на метод чтобы включить/выключить.
Используйте стрелки для изменения порядка.
`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getPaymentMethodsToggleMenu(methods).reply_markup,
      });
    } catch {}
  }

  @Action(/^pm_up_(.+)$/)
  async movePaymentMethodUp(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    const match = ctx.match;
    if (!match) return;

    await this.settingsService.movePaymentMethodUp(match[1]);
    await ctx.answerCbQuery('⬆️ Перемещено');

    const methods = await this.settingsService.getAllPaymentMethodStatuses();

    const text = `
🔀 <b>Методы оплаты</b>

Текущий порядок и статус:
${methods
  .map((m) => {
    const names: Record<string, string> = {
      PLATEGA: 'СБП (Platega)',
      HELEKET: 'Криптовалюта',
      TON: 'TON',
      SBP2: 'СБП 2',
    };
    return `${m.enabled ? '🟢' : '🔴'} ${names[m.method] || m.method}`;
  })
  .join('\n')}

Нажмите на метод чтобы включить/выключить.
Используйте стрелки для изменения порядка.
`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getPaymentMethodsToggleMenu(methods).reply_markup,
      });
    } catch {}
  }

  @Action(/^pm_down_(.+)$/)
  async movePaymentMethodDown(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    const match = ctx.match;
    if (!match) return;

    await this.settingsService.movePaymentMethodDown(match[1]);
    await ctx.answerCbQuery('⬇️ Перемещено');

    const methods = await this.settingsService.getAllPaymentMethodStatuses();

    const text = `
🔀 <b>Методы оплаты</b>

Текущий порядок и статус:
${methods
  .map((m) => {
    const names: Record<string, string> = {
      PLATEGA: 'СБП (Platega)',
      HELEKET: 'Криптовалюта',
      TON: 'TON',
      SBP2: 'СБП 2',
    };
    return `${m.enabled ? '🟢' : '🔴'} ${names[m.method] || m.method}`;
  })
  .join('\n')}

Нажмите на метод чтобы включить/выключить.
Используйте стрелки для изменения порядка.
`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getPaymentMethodsToggleMenu(methods).reply_markup,
      });
    } catch {}
  }

  private async buildFailoverText(): Promise<string> {
    const plategaHealth = this.paymentHealthService.getHealthStatus('PLATEGA');
    const sbp2Health = this.paymentHealthService.getHealthStatus('SBP2');
    const aurapayHealth =
      this.paymentHealthService.getHealthStatus('AURAPAY_SBP');
    const failoverEnabled = await this.paymentHealthService.isFailoverEnabled();
    const autoRecovery =
      await this.paymentHealthService.isAutoRecoveryEnabled();
    const threshold = await this.paymentHealthService.getFailoverThreshold();
    const cooldown =
      await this.paymentHealthService.getFailoverCooldownMinutes();

    const fmt = (health: any, threshold: number) =>
      health.failoverActive
        ? `❌ Недоступен (${health.consecutiveFailures} ошибок)`
        : health.consecutiveFailures > 0
          ? `⚠️ ${health.consecutiveFailures}/${threshold} ошибок`
          : '✅ Работает';

    const plategaStatus = fmt(plategaHealth, threshold);

    const aurapayStatus = plategaHealth.failoverActive
      ? '✅ Активен (failover от Platega)'
      : fmt(aurapayHealth, threshold);

    const anyRecovery =
      plategaHealth.recoveryInProgress || aurapayHealth.recoveryInProgress;
    const recoveryStatus = anyRecovery
      ? '\n🔄 Восстановление в процессе...'
      : '';

    const lastSwitch = plategaHealth.failoverTriggeredAt
      ? plategaHealth.failoverTriggeredAt.toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow',
        })
      : aurapayHealth.failoverTriggeredAt
        ? aurapayHealth.failoverTriggeredAt.toLocaleString('ru-RU', {
            timeZone: 'Europe/Moscow',
          })
        : 'никогда';

    return (
      `🔄 <b>АВТОПЕРЕКЛЮЧЕНИЕ СБП</b>\n\n` +
      `📊 <b>Цепочка:</b> PLATEGA → СБП 3 → PLATEGA\n\n` +
      `📊 <b>Статус:</b>\n` +
      `├ PLATEGA: ${plategaStatus}\n` +
      `├ СБП 3 (Aurapay): ${aurapayStatus}\n` +
      `└ Последнее переключение: ${lastSwitch}${recoveryStatus}\n\n` +
      `⚙️ <b>Настройки:</b>\n` +
      `├ Авто-переключение: ${failoverEnabled ? '✅ Вкл' : '❌ Выкл'}\n` +
      `├ Порог ошибок: ${threshold}\n` +
      `├ Откат через: ${cooldown} мин\n` +
      `└ Авто-восстановление: ${autoRecovery ? '✅ Вкл' : '❌ Выкл'}`
    );
  }

  private async getFailoverConfig() {
    const plategaHealth = this.paymentHealthService.getHealthStatus('PLATEGA');
    return {
      failoverEnabled: await this.paymentHealthService.isFailoverEnabled(),
      autoRecovery: await this.paymentHealthService.isAutoRecoveryEnabled(),
      threshold: await this.paymentHealthService.getFailoverThreshold(),
      cooldownMinutes:
        await this.paymentHealthService.getFailoverCooldownMinutes(),
      failoverActive: plategaHealth.failoverActive,
    };
  }

  @Action('failover_settings')
  async failoverSettings(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = await this.buildFailoverText();
    const config = await this.getFailoverConfig();

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
    });
  }

  @Action('failover_toggle')
  async failoverToggle(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const current = await this.paymentHealthService.isFailoverEnabled();
    await this.paymentHealthService.setFailoverEnabled(!current);

    await ctx.answerCbQuery(
      `Авто-переключение ${!current ? 'включено' : 'выключено'}`,
    );

    const text = await this.buildFailoverText();
    const config = await this.getFailoverConfig();

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
      });
    } catch {}
  }

  @Action('failover_toggle_recovery')
  async failoverToggleRecovery(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const current = await this.paymentHealthService.isAutoRecoveryEnabled();
    await this.paymentHealthService.setAutoRecoveryEnabled(!current);

    await ctx.answerCbQuery(
      `Авто-восстановление ${!current ? 'включено' : 'выключено'}`,
    );

    const text = await this.buildFailoverText();
    const config = await this.getFailoverConfig();

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
      });
    } catch {}
  }

  @Action('failover_set_threshold')
  async failoverSetThreshold(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const current = await this.paymentHealthService.getFailoverThreshold();
    const message = await ctx.reply(
      `⚠️ <b>Порог ошибок для failover</b>\n\n` +
        `Текущее значение: ${current}\n\n` +
        `Введите количество последовательных ошибок, после которых произойдёт автопереключение (1-20):`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToFailover().reply_markup,
      },
    );
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingFailoverThreshold = true;
  }

  @Action('failover_set_cooldown')
  async failoverSetCooldown(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const current =
      await this.paymentHealthService.getFailoverCooldownMinutes();
    const message = await ctx.reply(
      `⏱ <b>Время до попытки восстановления</b>\n\n` +
        `Текущее значение: ${current} мин\n\n` +
        `Введите время в минутах, через которое бот попробует вернуть основной метод (1-60):`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToFailover().reply_markup,
      },
    );
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingFailoverCooldown = true;
  }

  @Action('failover_manual_switch')
  async failoverManualSwitch(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const success = await this.paymentHealthService.manualFailover('PLATEGA');

    if (success) {
      await ctx.answerCbQuery('⚡ Переключено на СБП 2');
    } else {
      await ctx.answerCbQuery('Failover уже активен');
    }

    const text = await this.buildFailoverText();
    const config = await this.getFailoverConfig();

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
      });
    } catch {}
  }

  @Action('failover_manual_recovery')
  async failoverManualRecovery(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const success = await this.paymentHealthService.manualRecovery('PLATEGA');

    if (success) {
      await ctx.answerCbQuery('🟢 PLATEGA восстановлен');
    } else {
      await ctx.answerCbQuery('Failover не активен');
    }

    const text = await this.buildFailoverText();
    const config = await this.getFailoverConfig();

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
      });
    } catch {}
  }

  @Action('rate_protection')
  async rateProtection(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const minTonRate = await this.settingsService.getMinTonRateUsd();
    const minUsdtRate = await this.settingsService.getMinUsdtRateRub();
    const currentTonRate = await this.rapiraService.getTonToUsdRate();
    const currentUsdtRate = await this.rapiraService.getUsdtToRubRate();

    const text = `
🛡 <b>Защита курса</b>

Установите минимальные курсы, ниже которых покупка будет невозможна.

<b>Текущие настройки:</b>
• Минимальный курс TON: ${minTonRate > 0 ? minTonRate.toFixed(4) + ' USD' : '❌ Отключено'}
• Минимальный курс USDT: ${minUsdtRate > 0 ? minUsdtRate.toFixed(2) + ' RUB' : '❌ Отключено'}

<b>Текущие курсы:</b>
• TON: ${currentTonRate.toFixed(4)} USD
• USDT: ${currentUsdtRate.toFixed(2)} RUB

<i>💡 Установите минимальный курс на 0, чтобы отключить защиту</i>
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getRateProtectionMenu(
        minTonRate,
        minUsdtRate,
        currentTonRate,
        currentUsdtRate,
      ).reply_markup,
    });
  }

  @Action('set_min_ton_rate')
  async setMinTonRate(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const currentRate = await this.rapiraService.getTonToUsdRate();
    const currentMin = await this.settingsService.getMinTonRateUsd();

    const text = `
💎 <b>Минимальный курс TON</b>

Текущий курс: ${currentRate.toFixed(4)} USD
Текущий минимум: ${currentMin > 0 ? currentMin.toFixed(4) + ' USD' : 'Отключено'}

📝 Введите новое минимальное значение курса TON в USD (например: 5.5):

<i>Введите 0, чтобы отключить защиту курса TON</i>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingMinTonRate = true;
  }

  @Action('set_min_usdt_rate')
  async setMinUsdtRate(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const currentRate = await this.rapiraService.getUsdtToRubRate();
    const currentMin = await this.settingsService.getMinUsdtRateRub();

    const text = `
💵 <b>Минимальный курс USDT</b>

Текущий курс: ${currentRate.toFixed(2)} RUB
Текущий минимум: ${currentMin > 0 ? currentMin.toFixed(2) + ' RUB' : 'Отключено'}

📝 Введите новое минимальное значение курса USDT в RUB (например: 95.5):

<i>Введите 0, чтобы отключить защиту курса USDT</i>
`;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingMinUsdtRate = true;
  }

  @Action('purchase_limits')
  async purchaseLimits(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const limits = await this.settingsService.getPurchaseLimits();

    const text = `
📏 <b>Лимиты покупки</b>

<b>Звёзды ⭐ (ввод):</b>
• Минимум: ${limits.minStars}
• Максимум: ${limits.maxStars.toLocaleString('ru')}

<b>TON 💎:</b>
• Минимум: ${limits.minTon}
• Максимум: ${limits.maxTon.toLocaleString('ru')}

<b>Рублёвые платёжки (СБП/Карта):</b>
• Макс. сумма: ${limits.sbpLimitRub.toLocaleString('ru')} ₽
• Макс. звёзд за 1 платёж: ${limits.sbpLimitStars.toLocaleString('ru')} ⭐

<i>Нажмите на нужный параметр чтобы изменить</i>
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getPurchaseLimitsMenu(limits).reply_markup,
    });
  }

  @Action(
    /^set_(min_stars|max_stars|min_ton|max_ton|sbp_limit|sbp_limit_stars)$/,
  )
  async setPurchaseLimitField(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const action = (ctx.match as RegExpExecArray)[1] as string;
    const fieldMap: Record<
      string,
      {
        field:
          | 'minStars'
          | 'maxStars'
          | 'minTon'
          | 'maxTon'
          | 'sbpLimitRub'
          | 'sbpLimitStars';
        label: string;
        example: string;
      }
    > = {
      min_stars: {
        field: 'minStars',
        label: 'минимальное кол-во звёзд ⭐',
        example: '50',
      },
      max_stars: {
        field: 'maxStars',
        label: 'максимальное кол-во звёзд ⭐ (ввод)',
        example: '100000',
      },
      min_ton: {
        field: 'minTon',
        label: 'минимальное кол-во TON 💎',
        example: '1',
      },
      max_ton: {
        field: 'maxTon',
        label: 'максимальное кол-во TON 💎',
        example: '10000',
      },
      sbp_limit: {
        field: 'sbpLimitRub',
        label: 'макс. сумму для СБП/Карты (₽)',
        example: '300000',
      },
      sbp_limit_stars: {
        field: 'sbpLimitStars',
        label: 'макс. звёзд за 1 платёж СБП/Карта ⭐',
        example: '20000',
      },
    };

    const { field, label, example } = fieldMap[action];
    const limits = await this.settingsService.getPurchaseLimits();
    const current = limits[field];

    const message = await ctx.reply(
      `📝 Введите ${label}.\n\nТекущее значение: <b>${current.toLocaleString('ru')}</b>\nПример: ${example}`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      },
    );
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingPurchaseLimit = true;
    ctx.session.pendingPurchaseLimitField = field;
  }

  @Action('fraud_settings')
  async fraudSettings(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const [
      phoneFraudEnabled,
      phoneFraudMinAmount,
      cardFraudEnabled,
      cardFraudMinAmount,
      cancellationFraudEnabled,
      cancellationFraudMinAmount,
    ] = await Promise.all([
      this.settingsService.isPhoneFraudEnabled(),
      this.settingsService.getPhoneFraudMinAmount(),
      this.settingsService.isCardFraudEnabled(),
      this.settingsService.getCardFraudMinAmount(),
      this.settingsService.isCancellationFraudEnabled(),
      this.settingsService.getCancellationFraudMinAmount(),
    ]);

    const text = `
⚙️ <b>Настройки автоловли мошенников</b>

<b>🔍 Разные номера телефонов (СБП):</b>
• Статус: ${phoneFraudEnabled ? '🟢 Включено' : '🔴 Выключено'}
• Мин. сумма: <b>${phoneFraudMinAmount} ₽</b>
• Срабатывает когда у пользователя 2+ разных номера при оплате СБП

<b>💳 Разные карты:</b>
• Статус: ${cardFraudEnabled ? '🟢 Включено' : '🔴 Выключено'}
• Мин. сумма: <b>${cardFraudMinAmount} ₽</b>
• Срабатывает когда у пользователя 2+ разных карт при оплате картой

<b>❌ Подряд отменённые заказы:</b>
• Статус: ${cancellationFraudEnabled ? '🟢 Включено' : '🔴 Выключено'}
• Мин. сумма: <b>${cancellationFraudMinAmount} ₽</b>
• Срабатывает при 3 отменах подряд от указанной суммы
`;

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getFraudSettingsMenu({
        phoneFraudEnabled,
        phoneFraudMinAmount,
        cardFraudEnabled,
        cardFraudMinAmount,
        cancellationFraudEnabled,
        cancellationFraudMinAmount,
      }).reply_markup,
    });
  }

  @Action('toggle_phone_fraud')
  async togglePhoneFraud(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const current = await this.settingsService.isPhoneFraudEnabled();
    await this.settingsService.setPhoneFraudEnabled(!current);

    const [
      phoneFraudEnabled,
      phoneFraudMinAmount,
      cardFraudEnabled,
      cardFraudMinAmount,
      cancellationFraudEnabled,
      cancellationFraudMinAmount,
    ] = await Promise.all([
      this.settingsService.isPhoneFraudEnabled(),
      this.settingsService.getPhoneFraudMinAmount(),
      this.settingsService.isCardFraudEnabled(),
      this.settingsService.getCardFraudMinAmount(),
      this.settingsService.isCancellationFraudEnabled(),
      this.settingsService.getCancellationFraudMinAmount(),
    ]);

    try {
      await ctx.editMessageReplyMarkup(
        AdminKeyboard.getFraudSettingsMenu({
          phoneFraudEnabled,
          phoneFraudMinAmount,
          cardFraudEnabled,
          cardFraudMinAmount,
          cancellationFraudEnabled,
          cancellationFraudMinAmount,
        }).reply_markup as any,
      );
    } catch {}
  }

  @Action('toggle_card_fraud')
  async toggleCardFraud(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const current = await this.settingsService.isCardFraudEnabled();
    await this.settingsService.setCardFraudEnabled(!current);

    const [
      phoneFraudEnabled,
      phoneFraudMinAmount,
      cardFraudEnabled,
      cardFraudMinAmount,
      cancellationFraudEnabled,
      cancellationFraudMinAmount,
    ] = await Promise.all([
      this.settingsService.isPhoneFraudEnabled(),
      this.settingsService.getPhoneFraudMinAmount(),
      this.settingsService.isCardFraudEnabled(),
      this.settingsService.getCardFraudMinAmount(),
      this.settingsService.isCancellationFraudEnabled(),
      this.settingsService.getCancellationFraudMinAmount(),
    ]);

    try {
      await ctx.editMessageReplyMarkup(
        AdminKeyboard.getFraudSettingsMenu({
          phoneFraudEnabled,
          phoneFraudMinAmount,
          cardFraudEnabled,
          cardFraudMinAmount,
          cancellationFraudEnabled,
          cancellationFraudMinAmount,
        }).reply_markup as any,
      );
    } catch {}
  }

  @Action('toggle_cancellation_fraud')
  async toggleCancellationFraud(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const current = await this.settingsService.isCancellationFraudEnabled();
    await this.settingsService.setCancellationFraudEnabled(!current);

    const [
      phoneFraudEnabled,
      phoneFraudMinAmount,
      cardFraudEnabled,
      cardFraudMinAmount,
      cancellationFraudEnabled,
      cancellationFraudMinAmount,
    ] = await Promise.all([
      this.settingsService.isPhoneFraudEnabled(),
      this.settingsService.getPhoneFraudMinAmount(),
      this.settingsService.isCardFraudEnabled(),
      this.settingsService.getCardFraudMinAmount(),
      this.settingsService.isCancellationFraudEnabled(),
      this.settingsService.getCancellationFraudMinAmount(),
    ]);

    try {
      await ctx.editMessageReplyMarkup(
        AdminKeyboard.getFraudSettingsMenu({
          phoneFraudEnabled,
          phoneFraudMinAmount,
          cardFraudEnabled,
          cardFraudMinAmount,
          cancellationFraudEnabled,
          cancellationFraudMinAmount,
        }).reply_markup as any,
      );
    } catch {}
  }

  @Action(
    /^set_(phone_fraud_amount|card_fraud_amount|cancellation_fraud_amount)$/,
  )
  async setFraudAmount(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const action = (ctx.match as RegExpExecArray)[1] as string;

    const fieldMap = {
      phone_fraud_amount: {
        field: 'phoneFraudMinAmount' as const,
        label: 'минимальную сумму для поимки по разным номерам',
        example: '300',
        getCurrent: () => this.settingsService.getPhoneFraudMinAmount(),
      },
      card_fraud_amount: {
        field: 'cardFraudMinAmount' as const,
        label: 'минимальную сумму для поимки по разным картам',
        example: '300',
        getCurrent: () => this.settingsService.getCardFraudMinAmount(),
      },
      cancellation_fraud_amount: {
        field: 'cancellationFraudMinAmount' as const,
        label: 'минимальную сумму для поимки по отменам',
        example: '300',
        getCurrent: () => this.settingsService.getCancellationFraudMinAmount(),
      },
    };

    const config = fieldMap[action];
    if (!config) return;
    const { label, example, getCurrent } = config;
    const current = await getCurrent();

    const message = await ctx.reply(
      `📝 Введите ${label} в рублях.\n\nТекущее значение: <b>${current} ₽</b>\nПример: ${example}`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      },
    );
    ctx.session.lastBotMessageId = message.message_id;
    ctx.session.awaitingFraudAmount = true;
    ctx.session.pendingFraudAmountField = config.field;
  }
  @Action('toggle_bot')
  async toggleBot(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    try {
      const message = (ctx.callbackQuery as any)?.message;
      if (message && message.text && message.text.includes('Статус бота:')) {
        await this.adminHandlers.toggleBot(ctx);
      } else {
        await this.adminHandlers.showSettingsMenu(ctx);
      }
    } catch (error) {
      await this.adminHandlers.showSettingsMenu(ctx);
    }
  }

  @Action('toggle_payment_captcha')
  async togglePaymentCaptcha(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    try {
      await this.adminHandlers.togglePaymentCaptcha(ctx);
    } catch (error) {
      await this.adminHandlers.showSettingsMenu(ctx);
    }
  }

  @Action('sales_channels')
  async salesChannels(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.session.awaitingSalesNotificationMinRub = false;
    ctx.session.awaitingSalesChannel = false;
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getSalesChannels();
    const minRub =
      await this.settingsService.getSalesNotificationMinAmountRub();

    let text = '<b>📊 Каналы для уведомлений о продажах</b>\n\n';

    text += `<b>Порог:</b> ${
      minRub === 0
        ? 'уведомлять о <b>любой</b> сумме'
        : `только если сумма заказа в ₽ <b>≥ ${minRub.toLocaleString('ru')}</b>`
    }\n<i>(сумма в рублях из заказа; для крипто/TON используется пересчёт в ₽ в заказе)</i>\n\n`;

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
    });
  }

  @Action('sales_notification_min_rub')
  async salesNotificationMinRub(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const current =
      await this.settingsService.getSalesNotificationMinAmountRub();

    ctx.session.awaitingSalesChannel = false;
    ctx.session.awaitingInsufficientFundsChannel = false;
    ctx.session.awaitingFraudChannel = false;
    ctx.session.awaitingSalesNotificationMinRub = true;

    const text = `
<b>💰 Порог суммы для уведомлений о продажах</b>

<b>Сейчас:</b> ${
      current === 0
        ? 'без порога (все покупки)'
        : `${current.toLocaleString('ru')} ₽ и выше`
    }

<b>Отправьте целое число — минимальная сумма заказа в ₽</b> (поле суммы в рублях в заказе).

<b>0</b> — уведомлять о любой покупке.

<b>Примеры:</b> <code>2500</code>, <code>5000</code>
    `;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'sales_channels')],
      ]).reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
  }

  @Action('sales_channel_add')
  async salesChannelAdd(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
<b>➕ Добавление канала для уведомлений</b>

<b>📝 Отправьте ID канала в формате:</b>
<b><code>-100xxxxxxxxxx</code></b>

<b>💡 Как получить ID канала:</b>
<b>1. Добавьте бота в канал как администратора</b>
<b>2. Перешлите любое сообщение из канала боту @userinfobot</b>
<b>3. Скопируйте ID канала и отправьте мне</b>

<b>⚠️ Важно: Бот должен иметь права администратора в канале!</b>
    `;

    ctx.session.awaitingInsufficientFundsChannel = false;
    ctx.session.awaitingSalesNotificationMinRub = false;
    ctx.session.awaitingSalesChannel = true;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'sales_channels')],
      ]).reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
  }

  @Action('sales_channel_remove')
  async salesChannelRemove(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getSalesChannels();

    if (channels.length === 0) {
      await ctx.answerCbQuery('📭 Нет добавленных каналов', {
        show_alert: true,
      });
      return;
    }

    const text =
      '<b>🗑 Удаление канала</b>\n\n<b>Выберите канал для удаления:</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup:
        AdminKeyboard.getSalesChannelDeleteMenu(channels).reply_markup,
    });
  }

  @Action('insufficient_funds_channels')
  async insufficientFundsChannels(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getInsufficientFundsChannels();

    let text = '<b>⚠️ Каналы для уведомлений о недостатке средств</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup:
        AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
    });
  }

  @Action('insufficient_funds_channel_add')
  async insufficientFundsChannelAdd(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
<b>➕ Добавление канала для уведомлений о недостатке средств</b>

<b>📝 Отправьте ID канала в формате:</b>
<b><code>-100xxxxxxxxxx</code></b>

<b>💡 Как получить ID канала:</b>
<b>1. Добавьте бота в канал как администратора</b>
<b>2. Перешлите любое сообщение из канала боту @userinfobot</b>
<b>3. Скопируйте ID канала и отправьте мне</b>

<b>⚠️ Важно: Бот должен иметь права администратора в канале!</b>
    `;

    ctx.session.awaitingSalesChannel = false;
    ctx.session.awaitingSalesNotificationMinRub = false;
    ctx.session.awaitingInsufficientFundsChannel = true;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'insufficient_funds_channels')],
      ]).reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
  }

  @Action('insufficient_funds_channel_remove')
  async insufficientFundsChannelRemove(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getInsufficientFundsChannels();

    if (channels.length === 0) {
      await ctx.answerCbQuery('📭 Нет добавленных каналов', {
        show_alert: true,
      });
      return;
    }

    const text =
      '<b>🗑 Удаление канала</b>\n\n<b>Выберите канал для удаления:</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup:
        AdminKeyboard.getInsufficientFundsChannelDeleteMenu(channels)
          .reply_markup,
    });
  }

  @Action(/^delete_insufficient_funds_channel:(.+)$/)
  async deleteInsufficientFundsChannel(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const channelId = match[1];

    try {
      await this.settingsService.removeInsufficientFundsChannel(channelId);
      await ctx.answerCbQuery('✅ Канал удалён', { show_alert: true });
    } catch (error: any) {
      this.logger.error(
        `Error removing insufficient funds channel: ${error.message}`,
      );
      await ctx.answerCbQuery('❌ Ошибка при удалении', { show_alert: true });
    }

    const channels = await this.settingsService.getInsufficientFundsChannels();

    let text = '<b>⚠️ Каналы для уведомлений о недостатке средств</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
      });
    } catch (error: any) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
      });
    }
  }

  @Action('fraud_channels')
  async fraudChannels(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getFraudChannels();

    let text = '<b>🚨 Каналы для уведомлений о мошенниках</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
    });
  }

  @Action('fraud_channel_add')
  async fraudChannelAdd(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const text = `
<b>➕ Добавление канала для уведомлений о мошенниках</b>

<b>📝 Отправьте ID канала в формате:</b>
<b><code>-100xxxxxxxxxx</code></b>

<b>💡 Как получить ID канала:</b>
<b>1. Добавьте бота в канал как администратора</b>
<b>2. Перешлите любое сообщение из канала боту @userinfobot</b>
<b>3. Скопируйте ID канала и отправьте мне</b>

<b>⚠️ Важно: Бот должен иметь права администратора в канале!</b>
    `;

    ctx.session.awaitingSalesChannel = false;
    ctx.session.awaitingSalesNotificationMinRub = false;
    ctx.session.awaitingInsufficientFundsChannel = false;
    ctx.session.awaitingFraudChannel = true;

    const message = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❌ Отмена', 'fraud_channels')],
      ]).reply_markup,
    });
    ctx.session.lastBotMessageId = message.message_id;
  }

  @Action('fraud_channel_remove')
  async fraudChannelRemove(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    try {
      await ctx.deleteMessage();
    } catch {}

    const channels = await this.settingsService.getFraudChannels();

    if (channels.length === 0) {
      await ctx.answerCbQuery('📭 Нет добавленных каналов', {
        show_alert: true,
      });
      return;
    }

    const text =
      '<b>🗑 Удаление канала</b>\n\n<b>Выберите канал для удаления:</b>';

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup:
        AdminKeyboard.getFraudChannelDeleteMenu(channels).reply_markup,
    });
  }

  @Action(/^delete_fraud_channel:(.+)$/)
  async deleteFraudChannel(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const channelId = match[1];

    try {
      await this.settingsService.removeFraudChannel(channelId);
      await ctx.answerCbQuery('✅ Канал удалён', { show_alert: true });
    } catch (error: any) {
      this.logger.error(`Error removing fraud channel: ${error.message}`);
      await ctx.answerCbQuery('❌ Ошибка при удалении', { show_alert: true });
    }

    const channels = await this.settingsService.getFraudChannels();

    let text = '<b>🚨 Каналы для уведомлений о мошенниках</b>\n\n';

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
      });
    } catch {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
      });
    }
  }

  @Action(/^delete_sales_channel:(.+)$/)
  async deleteSalesChannel(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const channelId = match[1];

    try {
      await this.settingsService.removeSalesChannel(channelId);
      await ctx.answerCbQuery('✅ Канал удалён', { show_alert: true });
    } catch (error: any) {
      this.logger.error(`Error removing sales channel: ${error.message}`);
      await ctx.answerCbQuery('❌ Ошибка при удалении', { show_alert: true });
    }

    const channels = await this.settingsService.getSalesChannels();
    const minRub =
      await this.settingsService.getSalesNotificationMinAmountRub();

    let text = '<b>📊 Каналы для уведомлений о продажах</b>\n\n';

    text += `<b>Порог:</b> ${
      minRub === 0
        ? 'уведомлять о <b>любой</b> сумме'
        : `только если сумма заказа в ₽ <b>≥ ${minRub.toLocaleString('ru')}</b>`
    }\n<i>(сумма в рублях из заказа; для крипто/TON используется пересчёт в ₽ в заказе)</i>\n\n`;

    if (channels.length > 0) {
      text += '<b>Активные каналы:</b>\n\n';
      for (const ch of channels) {
        const status = ch.is_active ? '✅' : '❌';
        const name = ch.channel_name || 'Без названия';
        text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
      }
    } else {
      text += '<b>📭 Каналы не добавлены</b>\n\n';
    }

    text +=
      '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
      });
    } catch (error: any) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
      });
    }
  }

  @Action(/^payment_details_(.+)$/)
  async showPaymentDetails(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    const fromAdminSearch = ctx.session.fromAdminSearch === true;
    const fromFailedDeliveries = ctx.session.fromFailedDeliveries === true;

    if (isAdmin && fromAdminSearch) {
      const match = ctx.match as RegExpExecArray | null;
      if (!match) return;
      const paymentId = match[1];
      await this.showAdminPaymentDetails(ctx, paymentId);
      return;
    }

    if (isAdmin && fromFailedDeliveries) {
      const match = ctx.match as RegExpExecArray | null;
      if (!match) return;
      const paymentId = match[1];
      await this.showAdminPaymentDetails(ctx, paymentId);
      return;
    }

    if (isAdmin) {
      const match = ctx.match as RegExpExecArray | null;
      if (!match) return;
      const paymentId = match[1];

      ctx.session.fromAdminSearch = true;
      await this.showAdminPaymentDetails(ctx, paymentId);
    }
  }

  @Action(/^payments_page_(\d+)$/)
  async navigatePaymentsPage(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const page = parseInt(match[1], 10);
    const payments = ctx.session.searchResults || [];
    const query = ctx.session.searchQuery || '';

    if (payments.length === 0) {
      await ctx.answerCbQuery('❌ Результаты поиска не найдены', {
        show_alert: true,
      });
      return;
    }

    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(payments.length / ITEMS_PER_PAGE);

    if (page < 0 || page >= totalPages) {
      await ctx.answerCbQuery('❌ Неверная страница', { show_alert: true });
      return;
    }

    ctx.session.fromAdminSearch = true;
    ctx.session.currentPage = page;

    const text = `
🔍 <b>Найдено платежей: ${payments.length}</b>

Запрос: <code>${query}</code>
Страница ${page + 1} из ${totalPages}
Выберите платёж для просмотра информации о нем:
`;

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getSearchResultsMenu(
          payments,
          page,
          totalPages,
        ).reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error updating payment page: ${error.message}`);
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getSearchResultsMenu(
          payments,
          page,
          totalPages,
        ).reply_markup,
      });
    }
  }

  @Action('payments_page_info')
  async showPaymentsPageInfo(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    const payments = ctx.session.searchResults || [];
    const currentPage = ctx.session.currentPage || 0;
    const totalPages = Math.ceil(payments.length / 10);

    await ctx.answerCbQuery(`Страница ${currentPage + 1} из ${totalPages}`, {
      show_alert: false,
    });
  }

  @Action(/^force_complete_payment:(.+)$/)
  async forceCompletePayment(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const paymentId = match[1];

    try {
      const result = await this.paymentAdmin.forceCompletePayment(paymentId);

      if (result.success) {
        await ctx.answerCbQuery(`✅ ${result.message}`, { show_alert: true });

        try {
          await ctx.deleteMessage();
        } catch {}

        await this.showAdminPaymentDetails(ctx, paymentId);
      } else {
        await ctx.answerCbQuery(`❌ ${result.message}`, { show_alert: true });
      }
    } catch (error: any) {
      this.logger.error(
        `Error force completing payment ${paymentId}: ${error.message}`,
      );
      try {
        await ctx.answerCbQuery('❌ Ошибка при обработке платежа', {
          show_alert: true,
        });
      } catch {}
    }
  }

  @Action(/^retry_delivery:(.+)$/)
  async retryDelivery(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const paymentId = match[1];

    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, product_type: true },
      });

      if (!payment) {
        await ctx.answerCbQuery('❌ Платеж не найден', { show_alert: true });
        return;
      }

      if (payment.status === 'FRAUD') {
        const forceResult =
          await this.paymentAdmin.forceCompletePayment(paymentId);
        if (!forceResult.success) {
          await ctx.answerCbQuery(forceResult.message, { show_alert: true });
          return;
        }
        await ctx.answerCbQuery(forceResult.message, { show_alert: true });
        try {
          await ctx.deleteMessage();
        } catch {}
        await this.showAdminPaymentDetails(ctx, paymentId);
        return;
      }

      const result = await this.retryFragmentQueueItem(paymentId);

      if (result.success) {
        const fromFailedDeliveries = ctx.session.fromFailedDeliveries === true;
        if (fromFailedDeliveries) {
          await this.prisma.payment.update({
            where: { id: paymentId },
            data: { stuck_resolved_at: new Date() },
          });
        }
        await ctx.answerCbQuery(`✅ ${result.message}`, { show_alert: true });

        try {
          await ctx.deleteMessage();
        } catch {}

        await this.showAdminPaymentDetails(ctx, paymentId);
      } else {
        await ctx.answerCbQuery(`❌ ${result.message}`, { show_alert: true });
      }
    } catch (error: any) {
      this.logger.error(
        `Error retrying delivery for payment ${paymentId}: ${error.message}`,
      );
      try {
        await ctx.answerCbQuery('❌ Ошибка при повторной отправке доставки', {
          show_alert: true,
        });
      } catch {}
    }
  }


  @Action(/^edit_stuck_username:(.+)$/)
  async editStuckUsername(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const paymentId = match[1];
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, order_number: true, recipient_username: true },
    });
    if (!payment) {
      await ctx.answerCbQuery('❌ Платёж не найден', { show_alert: true });
      return;
    }

    ctx.answerCbQuery().catch(() => {});
    ctx.session.awaitingStuckPaymentUsername = true;
    ctx.session.pendingStuckPaymentId = paymentId;

    const current = payment.recipient_username
      ? `@${payment.recipient_username}`
      : 'не указан';
    await ctx.reply(
      `✏️ <b>Изменить юзернейм получателя</b>\n\n` +
        `Заказ: <code>#${payment.order_number}</code>\n` +
        `Текущий: ${current}\n\n` +
        `Отправьте новый @username (без @ или с @):`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отмена', `payment_details_${paymentId}`)],
        ]).reply_markup,
      },
    );
  }

  @Action(/^view_screenshot:(.+)$/)
  async viewScreenshot(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const match = ctx.match as RegExpExecArray | null;
    if (!match) return;

    const paymentId = match[1];

    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        select: { fragment_screenshot: true, order_number: true },
      });

      if (!payment?.fragment_screenshot) {
        await ctx.answerCbQuery('❌ Скриншот не найден', { show_alert: true });
        return;
      }

      const data = payment.fragment_screenshot;
      const caption = `🖼 Снимок Fragment для заказа #${payment.order_number}`;

      ctx.answerCbQuery().catch(() => {});

      if (data.startsWith('html:')) {
        const htmlContent = data.slice(5);
        const doc = Input.fromBuffer(
          Buffer.from(htmlContent, 'utf-8'),
          `fragment_${payment.order_number}.html`,
        );
        await ctx.replyWithDocument(doc, { caption });
      } else if (data.startsWith('http')) {
        await ctx.replyWithDocument(normalizeSnapshotStorageUrl(data), {
          caption,
        });
      } else {
        const isFileId = data.length < 200;
        const file = isFileId
          ? data
          : Input.fromBuffer(
              Buffer.from(data, 'base64'),
              `fragment_${payment.order_number}.png`,
            );
        await ctx.replyWithDocument(file, { caption });
      }
    } catch (error: any) {
      this.logger.error(
        `Error sending screenshot for payment ${paymentId}: ${error.message}`,
      );
      try {
        await ctx.answerCbQuery('❌ Ошибка при отправке скриншота', {
          show_alert: true,
        });
      } catch {}
    }
  }

  private async retryFragmentQueueItem(
    paymentId: string,
  ): Promise<{ success: boolean; message: string }> {
    const item = await this.prisma.fragmentQueue.findFirst({
      where: {
        payment_id: paymentId,
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
      include: {
        payment: {
          select: { order_number: true },
        },
      },
    });

    if (!item) {
      return {
        success: false,
        message: 'Нет заказа в очереди доставки или он уже обработан',
      };
    }

    if (await this.redisLock.isQueueItemCompleted(item.id)) {
      return { success: false, message: 'Заказ уже был обработан' };
    }

    const retry = (item.retry_count || 0) + 1;
    await this.prisma.fragmentQueue.update({
      where: { id: item.id },
      data: {
        status: 'PENDING',
        retry_count: Math.min(retry, 4),
        outbound_submitted_at: null,
        external_out_msg_hash: null,
        updated_at: new Date(),
      },
    });

    this.logger.log(
      `Retried fragment queue item ${item.id} for payment ${paymentId}`,
    );
    return {
      success: true,
      message: `Доставка #${item.payment?.order_number ?? '?'} снова в очереди`,
    };
  }


  @Action('payments_back_to_list')
  async backToPaymentsList(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const payments = ctx.session.searchResults || [];
    const currentPage = ctx.session.currentPage || 0;
    const query = ctx.session.searchQuery || '';

    if (payments.length === 0) {
      await ctx.answerCbQuery('❌ Результаты поиска не найдены', {
        show_alert: true,
      });
      return;
    }

    ctx.session.fromAdminSearch = true;

    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(payments.length / ITEMS_PER_PAGE);

    const text = `
🔍 <b>Найдено платежей: ${payments.length}</b>

Запрос: <code>${query}</code>
Страница ${currentPage + 1} из ${totalPages}
Выберите платёж для просмотра информации о нем:
`;

    try {
      await ctx.deleteMessage();
    } catch {}

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: AdminKeyboard.getSearchResultsMenu(
        payments,
        currentPage,
        totalPages,
      ).reply_markup,
    });
  }


  private async showAdminPaymentDetails(
    ctx: BotContext,
    paymentId: string,
  ): Promise<void> {
    ctx.session.awaitingStuckPaymentUsername = false;
    ctx.session.pendingStuckPaymentId = undefined;
    try {
      let payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          user: true,
          fragment_queue: true,
        },
      });

      if (!payment) {
        await ctx.reply('❌ Платеж не найден', {
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        });
        return;
      }

      const fq = payment.fragment_queue?.[0];
      const deliveryPending =
        (payment.status === 'COMPLETED' || payment.status === 'CANCELLED') &&
        fq &&
        (fq.status === 'PENDING' || fq.status === 'PROCESSING');
      const deliveryFailed =
        (payment.status === 'COMPLETED' || payment.status === 'CANCELLED') &&
        fq &&
        fq.status === 'FAILED';

      let statusEmoji: string;
      let statusText: string;
      if (payment.status === 'FRAUD') {
        statusEmoji = '🚨';
        statusText = 'Мошенник (доставка заблокирована)';
      } else if (payment.status === 'CANCELLED') {
        statusEmoji = '❌';
        statusText = 'Отменена';
      } else if (payment.status === 'FAILED') {
        statusEmoji = '🔴';
        statusText = 'Ошибка';
      } else if (payment.status === 'REFUNDED') {
        statusEmoji = '↩️';
        statusText = 'Возврат / чарджбэк';
      } else if (
        payment.status === 'PENDING' ||
        payment.status === 'PROCESSING'
      ) {
        statusEmoji = '⏳';
        statusText = 'В обработке';
      } else if (deliveryPending) {
        statusEmoji = '⏳';
        statusText = 'В ожидании доставки';
      } else if (deliveryFailed) {
        statusEmoji = '❌';
        statusText = 'Ошибка доставки';
      } else {
        statusEmoji = '✅';
        statusText = 'Выполнена';
      }

      let productName: string;
      if (payment.product_type === 'STARS') {
        productName = '⭐ STARS';
      } else if (payment.product_type === 'TON') {
        productName = '💎 TON';
      } else if (payment.product_type === 'PREMIUM') {
        productName = '👑 PREMIUM';
      } else {
        productName = escapeHtml(payment.product_type);
      }

      const paymentMethodText =
        payment.payment_method === 'TON'
          ? 'TON'
          : payment.payment_method === 'PLATEGA'
            ? 'СБП РФ'
            : payment.payment_method === 'HELEKET'
              ? 'Криптовалюта'
              : payment.payment_method === 'SBP2'
                ? 'СБП 2 РФ'
                : payment.payment_method === 'AURAPAY_SBP'
                  ? 'СБП 3 РФ'
                  : payment.payment_method === 'AURAPAY_CARD'
                    ? 'Карты РФ'
                    : escapeHtml(String(payment.payment_method));

      const formattedDate = new Date(payment.created_at)
        .toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
        .replace(',', '');

      const nameRaw =
        `${payment.user.first_name || ''} ${payment.user.last_name || ''}`.trim();
      const userFullName = nameRaw ? escapeHtml(nameRaw) : 'Не указано';
      const userUsername = payment.user.username
        ? `@${escapeHtml(payment.user.username)}`
        : 'Не указан';

      let recipientInfo = '';
      const buyerNameForRecipientCompare = nameRaw || 'Не указано';
      if (
        payment.recipient_username &&
        payment.recipient_username !== payment.user.username
      ) {
        recipientInfo = `\n👤 Получатель: @${escapeHtml(payment.recipient_username)}`;
      } else if (
        payment.recipient_name &&
        payment.recipient_name !== buyerNameForRecipientCompare
      ) {
        recipientInfo = `\n👤 Получатель: ${escapeHtml(payment.recipient_name)}`;
      }

      const amountRub = Number(payment.amount_rub || 0);
      const amountUsd = Number(payment.amount_usd || 0);
      const amountTon = Number(payment.amount_ton || 0);

      const paymentFeePercent = Number(payment.payment_system_fee_percent || 0);
      const serviceMarkupPercent = Number(payment.service_markup_percent || 0);

      let paymentFeeSum = 0;
      if (
        payment.payment_method === 'PLATEGA' ||
        payment.payment_method === 'SBP2'
      ) {
        paymentFeeSum = amountRub * (paymentFeePercent / 100);
      } else if (payment.payment_method === 'HELEKET') {
        paymentFeeSum = amountUsd * (paymentFeePercent / 100);
      }

      const purchasePrice = Number(payment.purchase_price_usd || 0);
      const rate = Number(payment.usd_rate || 1);

      let serviceMarkupSum = 0;
      let netProfit = 0;
      let currency = '₽';
      let amountDisplay = '';
      let feeDisplay = '';

      if (payment.payment_method === 'TON') {
        currency = 'TON';
        serviceMarkupSum = purchasePrice * (serviceMarkupPercent / 100);
        const tonRate = amountTon / amountUsd;
        serviceMarkupSum = serviceMarkupSum * tonRate;
        netProfit = serviceMarkupSum;
        amountDisplay = `${amountTon.toFixed(4)} TON`;
      } else if (payment.payment_method === 'HELEKET') {
        currency = '$';
        serviceMarkupSum = purchasePrice * (serviceMarkupPercent / 100);
        netProfit = Number(payment.net_profit_rub || 0) / rate;
        amountDisplay = `$${amountUsd.toFixed(2)}`;
        if (amountRub > 0) {
          amountDisplay += `\n└ Сумма RUB: ${amountRub.toFixed(2)} ₽`;
        }
      } else {
        currency = '₽';
        serviceMarkupSum = purchasePrice * (serviceMarkupPercent / 100) * rate;
        netProfit = Number(payment.net_profit_rub || 0);
        amountDisplay = `${amountRub.toFixed(2)} ₽`;
        if (amountUsd > 0) {
          amountDisplay += `\n└ Сумма USD: $${amountUsd.toFixed(2)}`;
        }
      }

      if (paymentFeePercent > 0) {
        if (payment.payment_method === 'HELEKET') {
          feeDisplay = `\n\n💸 <b>КОМИССИЯ ПЛАТЁЖНОЙ СИСТЕМЫ</b>\n├ Процент: ${paymentFeePercent.toFixed(2)}%\n└ Сумма: ${paymentFeeSum.toFixed(2)} $`;
        } else if (payment.payment_method === 'PLATEGA') {
          feeDisplay = `\n\n💸 <b>КОМИССИЯ ПЛАТЁЖНОЙ СИСТЕМЫ</b>\n├ Процент: ${paymentFeePercent.toFixed(2)}%\n└ Сумма: ${paymentFeeSum.toFixed(2)} ₽`;
        }
      }

      const tonscanLinks: string[] = [];

      if (fq?.tx_hash) {
        const tx = fq.tx_hash.trim();
        const deliveryUrl =
          /^[0-9a-fA-F]{64}$/i.test(tx) ||
          (/^[0-9a-fA-F]+$/i.test(tx) && tx.length >= 32)
            ? `https://tonviewer.com/transaction/${tx}`
            : `https://tonviewer.com/transaction/${tx.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;
        tonscanLinks.push(
          `🔗 <a href="${escapeHtml(deliveryUrl)}">Транзакция доставки (TON)</a>`,
        );
      }

      let tonTxId = '';
      if (payment.payment_method === 'TON') {
        tonTxId = (payment.external_payment_id || '').trim();
        if (!tonTxId && payment.provider_transaction_id) {
          const p = payment.provider_transaction_id.trim();
          if (/^[0-9a-fA-F]{64}$/i.test(p)) tonTxId = p;
        }
      }
      if (payment.payment_method === 'TON' && tonTxId) {
        const txid = tonTxId;
        let tonscanUrl = '';

        if (/^[0-9a-fA-F]{64}$/i.test(txid)) {
          tonscanUrl = `https://tonviewer.com/transaction/${txid}`;
        } else if (/^[0-9a-fA-F]+$/i.test(txid) && txid.length >= 32) {
          tonscanUrl = `https://tonviewer.com/transaction/${txid}`;
        } else {
          try {
            const cleanTxid = txid.replace(/\s/g, '');
            const buffer = Buffer.from(cleanTxid, 'base64');
            const hex = buffer.toString('hex');
            if (hex.length >= 32) {
              tonscanUrl = `https://tonviewer.com/transaction/${hex}`;
            } else {
              const base64url = cleanTxid
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
              tonscanUrl = `https://tonviewer.com/transaction/${base64url}`;
            }
          } catch (e) {
            const base64url = txid
              .replace(/\+/g, '-')
              .replace(/\//g, '_')
              .replace(/=/g, '');
            tonscanUrl = `https://tonviewer.com/transaction/${base64url}`;
          }
        }
        tonscanLinks.push(
          `🔗 <a href="${escapeHtml(tonscanUrl)}">Оплата клиентом (TON)</a>`,
        );
      }

      const tonscanLink =
        tonscanLinks.length > 0 ? '\n\n' + tonscanLinks.join('\n') : '';

      let screenshotLink = '';
      if (payment.fragment_screenshot?.startsWith('http')) {
        screenshotLink = `\n📸 <a href="${escapeHtml(normalizeSnapshotStorageUrl(payment.fragment_screenshot))}">Скриншот доставки</a>`;
      }

      const internalStatusFallbackMap: Record<string, string> = {
        PENDING: '⏳ Ожидает подтверждения',
        PROCESSING: '⌛️ В обработке',
        COMPLETED: '✅ Подтверждена (внутренний статус)',
        CANCELLED: '❌ Отменена/истекла (внутренний статус)',
        FAILED: '⛔ Ошибка (внутренний статус)',
        REFUNDED: '↩️ Возврат (внутренний статус)',
        FRAUD: '🚫 Заблокирована антифродом (внутренний статус)',
      };
      let providerStatusText = `⚠️ Не получен от провайдера · ${internalStatusFallbackMap[payment.status] || payment.status}`;
      try {
        const providerStatus =
          await this.paymentsService.getProviderStatus(payment);
        if (providerStatus) {
          providerStatusText = providerStatus;
        }
      } catch {}
      const providerStatusLine = `\n├ Статус в платёжной системе: ${escapeHtml(providerStatusText)}`;

      let phoneLine = '';
      try {
        const phoneRecord = await this.prisma.paymentPhone.findUnique({
          where: { payment_id: payment.id },
          select: { phone_number: true },
        });
        if (phoneRecord?.phone_number) {
          phoneLine = `\n📱 <b>Телефон оплаты:</b> <code>${escapeHtml(phoneRecord.phone_number)}</code>`;
        }
      } catch {}

      let cardLine = '';
      try {
        const cardRecord = await this.prisma.paymentCard.findUnique({
          where: { payment_id: payment.id },
          select: { card_mask: true },
        });
        if (cardRecord?.card_mask) {
          cardLine = `\n💳 <b>Карта оплаты:</b> <code>${escapeHtml(cardRecord.card_mask)}</code>`;
        }
      } catch {}

      let fraudListBlock = '';
      try {
        const buyerFraud = await this.prisma.fraudList.findFirst({
          where: { telegram_id: payment.user.telegram_id },
          select: { reason: true, added_by: true },
        });
        const recNorm =
          payment.recipient_username?.replace(/^@+/, '').trim() || '';
        const recipientFraud =
          recNorm && recNorm !== (payment.user.username || '').replace(/^@+/, '')
            ? await this.prisma.fraudList.findFirst({
                where: { username: recNorm },
                select: { reason: true, added_by: true },
              })
            : null;
        const fraudParts: string[] = [];
        if (buyerFraud) {
          fraudParts.push(
            `🚨 <b>Покупатель в fraud_list</b> <i>(${escapeHtml(buyerFraud.added_by || '—')})</i>\n└ ${escapeHtml(buyerFraud.reason || 'без причины')}`,
          );
        }
        if (recipientFraud) {
          fraudParts.push(
            `🚨 <b>Получатель @${escapeHtml(recNorm)} в fraud_list</b> <i>(${escapeHtml(recipientFraud.added_by || '—')})</i>\n└ ${escapeHtml(recipientFraud.reason || 'без причины')}`,
          );
        }
        if (fraudParts.length > 0) {
          fraudListBlock = '\n\n' + fraudParts.join('\n\n');
        }
      } catch {}

      const productDetailBlock = `├ Товар: ${productName}\n└ Количество: ${escapeHtml(String(payment.product_quantity))}`;

      const detailsText = `📋 <b>Информация о платеже</b>

🆔 <b>Номер заказа:</b> <code>#${escapeHtml(String(payment.order_number))}</code>
📅 <b>Время платежа (МСК):</b> ${formattedDate}
${statusEmoji} <b>Статус:</b> ${statusText}${fraudListBlock}

👤 <b>ПОКУПАТЕЛЬ</b>
├ ID: <code>${escapeHtml(String(payment.user.telegram_id))}</code>
├ Username: ${userUsername}
└ Имя: ${userFullName}${recipientInfo}

💳 <b>ПЛАТЁЖ</b>
├ Способ оплаты: ${paymentMethodText}${payment.external_payment_id ? `\n├ ID транзакции: <code>${escapeHtml(String(payment.external_payment_id))}</code>` : ''}${!payment.external_payment_id && payment.provider_transaction_id ? `\n├ ID транзакции: <code>${escapeHtml(String(payment.provider_transaction_id))}</code>` : ''}${providerStatusLine}
├ Сумма: ${amountDisplay}${phoneLine}${cardLine}

🛍 <b>ТОВАР</b>
${productDetailBlock}${feeDisplay}

💰 <b>НАША КОМИССИЯ (ДОХОД)</b>
├ Процент: ${serviceMarkupPercent.toFixed(2)}%
└ Сумма дохода: ${serviceMarkupSum.toFixed(2)} ${currency}

💵 <b>Чистая прибыль:</b> ${netProfit.toFixed(2)} ${currency}${tonscanLink}${screenshotLink}`;

      try {
        await ctx.deleteMessage();
      } catch {}

      const payments = ctx.session.searchResults || [];
      const fromFailedDeliveries = ctx.session.fromFailedDeliveries === true;

      const buttons = [];

      if (
        !fromFailedDeliveries &&
        (payment.status === 'PENDING' ||
          payment.status === 'PROCESSING' ||
          payment.status === 'FAILED' ||
          payment.status === 'CANCELLED' ||
          payment.status === 'FRAUD')
      ) {
        buttons.push([
          Markup.button.callback(
            '🚀 Протолкнуть транзакцию',
            `force_complete_payment:${payment.id}`,
          ),
        ]);
      }

      if (deliveryPending || deliveryFailed) {
        buttons.push([
          Markup.button.callback(
            '📤 Повторить доставку',
            `retry_delivery:${payment.id}`,
          ),
        ]);
        buttons.push([
          Markup.button.callback(
            '✏️ Изменить юзернейм получателя',
            `edit_stuck_username:${payment.id}`,
          ),
        ]);
      }

      if (fromFailedDeliveries) {
        buttons.push([
          Markup.button.callback(
            '🔙 К застрявшим платежам',
            'back_to_failed_deliveries',
          ),
        ]);
      } else if (payments.length > 0) {
        buttons.push([
          Markup.button.callback(
            '🔙 К списку платежей',
            'payments_back_to_list',
          ),
        ]);
      } else {
        buttons.push([Markup.button.callback('🔙 Назад', 'admin_search')]);
      }

      const backKeyboard = Markup.inlineKeyboard(buttons);

      await ctx.reply(detailsText, {
        parse_mode: 'HTML',
        reply_markup: backKeyboard.reply_markup,
      });
    } catch (error: any) {
      this.logger.error(
        `Error showing admin payment details: ${error.message}`,
      );
      await ctx.reply('❌ Ошибка загрузки деталей платежа', {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
    }
  }

  @On('text')
  async onTextMessageAdmin(@Ctx() ctx: BotContext): Promise<void> {
    const text = (ctx.message as any)?.text;
    if (!text) return;

    if (text.startsWith('/set_toncenter_expiry')) {
      return this.setToncenterExpiry(ctx);
    }
    if (text.startsWith('/set_server_expiry')) {
      return this.setServerExpiry(ctx);
    }

    if (text.startsWith('/')) {
      return;
    }

    const userId = ctx.from?.id.toString();
    if (!userId) return;

    const isAdmin = await this.userService.isAdmin(userId);

    if (!isAdmin) {
      return;
    }

    if (ctx.session.awaitingPaymentSearch) {
      const searchQuery = text.trim();
      const isUserPurchasesSearch = ctx.session.searchUserPurchases;
      ctx.session.awaitingPaymentSearch = false;
      ctx.session.searchUserPurchases = false;

      try {
        await ctx.deleteMessage();
      } catch {}

      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handlePaymentSearch(ctx, searchQuery, isUserPurchasesSearch);
      return;
    }

    if (
      ctx.session.awaitingStuckPaymentUsername &&
      ctx.session.pendingStuckPaymentId
    ) {
      const paymentId = ctx.session.pendingStuckPaymentId;
      ctx.session.awaitingStuckPaymentUsername = false;
      ctx.session.pendingStuckPaymentId = undefined;

      let username = text.trim().replace(/^@+/, '').replace(/\s/g, '');
      if (!username || username.length < 5 || username.length > 32) {
        await ctx.reply(
          '❌ Юзернейм должен быть от 5 до 32 символов (латиница, цифры, подчёркивание). Попробуйте снова или нажмите на платёж для отмены.',
        );
        ctx.session.awaitingStuckPaymentUsername = true;
        ctx.session.pendingStuckPaymentId = paymentId;
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        await ctx.reply(
          '❌ Юзернейм может содержать только латиницу, цифры и подчёркивание. Попробуйте снова.',
        );
        ctx.session.awaitingStuckPaymentUsername = true;
        ctx.session.pendingStuckPaymentId = paymentId;
        return;
      }

      try {
        await this.prisma.payment.update({
          where: { id: paymentId },
          data: { recipient_username: username },
        });
        const queueItem = await this.prisma.fragmentQueue.findFirst({
          where: { payment_id: paymentId },
        });
        if (queueItem) {
          await this.prisma.fragmentQueue.update({
            where: { id: queueItem.id },
            data: { username, updated_at: new Date() },
          });
        }
        await ctx.reply(`✅ Юзернейм получателя обновлён на @${username}`);
        await this.showAdminPaymentDetails(ctx, paymentId);
      } catch (err: any) {
        this.logger.error(
          `Error updating stuck payment username: ${err.message}`,
        );
        await ctx.reply('❌ Ошибка при обновлении. Попробуйте снова.');
        ctx.session.awaitingStuckPaymentUsername = true;
        ctx.session.pendingStuckPaymentId = paymentId;
      }
      return;
    }

    if (ctx.session.awaitingFragmentAccountName) {
      await this.handleFragmentAccountNameInput(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingFragmentAccountTokens) {
      await this.handleFragmentAccountTokensInput(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingFragmentAccountUpdate) {
      await this.handleFragmentAccountUpdateInput(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingButtonTemplateName) {
      const name = text.trim();
      if (name.length === 0 || name.length > 64) {
        await ctx.reply(
          '❌ Название шаблона должно быть от 1 до 64 символов. Попробуйте еще раз:',
        );
        return;
      }

      const buttons = ctx.session.pendingButtonTemplateButtons || [];
      ctx.session.awaitingButtonTemplateName = false;
      ctx.session.pendingButtonTemplateButtons = undefined;
      ctx.session.awaitingBroadcastButton = false;

      try {
        await ctx.deleteMessage();
      } catch {}

      await this.prisma.buttonTemplate.create({
        data: {
          name,
          buttons: buttons as any,
        },
      });

      const templates = await this.prisma.buttonTemplate.findMany({
        orderBy: { created_at: 'desc' },
      });

      const tplData = templates.map((t) => ({
        id: t.id,
        name: t.name,
        buttons: (t.buttons as any[]) || [],
      }));

      await ctx.reply(
        `✅ Шаблон <b>${name}</b> сохранён (${buttons.length} кн.)\n\n📋 <b>Шаблоны кнопок</b>\n\nВсего шаблонов: ${templates.length}`,
        {
          parse_mode: 'HTML',
          reply_markup:
            AdminKeyboard.getButtonTemplatesMenu(tplData).reply_markup,
        },
      );
      return;
    }

    if (ctx.session.awaitingBroadcast) {
      const message = ctx.message as any;

      ctx.session.broadcastMessage = text;
      ctx.session.broadcastEntities = message.entities || [];
      ctx.session.awaitingBroadcast = false;
      ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await ctx.deleteMessage();
      } catch {}

      const hasTemplatesText = await this.prisma.buttonTemplate
        .count()
        .then((c) => c > 0)
        .catch(() => false);

      const sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, text, {
        entities: message.entities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplatesText,
        ),
      });

      ctx.session.broadcastMessageId = sentMessage.message_id;
      ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
      return;
    }

    if (ctx.session.awaitingBroadcastButton) {
      const inputText = text.trim();

      if (!ctx.session.currentBroadcastButtonText) {
        const separatorMatch = inputText.match(
          /^(.+?)\s*[-—]\s*(https?:\/\/.+)$/i,
        );

        if (separatorMatch) {
          const buttonText = separatorMatch[1].trim();
          const url = separatorMatch[2].trim();

          if (buttonText.length === 0 || buttonText.length > 64) {
            await ctx.reply(
              '❌ Текст кнопки должен быть от 1 до 64 символов. Попробуйте еще раз:',
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [
                    Markup.button.callback(
                      '🔙 Назад к кнопкам',
                      'broadcast_back_to_buttons',
                    ),
                  ],
                ]).reply_markup,
              },
            );
            return;
          }

          try {
            new URL(url);
          } catch {
            await ctx.reply(
              '❌ Неверный формат URL в ссылке. Попробуйте еще раз:\n\n<i>Пример: ⭐️КУПИТЬ STARS⭐️ - https://t.me/MopsStarsBot?start=stars</i>',
              {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                  [
                    Markup.button.callback(
                      '🔙 Назад к кнопкам',
                      'broadcast_back_to_buttons',
                    ),
                  ],
                ]).reply_markup,
              },
            );
            return;
          }

          if (!ctx.session.broadcastButtons) {
            ctx.session.broadcastButtons = [];
          }

          const isTemplateMode =
            ctx.session.pendingButtonTemplateButtons !== undefined;

          if (isTemplateMode) {
            ctx.session.pendingButtonTemplateButtons!.push({
              text: buttonText,
              url,
            });
          } else {
            ctx.session.broadcastButtons.push({ text: buttonText, url });
          }

          try {
            await ctx.deleteMessage();
          } catch {}

          try {
            if (ctx.session.lastBotMessageId) {
              await ctx.telegram.deleteMessage(
                ctx.chat!.id,
                ctx.session.lastBotMessageId,
              );
            }
          } catch {}

          if (isTemplateMode) {
            const tplButtons = ctx.session.pendingButtonTemplateButtons!;
            const msg = await ctx.reply(
              `✅ Кнопка добавлена (${tplButtons.length} шт.)\n\n` +
                tplButtons.map((b, i) => `${i + 1}. ${b.text}`).join('\n') +
                `\n\nДобавьте ещё кнопку или нажмите <b>Завершить</b>:`,
              {
                parse_mode: 'HTML',
                reply_markup: AdminKeyboard.getBroadcastButtonsMenu([], false)
                  .reply_markup,
              },
            );
            ctx.session.lastBotMessageId = msg.message_id;
            ctx.session.awaitingBroadcastButton = false;
            return;
          }

          try {
            await ctx.deleteMessage();
          } catch {}

          try {
            if (ctx.session.lastBotMessageId) {
              await ctx.telegram.deleteMessage(
                ctx.chat!.id,
                ctx.session.lastBotMessageId,
              );
            }
          } catch {}

          const previewText =
            ctx.session.broadcastMessage || ctx.session.broadcastCaption || '';
          const previewEntities =
            ctx.session.broadcastEntities ||
            ctx.session.broadcastCaptionEntities;

          let sentMessage;
          if (ctx.session.broadcastPhotoFileId) {
            sentMessage = await ctx.telegram.sendPhoto(
              ctx.chat!.id,
              ctx.session.broadcastPhotoFileId,
              {
                caption: previewText,
                caption_entities: previewEntities,
                ...AdminKeyboard.getBroadcastButtonsMenu(
                  ctx.session.broadcastButtons,
                ),
              },
            );
          } else if (ctx.session.broadcastPhoto) {
            try {
              const photoBuffer = Buffer.from(
                ctx.session.broadcastPhoto,
                'base64',
              );
              sentMessage = await ctx.telegram.sendPhoto(
                ctx.chat!.id,
                Input.fromBuffer(photoBuffer),
                {
                  caption: previewText,
                  caption_entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            } catch {
              sentMessage = await ctx.telegram.sendMessage(
                ctx.chat!.id,
                previewText,
                {
                  entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            }
          } else if (ctx.session.broadcastAnimationFileId) {
            sentMessage = await ctx.telegram.sendAnimation(
              ctx.chat!.id,
              ctx.session.broadcastAnimationFileId,
              {
                caption: previewText,
                caption_entities: previewEntities,
                ...AdminKeyboard.getBroadcastButtonsMenu(
                  ctx.session.broadcastButtons,
                ),
              },
            );
          } else if (ctx.session.broadcastAnimation) {
            try {
              const animBuffer = Buffer.from(
                ctx.session.broadcastAnimation,
                'base64',
              );
              sentMessage = await ctx.telegram.sendAnimation(
                ctx.chat!.id,
                Input.fromBuffer(animBuffer),
                {
                  caption: previewText,
                  caption_entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            } catch {
              sentMessage = await ctx.telegram.sendMessage(
                ctx.chat!.id,
                previewText,
                {
                  entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            }
          } else if (ctx.session.broadcastVideoFileId) {
            sentMessage = await ctx.telegram.sendVideo(
              ctx.chat!.id,
              ctx.session.broadcastVideoFileId,
              {
                caption: previewText,
                caption_entities: previewEntities,
                ...AdminKeyboard.getBroadcastButtonsMenu(
                  ctx.session.broadcastButtons,
                ),
              },
            );
          } else if (ctx.session.broadcastVideo) {
            try {
              const videoBuffer = Buffer.from(
                ctx.session.broadcastVideo,
                'base64',
              );
              sentMessage = await ctx.telegram.sendVideo(
                ctx.chat!.id,
                Input.fromBuffer(videoBuffer),
                {
                  caption: previewText,
                  caption_entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            } catch {
              sentMessage = await ctx.telegram.sendMessage(
                ctx.chat!.id,
                previewText,
                {
                  entities: previewEntities,
                  ...AdminKeyboard.getBroadcastButtonsMenu(
                    ctx.session.broadcastButtons,
                  ),
                },
              );
            }
          } else {
            sentMessage = await ctx.telegram.sendMessage(
              ctx.chat!.id,
              previewText,
              {
                entities: previewEntities,
                ...AdminKeyboard.getBroadcastButtonsMenu(
                  ctx.session.broadcastButtons,
                ),
              },
            );
          }

          ctx.session.broadcastMessageId = sentMessage.message_id;
          ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
          ctx.session.lastBotMessageId = sentMessage.message_id;
          ctx.session.awaitingBroadcastButton = false;
          return;
        }

        await ctx.reply(
          '❌ Неверный формат. Отправьте кнопку в формате:\n\n<code>Текст кнопки - https://ссылка</code>\n\n<i>Пример: ⭐️КУПИТЬ STARS⭐️ - https://t.me/MopsStarsBot?start=stars</i>',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  '🔙 Назад к кнопкам',
                  'broadcast_back_to_buttons',
                ),
              ],
            ]).reply_markup,
          },
        );
        return;
      }
    }

    if (ctx.session.awaitingBlockUser) {
      ctx.session.awaitingBlockUser = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleBlockUser(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingUnblockUser) {
      ctx.session.awaitingUnblockUser = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleUnblockUser(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingMassBlock) {
      ctx.session.awaitingMassBlock = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleMassBlock(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingCaptchaUnban) {
      ctx.session.awaitingCaptchaUnban = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleCaptchaUnban(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingFraudUser) {
      ctx.session.awaitingFraudUser = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleAddFraudUser(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingFraudUnban) {
      ctx.session.awaitingFraudUnban = false;
      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}
      await this.handleFraudUnban(ctx, text.trim());
      return;
    }

    if (ctx.session.awaitingStatsStartDate) {
      const dateText = text.trim();
      const dateMatch = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

      if (!dateMatch) {
        await ctx.reply(
          '❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ\n\n<b>Пример:</b> <code>01.01.2024</code>',
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getBackToStats().reply_markup,
          },
        );
        return;
      }

      const [, day, month, year] = dateMatch;
      const startDate = new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
      );

      if (isNaN(startDate.getTime())) {
        await ctx.reply('❌ Неверная дата. Проверьте правильность ввода.', {
          reply_markup: AdminKeyboard.getBackToStats().reply_markup,
        });
        return;
      }

      ctx.session.statsStartDate = startDate.toISOString();
      ctx.session.awaitingStatsStartDate = false;
      ctx.session.awaitingStatsEndDate = true;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      const endDateText = `
📅 <b>Статистика за период</b>

Дата начала: ${dateText}

Введите дату конца периода в формате ДД.ММ.ГГГГ

<b>Пример:</b> <code>31.12.2024</code>
`;

      const message = await ctx.reply(endDateText, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToStats().reply_markup,
      });
      ctx.session.lastBotMessageId = message.message_id;
      return;
    }

    if (ctx.session.awaitingStatsEndDate) {
      const dateText = text.trim();
      const dateMatch = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

      if (!dateMatch) {
        await ctx.reply(
          '❌ Неверный формат даты. Используйте формат ДД.ММ.ГГГГ\n\n<b>Пример:</b> <code>31.12.2024</code>',
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getBackToStats().reply_markup,
          },
        );
        return;
      }

      const [, day, month, year] = dateMatch;
      const endDate = new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        23,
        59,
        59,
        999,
      );

      if (isNaN(endDate.getTime())) {
        await ctx.reply('❌ Неверная дата. Проверьте правильность ввода.', {
          reply_markup: AdminKeyboard.getBackToStats().reply_markup,
        });
        return;
      }

      const startDateStr = ctx.session.statsStartDate;
      if (!startDateStr) {
        await ctx.reply('❌ Ошибка: дата начала не найдена.', {
          reply_markup: AdminKeyboard.getBackToStats().reply_markup,
        });
        ctx.session.awaitingStatsEndDate = false;
        return;
      }

      const startDate = new Date(startDateStr);

      if (endDate < startDate) {
        await ctx.reply(
          '❌ Дата конца периода не может быть раньше даты начала.',
          {
            reply_markup: AdminKeyboard.getBackToStats().reply_markup,
          },
        );
        return;
      }

      ctx.session.statsEndDate = endDate.toISOString();
      ctx.session.awaitingStatsEndDate = false;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      await this.adminHandlers.showStatsForPeriod(ctx, startDate, endDate);
      return;
    }

    if (ctx.session.awaitingChannel) {
      const channelInput = text.trim();

      if (!(channelInput.startsWith('@') || channelInput.startsWith('-100'))) {
        await ctx.reply(
          '❌ <b>Неверный формат!</b>\n\nИспользуйте:\n• @channel_username\n• -100XXXXXXXXXX',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('🔙 Назад', 'admin_channels')],
            ]).reply_markup,
          },
        );
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
          ctx.session.lastBotMessageId = undefined;
        }
      } catch {}

      try {
        const chat = await ctx.telegram.getChat(channelInput);
        const channelName = (chat as any).title || 'Без названия';

        const botMember = await ctx.telegram.getChatMember(
          channelInput,
          ctx.botInfo!.id,
        );
        if (
          botMember.status !== 'administrator' &&
          botMember.status !== 'creator'
        ) {
          await ctx.reply(
            `❌ <b>Ошибка!</b>\n\nБот не является администратором этого канала.\nДобавьте бота в администраторы канала и попробуйте снова.`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
            },
          );
          ctx.session.awaitingChannel = false;
          return;
        }

        if ((chat as any).username) {
          const channelLink = `https://t.me/${(chat as any).username}`;

          try {
            await this.settingsService.addRequiredChannel(
              chat.id.toString(),
              channelName,
              channelLink,
            );

            const text = `
<b>✅ Канал добавлен!</b>

<b>Название: ${channelName}</b>
<b>ID: <code>${chat.id}</code></b>
<b>Ссылка: ${channelLink}</b>

<b>Теперь пользователи должны будут подписаться на этот канал перед использованием бота.</b>
            `;

            ctx.session.awaitingChannel = false;

            await ctx.reply(text, {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
            });
          } catch (error: any) {
            if (error.code === 'P2002') {
              await ctx.reply(
                '<b>❌ Ошибка при добавлении канала. Возможно, он уже добавлен.</b>',
                {
                  parse_mode: 'HTML',
                  reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
                },
              );
            } else {
              throw error;
            }
            ctx.session.awaitingChannel = false;
          }
        } else {
          const text = `
<b>📺 Канал найден!</b>

<b>Название: ${channelName}</b>
<b>ID: <code>${chat.id}</code></b>

<b>⚠️ У канала нет публичного @username</b>

<b>📝 Отправьте ссылку-приглашение для этого канала:</b>
<b>Пример: <code>https://t.me/+AbCdEfGhIjK</code></b>

<b>💡 Чтобы получить ссылку:</b>
<b>1. Откройте канал в Telegram</b>
<b>2. Нажмите на название канала</b>
<b>3. Выберите 'Пригласительные ссылки'</b>
<b>4. Создайте или скопируйте существующую ссылку</b>
          `;

          ctx.session.awaitingChannel = false;
          ctx.session.awaitingChannelInviteLink = true;
          ctx.session.pendingChannelId = chat.id.toString();
          ctx.session.pendingChannelName = channelName;

          const message = await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Отменить', 'admin_channels')],
            ]).reply_markup,
          });
          ctx.session.lastBotMessageId = message.message_id;
        }
      } catch (error: any) {
        this.logger.error(`Error adding channel: ${error.message}`);
        ctx.session.awaitingChannel = false;
        await ctx.reply(
          `❌ <b>Ошибка!</b>\n\nНе удалось получить информацию о канале.\nПроверьте правильность username/ID и убедитесь, что бот добавлен в канал.\n\nДетали: ${error.message}`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
          },
        );
      }
      return;
    }

    if (ctx.session.awaitingChannelInviteLink) {
      const inviteLink = text.trim();

      if (
        !(
          inviteLink.startsWith('https://t.me/+') ||
          inviteLink.startsWith('https://t.me/joinchat/')
        )
      ) {
        await ctx.reply(
          '❌ <b>Неверный формат ссылки!</b>\n\nСсылка должна начинаться с:\n• <code>https://t.me/+</code>\n• <code>https://t.me/joinchat/</code>\n\n📝 Попробуйте снова:',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Отменить', 'admin_channels')],
            ]).reply_markup,
          },
        );
        return;
      }

      const channelId = ctx.session.pendingChannelId;
      const channelName = ctx.session.pendingChannelName || 'Без названия';

      if (!channelId) {
        await ctx.reply('❌ Ошибка: данные канала не найдены', {
          reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
        });
        ctx.session.awaitingChannelInviteLink = false;
        ctx.session.pendingChannelId = undefined;
        ctx.session.pendingChannelName = undefined;
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
          ctx.session.lastBotMessageId = undefined;
        }
      } catch {}

      try {
        await this.settingsService.addRequiredChannel(
          channelId,
          channelName,
          inviteLink,
        );

        const text = `
<b>✅ Канал добавлен!</b>

<b>Название: ${channelName}</b>
<b>ID: <code>${channelId}</code></b>
<b>Ссылка: ${inviteLink}</b>

<b>Теперь пользователи должны будут подписаться на этот канал перед использованием бота.</b>
        `;

        ctx.session.awaitingChannelInviteLink = false;
        ctx.session.pendingChannelId = undefined;
        ctx.session.pendingChannelName = undefined;

        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          await ctx.reply(
            '<b>❌ Ошибка при добавлении канала. Возможно, он уже добавлен.</b>',
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
            },
          );
        } else {
          this.logger.error(
            `Error adding channel with invite link: ${error.message}`,
          );
          await ctx.reply(
            `❌ <b>Ошибка при добавлении канала</b>\n\n${error.message}`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getChannelsMenu().reply_markup,
            },
          );
        }
        ctx.session.awaitingChannelInviteLink = false;
        ctx.session.pendingChannelId = undefined;
        ctx.session.pendingChannelName = undefined;
      }
      return;
    }

    if (ctx.session.awaitingInsufficientFundsChannel) {
      ctx.session.awaitingInsufficientFundsChannel = false;
      ctx.session.awaitingSalesChannel = false;
      ctx.session.awaitingSalesNotificationMinRub = false;
      const channelId = text.trim();

      if (
        !(
          channelId.startsWith('-100') ||
          channelId.replace(/^-/, '').match(/^\d+$/)
        )
      ) {
        await ctx.reply(
          '❌ <b>Неверный формат ID канала</b>\n\nID должен начинаться с <code>-100</code> или быть числом\nПример: <code>-1001234567890</code>',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  '❌ Отмена',
                  'insufficient_funds_channels',
                ),
              ],
            ]).reply_markup,
          },
        );
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        const chat = await ctx.telegram.getChat(channelId);
        const channelName = (chat as any).title || 'Без названия';

        const botMember = await ctx.telegram.getChatMember(
          channelId,
          ctx.botInfo!.id,
        );
        if (
          botMember.status !== 'administrator' &&
          botMember.status !== 'creator'
        ) {
          await ctx.reply(
            `❌ <b>Бот не является администратором</b>\n\nКанал: <b>${channelName}</b>\n\nДобавьте бота в канал с правами администратора и попробуйте снова`,
            {
              parse_mode: 'HTML',
              reply_markup:
                AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
            },
          );
          return;
        }

        try {
          await this.settingsService.addInsufficientFundsChannel(
            channelId,
            channelName,
          );

          const channels =
            await this.settingsService.getInsufficientFundsChannels();

          let text =
            '<b>⚠️ Каналы для уведомлений о недостатке средств</b>\n\n';

          if (channels.length > 0) {
            text += '<b>Активные каналы:</b>\n\n';
            for (const ch of channels) {
              const status = ch.is_active ? '✅' : '❌';
              const name = ch.channel_name || 'Без названия';
              text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
            }
          } else {
            text += '<b>📭 Каналы не добавлены</b>\n\n';
          }

          text +=
            '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

          await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup:
              AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
          });
        } catch (error: any) {
          this.logger.error(
            `Error adding insufficient funds channel: ${error.message}`,
          );
          await ctx.reply('❌ Ошибка при добавлении канала', {
            reply_markup:
              AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
          });
        }
      } catch (error: any) {
        this.logger.error(
          `Error processing insufficient funds channel: ${error.message}`,
        );
        await ctx.reply(
          `❌ <b>Ошибка при обработке канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup:
              AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
          },
        );
      }
      return;
    }

    if (ctx.session.awaitingInsufficientFundsChannel) {
      ctx.session.awaitingInsufficientFundsChannel = false;
      const channelId = text.trim();

      if (
        !(
          channelId.startsWith('-100') ||
          channelId.replace(/^-/, '').match(/^\d+$/)
        )
      ) {
        await ctx.reply(
          '❌ <b>Неверный формат ID канала</b>\n\nID должен начинаться с <code>-100</code> или быть числом\nПример: <code>-1001234567890</code>',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  '❌ Отмена',
                  'insufficient_funds_channels',
                ),
              ],
            ]).reply_markup,
          },
        );
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        const chat = await ctx.telegram.getChat(channelId);
        const channelName = (chat as any).title || 'Без названия';

        const botMember = await ctx.telegram.getChatMember(
          channelId,
          ctx.botInfo!.id,
        );
        if (
          botMember.status !== 'administrator' &&
          botMember.status !== 'creator'
        ) {
          await ctx.reply(
            `❌ <b>Бот не является администратором</b>\n\nКанал: <b>${channelName}</b>\n\nДобавьте бота в канал с правами администратора и попробуйте снова`,
            {
              parse_mode: 'HTML',
              reply_markup:
                AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
            },
          );
          return;
        }

        try {
          await this.settingsService.addInsufficientFundsChannel(
            channelId,
            channelName,
          );

          const channels =
            await this.settingsService.getInsufficientFundsChannels();

          let text =
            '<b>⚠️ Каналы для уведомлений о недостатке средств</b>\n\n';

          if (channels.length > 0) {
            text += '<b>Активные каналы:</b>\n\n';
            for (const ch of channels) {
              const status = ch.is_active ? '✅' : '❌';
              const name = ch.channel_name || 'Без названия';
              text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
            }
          } else {
            text += '<b>📭 Каналы не добавлены</b>\n\n';
          }

          text +=
            '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

          await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup:
              AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
          });
        } catch (error: any) {
          this.logger.error(
            `Error adding insufficient funds channel: ${error.message}`,
          );
          await ctx.reply(
            `❌ <b>Ошибка при добавлении канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup:
                AdminKeyboard.getInsufficientFundsChannelsMenu().reply_markup,
            },
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Error processing insufficient funds channel: ${error.message}`,
        );
        await ctx.reply(
          `❌ <b>Ошибка при обработке канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
          {
            parse_mode: 'HTML',
          },
        );
      }
      return;
    }

    if (ctx.session.awaitingFraudChannel) {
      ctx.session.awaitingFraudChannel = false;
      const channelId = text.trim();

      if (
        !(
          channelId.startsWith('-100') ||
          channelId.replace(/^-/, '').match(/^\d+$/)
        )
      ) {
        await ctx.reply(
          '❌ <b>Неверный формат ID канала</b>\n\nID должен начинаться с <code>-100</code> или быть числом\nПример: <code>-1001234567890</code>',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Отмена', 'fraud_channels')],
            ]).reply_markup,
          },
        );
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        const chat = await ctx.telegram.getChat(channelId);
        const channelName = (chat as any).title || 'Без названия';

        const botMember = await ctx.telegram.getChatMember(
          channelId,
          ctx.botInfo!.id,
        );
        if (
          botMember.status !== 'administrator' &&
          botMember.status !== 'creator'
        ) {
          await ctx.reply(
            `❌ <b>Бот не является администратором</b>\n\nКанал: <b>${channelName}</b>\n\nДобавьте бота в канал с правами администратора и попробуйте снова`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
            },
          );
          return;
        }

        try {
          await this.settingsService.addFraudChannel(channelId, channelName);

          const channels = await this.settingsService.getFraudChannels();

          let text = '<b>🚨 Каналы для уведомлений о мошенниках</b>\n\n';

          if (channels.length > 0) {
            text += '<b>Активные каналы:</b>\n\n';
            for (const ch of channels) {
              const status = ch.is_active ? '✅' : '❌';
              const name = ch.channel_name || 'Без названия';
              text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
            }
          } else {
            text += '<b>📭 Каналы не добавлены</b>\n\n';
          }

          text +=
            '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

          await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
          });
        } catch (error: any) {
          this.logger.error(`Error adding fraud channel: ${error.message}`);
          await ctx.reply('❌ Ошибка при добавлении канала', {
            reply_markup: AdminKeyboard.getFraudChannelsMenu().reply_markup,
          });
        }
      } catch (error: any) {
        this.logger.error(`Error processing fraud channel: ${error.message}`);
        await ctx.reply(
          `❌ <b>Ошибка при обработке канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
          {
            parse_mode: 'HTML',
          },
        );
      }
      return;
    }

    if (ctx.session.awaitingSalesNotificationMinRub) {
      ctx.session.awaitingSalesNotificationMinRub = false;
      const cleaned = text.trim().replace(/\s/g, '').replace(/,/g, '');
      if (!/^\d+$/.test(cleaned)) {
        await ctx.reply(
          '❌ Введите целое число ≥ 0 (например <code>2500</code> или <code>0</code> для всех покупок)',
          { parse_mode: 'HTML' },
        );
        ctx.session.awaitingSalesNotificationMinRub = true;
        return;
      }
      const value = parseInt(cleaned, 10);

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await this.settingsService.setSalesNotificationMinAmountRub(value);
        const channels = await this.settingsService.getSalesChannels();

        let replyText = `✅ <b>Порог сохранён:</b> ${
          value === 0
            ? 'уведомлять о любой сумме'
            : `от ${value.toLocaleString('ru')} ₽`
        }\n\n<b>📊 Каналы для уведомлений о продажах</b>\n\n`;
        replyText += `<b>Порог:</b> ${
          value === 0
            ? 'уведомлять о <b>любой</b> сумме'
            : `только если сумма заказа в ₽ <b>≥ ${value.toLocaleString('ru')}</b>`
        }\n<i>(сумма в рублях из заказа; для крипто/TON используется пересчёт в ₽ в заказе)</i>\n\n`;

        if (channels.length > 0) {
          replyText += '<b>Активные каналы:</b>\n\n';
          for (const ch of channels) {
            const status = ch.is_active ? '✅' : '❌';
            const name = ch.channel_name || 'Без названия';
            replyText += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
          }
        } else {
          replyText += '<b>📭 Каналы не добавлены</b>\n\n';
        }

        replyText +=
          '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

        await ctx.reply(replyText, {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
        });
      } catch (error: any) {
        this.logger.error(
          `Error setting sales notification min rub: ${error.message}`,
        );
        await ctx.reply('❌ Ошибка сохранения', {
          reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
        });
      }
      return;
    }

    if (ctx.session.awaitingSalesChannel) {
      ctx.session.awaitingSalesChannel = false;
      ctx.session.awaitingSalesNotificationMinRub = false;
      ctx.session.awaitingInsufficientFundsChannel = false;
      const channelId = text.trim();

      if (
        !(
          channelId.startsWith('-100') ||
          channelId.replace(/^-/, '').match(/^\d+$/)
        )
      ) {
        await ctx.reply(
          '❌ <b>Неверный формат ID канала</b>\n\nID должен начинаться с <code>-100</code> или быть числом\nПример: <code>-1001234567890</code>',
          {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
              [Markup.button.callback('❌ Отмена', 'sales_channels')],
            ]).reply_markup,
          },
        );
        return;
      }

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        const chat = await ctx.telegram.getChat(channelId);
        const channelName = (chat as any).title || 'Без названия';

        const botMember = await ctx.telegram.getChatMember(
          channelId,
          ctx.botInfo!.id,
        );
        if (
          botMember.status !== 'administrator' &&
          botMember.status !== 'creator'
        ) {
          await ctx.reply(
            `❌ <b>Бот не является администратором</b>\n\nКанал: <b>${channelName}</b>\n\nДобавьте бота в канал с правами администратора и попробуйте снова`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
            },
          );
          return;
        }

        try {
          await this.settingsService.addSalesChannel(channelId, channelName);

          const channels = await this.settingsService.getSalesChannels();
          const minRub =
            await this.settingsService.getSalesNotificationMinAmountRub();

          let text = '<b>📊 Каналы для уведомлений о продажах</b>\n\n';
          text += `<b>Порог:</b> ${
            minRub === 0
              ? 'уведомлять о <b>любой</b> сумме'
              : `только если сумма заказа в ₽ <b>≥ ${minRub.toLocaleString('ru')}</b>`
          }\n<i>(сумма в рублях из заказа; для крипто/TON используется пересчёт в ₽ в заказе)</i>\n\n`;

          if (channels.length > 0) {
            text += '<b>Активные каналы:</b>\n\n';
            for (const ch of channels) {
              const status = ch.is_active ? '✅' : '❌';
              const name = ch.channel_name || 'Без названия';
              text += `<b>${status} ${name}</b>\n<b>├ ID: <code>${ch.channel_id}</code></b>\n\n`;
            }
          } else {
            text += '<b>📭 Каналы не добавлены</b>\n\n';
          }

          text +=
            '<b>➕ Добавьте бота в канал с правами администратора и отправьте ID канала</b>';

          await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
          });
        } catch (error: any) {
          this.logger.error(`Error adding sales channel: ${error.message}`);
          await ctx.reply(
            `❌ <b>Ошибка при добавлении канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
            },
          );
        }
      } catch (error: any) {
        this.logger.error(`Error processing sales channel: ${error.message}`);
        await ctx.reply(
          `❌ <b>Ошибка при обработке канала</b>\n\nНе удалось получить информацию о канале.\nУбедитесь что:\n• ID канала указан правильно\n• Бот добавлен в канал\n• Бот имеет права администратора\n\nОшибка: <code>${error.message}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getSalesChannelsMenu().reply_markup,
          },
        );
      }
      return;
    }

    if (ctx.session.awaitingPaymentFee) {
      const feeText = text.trim();
      const feeValue = parseFloat(feeText.replace(',', '.'));

      if (isNaN(feeValue) || feeValue < 0 || feeValue > 100) {
        await ctx.reply(
          '❌ Неверное значение. Введите число от 0 до 100 (например: 5.5 или 6.0)',
          {
            reply_markup: AdminKeyboard.getBackToPaymentSystems().reply_markup,
          },
        );
        return;
      }

      const system = ctx.session.paymentFeeSystem;
      if (!system) {
        await ctx.reply('❌ Ошибка: система не выбрана', {
          reply_markup: AdminKeyboard.getBackToPaymentSystems().reply_markup,
        });
        ctx.session.awaitingPaymentFee = false;
        return;
      }

      ctx.session.awaitingPaymentFee = false;
      ctx.session.paymentFeeSystem = undefined;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await this.prisma.paymentFee.upsert({
          where: { payment_system: system },
          update: { fee_percent: feeValue },
          create: {
            payment_system: system,
            fee_percent: feeValue,
          },
        });

        if (system === 'AURAPAY_SBP') {
          await this.prisma.paymentFee.upsert({
            where: { payment_system: 'AURAPAY_CARD' },
            update: { fee_percent: feeValue },
            create: { payment_system: 'AURAPAY_CARD', fee_percent: feeValue },
          });
        }

        const systemName = this.paymentSystemAdminLabel(system);

        await ctx.reply(
          `✅ Комиссия для ${systemName} успешно обновлена до ${feeValue.toFixed(1)}%`,
          {
            reply_markup: AdminKeyboard.getBackToPaymentSystems().reply_markup,
          },
        );
      } catch (error: any) {
        this.logger.error(`Error updating payment fee: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления комиссии', {
          reply_markup: AdminKeyboard.getBackToPaymentSystems().reply_markup,
        });
      }
      return;
    }

    if (ctx.session.awaitingFailoverThreshold) {
      ctx.session.awaitingFailoverThreshold = false;
      const value = parseInt(text.trim(), 10);

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      if (isNaN(value) || value < 1 || value > 20) {
        await ctx.reply('❌ Неверное значение. Введите число от 1 до 20.', {
          reply_markup: AdminKeyboard.getBackToFailover().reply_markup,
        });
        return;
      }

      await this.paymentHealthService.setFailoverThreshold(value);

      const failoverText = await this.buildFailoverText();
      const config = await this.getFailoverConfig();

      await ctx.reply(
        `✅ Порог ошибок установлен: ${value}\n\n${failoverText}`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
        },
      );
      return;
    }

    if (ctx.session.awaitingFailoverCooldown) {
      ctx.session.awaitingFailoverCooldown = false;
      const value = parseInt(text.trim(), 10);

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      if (isNaN(value) || value < 1 || value > 60) {
        await ctx.reply(
          '❌ Неверное значение. Введите число от 1 до 60 минут.',
          { reply_markup: AdminKeyboard.getBackToFailover().reply_markup },
        );
        return;
      }

      await this.paymentHealthService.setFailoverCooldownMinutes(value);

      const failoverText = await this.buildFailoverText();
      const config = await this.getFailoverConfig();

      await ctx.reply(
        `✅ Время до восстановления: ${value} мин\n\n${failoverText}`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getFailoverMenu(config).reply_markup,
        },
      );
      return;
    }

    if (ctx.session.awaitingServiceMarkup) {
      const markupText = text.trim();
      const markupValue = parseFloat(markupText.replace(',', '.'));

      if (isNaN(markupValue) || markupValue < 0 || markupValue > 100) {
        await ctx.reply(
          '❌ Неверное значение. Введите число от 0 до 100 (например: 5.5 или 7.0)',
          {
            reply_markup: AdminKeyboard.getBackToServiceMarkup().reply_markup,
          },
        );
        return;
      }

      const system = ctx.session.serviceMarkupSystem;
      if (!system) {
        await ctx.reply('❌ Ошибка: система не выбрана', {
          reply_markup: AdminKeyboard.getBackToServiceMarkup().reply_markup,
        });
        ctx.session.awaitingServiceMarkup = false;
        return;
      }

      ctx.session.awaitingServiceMarkup = false;
      ctx.session.serviceMarkupSystem = undefined;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await this.prisma.serviceMarkup.upsert({
          where: { payment_system: system },
          update: { markup_percent: markupValue },
          create: {
            payment_system: system,
            markup_percent: markupValue,
          },
        });

        if (system === 'AURAPAY_SBP') {
          await this.prisma.serviceMarkup.upsert({
            where: { payment_system: 'AURAPAY_CARD' },
            update: { markup_percent: markupValue },
            create: {
              payment_system: 'AURAPAY_CARD',
              markup_percent: markupValue,
            },
          });
        }

        const systemName = this.paymentSystemAdminLabel(system);

        await ctx.reply(
          `✅ Наценка для ${systemName} успешно обновлена до ${markupValue.toFixed(1)}%`,
          {
            reply_markup: AdminKeyboard.getBackToServiceMarkup().reply_markup,
          },
        );
      } catch (error: any) {
        this.logger.error(`Error updating service markup: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления наценки', {
          reply_markup: AdminKeyboard.getBackToServiceMarkup().reply_markup,
        });
      }
      return;
    }

    if (ctx.session.awaitingMinTonRate) {
      const rateText = text.trim();
      const rateValue = parseFloat(rateText.replace(',', '.'));

      if (isNaN(rateValue) || rateValue < 0) {
        await ctx.reply(
          '❌ Неверное значение. Введите положительное число (например: 5.5 или 0 для отключения)',
          {
            reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
          },
        );
        return;
      }

      ctx.session.awaitingMinTonRate = false;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await this.settingsService.setMinTonRateUsd(rateValue);

        const statusText =
          rateValue > 0
            ? `✅ Минимальный курс TON установлен на ${rateValue.toFixed(4)} USD`
            : '✅ Защита курса TON отключена';

        await ctx.reply(statusText, {
          reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
        });
      } catch (error: any) {
        this.logger.error(`Error updating min TON rate: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления минимального курса', {
          reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
        });
      }
      return;
    }

    if (ctx.session.awaitingMinUsdtRate) {
      const rateText = text.trim();
      const rateValue = parseFloat(rateText.replace(',', '.'));

      if (isNaN(rateValue) || rateValue < 0) {
        await ctx.reply(
          '❌ Неверное значение. Введите положительное число (например: 95.5 или 0 для отключения)',
          {
            reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
          },
        );
        return;
      }

      ctx.session.awaitingMinUsdtRate = false;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      try {
        await this.settingsService.setMinUsdtRateRub(rateValue);

        const statusText =
          rateValue > 0
            ? `✅ Минимальный курс USDT установлен на ${rateValue.toFixed(2)} RUB`
            : '✅ Защита курса USDT отключена';

        await ctx.reply(statusText, {
          reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
        });
      } catch (error: any) {
        this.logger.error(`Error updating min USDT rate: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления минимального курса', {
          reply_markup: AdminKeyboard.getBackToRateProtection().reply_markup,
        });
      }
      return;
    }

    if (
      ctx.session.awaitingPurchaseLimit &&
      ctx.session.pendingPurchaseLimitField
    ) {
      const field = ctx.session.pendingPurchaseLimitField;
      const value = parseInt(text.trim().replace(/\s/g, ''), 10);

      if (isNaN(value) || value <= 0) {
        await ctx.reply('❌ Введите целое положительное число', {
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        });
        return;
      }

      ctx.session.awaitingPurchaseLimit = false;
      ctx.session.pendingPurchaseLimitField = undefined;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      const labelMap: Record<string, string> = {
        minStars: 'Мин. звёзд',
        maxStars: 'Макс. звёзд',
        minTon: 'Мин. TON',
        maxTon: 'Макс. TON',
        sbpLimitRub: 'Лимит СБП/Карты (₽)',
        sbpLimitStars: 'Макс. звёзд за 1 платёж СБП/Карта',
      };

      try {
        await this.settingsService.setPurchaseLimits({ [field]: value });
        const limits = await this.settingsService.getPurchaseLimits();
        await ctx.reply(
          `✅ ${labelMap[field]} установлен: ${value.toLocaleString('ru')}`,
          {
            reply_markup:
              AdminKeyboard.getPurchaseLimitsMenu(limits).reply_markup,
          },
        );
      } catch (error: any) {
        this.logger.error(`Error updating purchase limit: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления лимита', {
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        });
      }
      return;
    }

    if (
      ctx.session.awaitingFraudAmount &&
      ctx.session.pendingFraudAmountField
    ) {
      const field = ctx.session.pendingFraudAmountField;
      const value = parseInt(text.trim().replace(/\s/g, ''), 10);

      if (isNaN(value) || value < 0) {
        await ctx.reply('❌ Введите целое неотрицательное число (в рублях)', {
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        });
        return;
      }

      ctx.session.awaitingFraudAmount = false;
      ctx.session.pendingFraudAmountField = undefined;

      try {
        await ctx.deleteMessage();
      } catch {}
      try {
        if (ctx.session.lastBotMessageId) {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            ctx.session.lastBotMessageId,
          );
        }
      } catch {}

      const labelMap: Record<string, string> = {
        phoneFraudMinAmount: 'Мин. сумма (разные номера)',
        cardFraudMinAmount: 'Мин. сумма (разные карты)',
        cancellationFraudMinAmount: 'Мин. сумма (отмены)',
      };

      try {
        if (field === 'phoneFraudMinAmount') {
          await this.settingsService.setPhoneFraudMinAmount(value);
        } else if (field === 'cardFraudMinAmount') {
          await this.settingsService.setCardFraudMinAmount(value);
        } else {
          await this.settingsService.setCancellationFraudMinAmount(value);
        }

        const [
          phoneFraudEnabled,
          phoneFraudMinAmount,
          cardFraudEnabled,
          cardFraudMinAmount,
          cancellationFraudEnabled,
          cancellationFraudMinAmount,
        ] = await Promise.all([
          this.settingsService.isPhoneFraudEnabled(),
          this.settingsService.getPhoneFraudMinAmount(),
          this.settingsService.isCardFraudEnabled(),
          this.settingsService.getCardFraudMinAmount(),
          this.settingsService.isCancellationFraudEnabled(),
          this.settingsService.getCancellationFraudMinAmount(),
        ]);

        await ctx.reply(
          `✅ ${labelMap[field]} установлена: ${value.toLocaleString('ru')} ₽`,
          {
            reply_markup: AdminKeyboard.getFraudSettingsMenu({
              phoneFraudEnabled,
              phoneFraudMinAmount,
              cardFraudEnabled,
              cardFraudMinAmount,
              cancellationFraudEnabled,
              cancellationFraudMinAmount,
            }).reply_markup,
          },
        );
      } catch (error: any) {
        this.logger.error(`Error updating fraud amount: ${error.message}`);
        await ctx.reply('❌ Ошибка обновления настройки', {
          reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
        });
      }
      return;
    }
  }

  @On('photo')
  async onPhotoMessage(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session.awaitingBroadcast) return;
    if (!(await this.checkAccess(ctx))) return;
    if (!ctx.session.awaitingBroadcast) return;

    const message = ctx.message as any;
    const photo = message?.photo;
    const caption = message?.caption || '';
    const entities = message?.caption_entities || [];

    if (!photo || photo.length === 0) return;

    const fileId = photo[photo.length - 1].file_id;

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const photoBuffer = Buffer.from(await response.arrayBuffer());

      ctx.session.broadcastPhoto = photoBuffer.toString('base64');
      ctx.session.broadcastPhotoFileId = fileId;
    } catch {
      await ctx.reply('❌ Ошибка загрузки фото. Попробуйте еще раз.', {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
      return;
    }

    ctx.session.broadcastCaption = caption;
    ctx.session.broadcastCaptionEntities = entities;
    ctx.session.awaitingBroadcast = false;
    ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplatesPhoto = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const sentMessage = await ctx.telegram.sendPhoto(
      ctx.chat!.id,
      ctx.session.broadcastPhotoFileId!,
      {
        caption: caption,
        caption_entities: entities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplatesPhoto,
        ),
      },
    );

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @On('animation')
  async onAnimationMessage(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session.awaitingBroadcast) return;
    if (!(await this.checkAccess(ctx))) return;
    if (!ctx.session.awaitingBroadcast) return;

    const message = ctx.message as any;
    const animation = message?.animation;
    const caption = message?.caption || '';
    const entities = message?.caption_entities || [];

    if (!animation) return;

    const fileId = animation.file_id;

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const animBuffer = Buffer.from(await response.arrayBuffer());

      ctx.session.broadcastAnimation = animBuffer.toString('base64');
      ctx.session.broadcastAnimationFileId = fileId;
    } catch {
      await ctx.reply('❌ Ошибка загрузки GIF. Попробуйте еще раз.', {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
      return;
    }

    ctx.session.broadcastCaption = caption;
    ctx.session.broadcastCaptionEntities = entities;
    ctx.session.awaitingBroadcast = false;
    ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplatesAnim = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const sentMessage = await ctx.telegram.sendAnimation(
      ctx.chat!.id,
      ctx.session.broadcastAnimationFileId!,
      {
        caption: caption,
        caption_entities: entities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplatesAnim,
        ),
      },
    );

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @On('video')
  async onVideoMessage(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session.awaitingBroadcast) return;
    if (!(await this.checkAccess(ctx))) return;
    if (!ctx.session.awaitingBroadcast) return;

    const message = ctx.message as any;
    const video = message?.video;
    const caption = message?.caption || '';
    const entities = message?.caption_entities || [];

    if (!video) return;

    const fileId = video.file_id;

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const videoBuffer = Buffer.from(await response.arrayBuffer());

      ctx.session.broadcastVideo = videoBuffer.toString('base64');
      ctx.session.broadcastVideoFileId = fileId;
    } catch {
      await ctx.reply('❌ Ошибка загрузки видео. Попробуйте еще раз.', {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
      return;
    }

    ctx.session.broadcastCaption = caption;
    ctx.session.broadcastCaptionEntities = entities;
    ctx.session.awaitingBroadcast = false;
    ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplatesVideo = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const sentMessage = await ctx.telegram.sendVideo(
      ctx.chat!.id,
      ctx.session.broadcastVideoFileId!,
      {
        caption: caption,
        caption_entities: entities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplatesVideo,
        ),
      },
    );

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @On('sticker')
  async onStickerMessage(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session.awaitingBroadcast) return;
    if (!(await this.checkAccess(ctx))) return;
    if (!ctx.session.awaitingBroadcast) return;

    const message = ctx.message as any;
    const sticker = message?.sticker;

    if (!sticker) return;

    const fileId = sticker.file_id;

    ctx.session.broadcastSticker = fileId;
    ctx.session.broadcastStickerFileId = fileId;
    ctx.session.broadcastMessage = '';
    ctx.session.awaitingBroadcast = false;
    ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplates = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const sentMessage = await ctx.telegram.sendSticker(ctx.chat!.id, fileId, {
      ...AdminKeyboard.getBroadcastButtonsMenu(
        ctx.session.broadcastButtons,
        hasTemplates,
      ),
    } as any);

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @On('audio')
  async onAudioMessage(@Ctx() ctx: BotContext): Promise<void> {
    if (!ctx.session.awaitingBroadcast) return;
    if (!(await this.checkAccess(ctx))) return;
    if (!ctx.session.awaitingBroadcast) return;

    const message = ctx.message as any;
    const audio = message?.audio;
    const caption = message?.caption || '';
    const entities = message?.caption_entities || [];

    if (!audio) return;

    const fileId = audio.file_id;

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.href);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      ctx.session.broadcastAudio = audioBuffer.toString('base64');
      ctx.session.broadcastAudioFileId = fileId;
    } catch {
      await ctx.reply('❌ Ошибка загрузки аудио. Попробуйте еще раз.', {
        reply_markup: AdminKeyboard.getBackToAdmin().reply_markup,
      });
      return;
    }

    ctx.session.broadcastCaption = caption;
    ctx.session.broadcastCaptionEntities = entities;
    ctx.session.awaitingBroadcast = false;
    ctx.session.broadcastButtons = ctx.session.broadcastButtons || [];

    try {
      if (ctx.session.lastBotMessageId) {
        await ctx.telegram.deleteMessage(
          ctx.chat!.id,
          ctx.session.lastBotMessageId,
        );
      }
    } catch {}

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplates = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const sentMessage = await ctx.telegram.sendAudio(
      ctx.chat!.id,
      ctx.session.broadcastAudioFileId!,
      {
        caption: caption,
        caption_entities: entities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplates,
        ),
      },
    );

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  @Action('btn_tpl_list')
  async btnTplList(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    ctx.session.awaitingButtonTemplateName = false;
    ctx.session.pendingButtonTemplateButtons = undefined;
    ctx.session.awaitingBroadcastButton = false;

    try {
      await ctx.deleteMessage();
    } catch {}

    const templates = await this.prisma.buttonTemplate.findMany({
      orderBy: { created_at: 'desc' },
    });

    const tplData = templates.map((t) => ({
      id: t.id,
      name: t.name,
      buttons: (t.buttons as any[]) || [],
    }));

    await ctx.reply(
      `📋 <b>Шаблоны кнопок</b>\n\nВсего шаблонов: ${templates.length}\n\nШаблоны позволяют быстро добавлять готовые наборы кнопок в рассылки.`,
      {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getButtonTemplatesMenu(tplData).reply_markup,
      },
    );
  }

  @Action('btn_tpl_create')
  async btnTplCreate(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    try {
      await ctx.deleteMessage();
    } catch {}

    ctx.session.awaitingBroadcastButton = true;
    ctx.session.pendingButtonTemplateButtons = [];
    ctx.session.awaitingButtonTemplateName = false;
    ctx.session.buttonTemplateEditId = undefined;

    const msg = await ctx.reply(
      `📋 <b>Создание шаблона кнопок</b>\n\n` +
        `Добавьте кнопки для шаблона.\n` +
        `Формат: <code>Текст кнопки - https://ссылка.ru</code>\n\n` +
        `<i>Например: ⭐️КУПИТЬ STARS⭐️ - https://t.me/MopsStarsBot?start=stars</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBroadcastButtonsMenu([], false)
          .reply_markup,
      },
    );
    ctx.session.lastBotMessageId = msg.message_id;
  }

  @Action(/btn_tpl_view_(.+)/)
  async btnTplView(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const templateId = (ctx.match as any)?.[1];
    if (!templateId) return;

    try {
      await ctx.deleteMessage();
    } catch {}

    const template = await this.prisma.buttonTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      await ctx.reply('❌ Шаблон не найден');
      return;
    }

    const buttons =
      (template.buttons as Array<{ text: string; url: string }>) || [];
    let buttonsText = buttons
      .map((b, i) => `${i + 1}. ${b.text} → ${b.url}`)
      .join('\n');

    await ctx.reply(
      `📋 <b>${template.name}</b>\n\n` +
        `Кнопок: ${buttons.length}\n\n` +
        (buttonsText ? `<b>Кнопки:</b>\n${buttonsText}` : ''),
      {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getButtonTemplateDetailMenu(templateId).reply_markup,
      },
    );
  }

  @Action(/btn_tpl_delete_(.+)/)
  async btnTplDelete(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const templateId = (ctx.match as any)?.[1];
    if (!templateId) return;

    try {
      await this.prisma.buttonTemplate.delete({ where: { id: templateId } });
    } catch {
      await ctx.answerCbQuery('❌ Ошибка удаления');
      return;
    }

    try {
      await ctx.deleteMessage();
    } catch {}

    const templates = await this.prisma.buttonTemplate.findMany({
      orderBy: { created_at: 'desc' },
    });

    const tplData = templates.map((t) => ({
      id: t.id,
      name: t.name,
      buttons: (t.buttons as any[]) || [],
    }));

    await ctx.reply(
      `✅ Шаблон удалён.\n\n📋 <b>Шаблоны кнопок</b>\n\nВсего шаблонов: ${templates.length}`,
      {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getButtonTemplatesMenu(tplData).reply_markup,
      },
    );
  }

  @Action('broadcast_add_from_template')
  async broadcastAddFromTemplate(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const templates = await this.prisma.buttonTemplate.findMany({
      orderBy: { created_at: 'desc' },
    });

    if (templates.length === 0) {
      await ctx.answerCbQuery('❌ Нет доступных шаблонов');
      return;
    }

    try {
      await ctx.deleteMessage();
    } catch {}

    const tplData = templates.map((t) => ({
      id: t.id,
      name: t.name,
      buttons: (t.buttons as any[]) || [],
    }));

    await ctx.reply(
      `📋 <b>Выберите шаблон кнопок</b>\n\nВыбранные кнопки будут добавлены к рассылке:`,
      {
        parse_mode: 'HTML',
        reply_markup:
          AdminKeyboard.getBroadcastSelectTemplateMenu(tplData).reply_markup,
      },
    );
  }

  @Action(/broadcast_use_template_(.+)/)
  async broadcastUseTemplate(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});

    const templateId = (ctx.match as any)?.[1];
    if (!templateId) return;

    const template = await this.prisma.buttonTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      await ctx.answerCbQuery('❌ Шаблон не найден');
      return;
    }

    const tplButtons =
      (template.buttons as Array<{ text: string; url: string }>) || [];

    if (!ctx.session.broadcastButtons) {
      ctx.session.broadcastButtons = [];
    }

    const available = 10 - ctx.session.broadcastButtons.length;
    const toAdd = tplButtons.slice(0, available);
    ctx.session.broadcastButtons.push(...toAdd);

    try {
      await ctx.deleteMessage();
    } catch {}

    const hasTemplates = await this.prisma.buttonTemplate
      .count()
      .then((c) => c > 0)
      .catch(() => false);

    const previewText =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption || '';
    const previewEntities =
      ctx.session.broadcastEntities || ctx.session.broadcastCaptionEntities;

    let sentMessage: any;
    if (ctx.session.broadcastPhotoFileId) {
      sentMessage = await ctx.telegram.sendPhoto(
        ctx.chat!.id,
        ctx.session.broadcastPhotoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
            hasTemplates,
          ),
        },
      );
    } else if (ctx.session.broadcastAnimationFileId) {
      sentMessage = await ctx.telegram.sendAnimation(
        ctx.chat!.id,
        ctx.session.broadcastAnimationFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
            hasTemplates,
          ),
        },
      );
    } else if (ctx.session.broadcastVideoFileId) {
      sentMessage = await ctx.telegram.sendVideo(
        ctx.chat!.id,
        ctx.session.broadcastVideoFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
            hasTemplates,
          ),
        },
      );
    } else if (ctx.session.broadcastStickerFileId) {
      sentMessage = await ctx.telegram.sendSticker(
        ctx.chat!.id,
        ctx.session.broadcastStickerFileId,
        {
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
            hasTemplates,
          ),
        } as any,
      );
    } else if (ctx.session.broadcastAudioFileId) {
      sentMessage = await ctx.telegram.sendAudio(
        ctx.chat!.id,
        ctx.session.broadcastAudioFileId,
        {
          caption: previewText,
          caption_entities: previewEntities,
          ...AdminKeyboard.getBroadcastButtonsMenu(
            ctx.session.broadcastButtons,
            hasTemplates,
          ),
        },
      );
    } else {
      sentMessage = await ctx.telegram.sendMessage(ctx.chat!.id, previewText, {
        entities: previewEntities,
        ...AdminKeyboard.getBroadcastButtonsMenu(
          ctx.session.broadcastButtons,
          hasTemplates,
        ),
      });
    }

    ctx.session.broadcastMessageId = sentMessage.message_id;
    ctx.session.broadcastFromChatId = ctx.chat!.id.toString();
  }

  private async handlePaymentSearch(
    ctx: BotContext,
    query: string,
    isUserPurchasesSearch: boolean = false,
  ): Promise<void> {
    ctx.session.fromAdminSearch = !isUserPurchasesSearch;

    try {
      let payments: any[] = [];

      const cleanQuery = query.trim().replace('@', '').replace('#', '');

      if (isUserPurchasesSearch) {
        let user = null;
        if (/^\d+$/.test(cleanQuery)) {
          user = await this.prisma.user.findUnique({
            where: { telegram_id: cleanQuery },
          });
        }

        if (!user) {
          user = await this.prisma.user.findFirst({
            where: { username: cleanQuery },
          });
        }

        if (user) {
          payments = await this.prisma.payment.findMany({
            where: {
              user_id: user.id,
            },
            include: {
              user: true,
              fragment_queue: true,
            },
            orderBy: { created_at: 'desc' },
            take: 500,
          });
        }
      } else {
        let payment = await this.prisma.payment.findUnique({
          where: { id: cleanQuery },
          include: {
            user: true,
            fragment_queue: true,
          },
        });

        if (!payment) {
          if (/^\d+$/.test(cleanQuery)) {
            const orderNumber = parseInt(cleanQuery, 10);

            if (orderNumber <= 2147483647) {
              payment = await this.prisma.payment.findUnique({
                where: { order_number: orderNumber },
                include: {
                  user: true,
                  fragment_queue: true,
                },
              });
            }
          }
        }

        if (!payment) {
          payment = await this.prisma.payment.findFirst({
            where: { external_payment_id: cleanQuery },
            include: {
              user: true,
              fragment_queue: true,
            },
          });
        }

        if (!payment) {
          payment = await this.prisma.payment.findFirst({
            where: { provider_transaction_id: cleanQuery },
            include: {
              user: true,
              fragment_queue: true,
            },
          });
        }

        if (!payment) {
          if (/^[0-9a-fA-F]{64}$/i.test(cleanQuery)) {
            try {
              const buffer = Buffer.from(cleanQuery, 'hex');
              const base64 = buffer.toString('base64');
              payment = await this.prisma.payment.findFirst({
                where: { provider_transaction_id: base64 },
                include: {
                  user: true,
                  fragment_queue: true,
                },
              });
            } catch (e) {}
          }
        }

        if (!payment) {
          try {
            const cleanTxid = cleanQuery.replace(/\s/g, '');
            const buffer = Buffer.from(cleanTxid, 'base64');
            const hex = buffer.toString('hex');
            if (hex.length >= 32) {
              const allPayments = await this.prisma.payment.findMany({
                where: {
                  payment_method: 'TON',
                  provider_transaction_id: { not: null },
                },
                include: {
                  user: true,
                  fragment_queue: true,
                },
                orderBy: { created_at: 'desc' },
                take: 200,
              });

              for (const p of allPayments) {
                if (!p.provider_transaction_id) continue;
                try {
                  const pBuffer = Buffer.from(
                    p.provider_transaction_id.trim(),
                    'base64',
                  );
                  const pHex = pBuffer.toString('hex');
                  if (pHex.toLowerCase() === hex.toLowerCase()) {
                    payment = p;
                    break;
                  }
                } catch {}
              }
            }
          } catch (e) {}
        }

        if (!payment) {
          if (/^\d+$/.test(cleanQuery)) {
            const user = await this.prisma.user.findUnique({
              where: { telegram_id: cleanQuery },
            });
            if (user) {
              payments = await this.prisma.payment.findMany({
                where: { user_id: user.id },
                include: {
                  user: true,
                  fragment_queue: true,
                },
                orderBy: { created_at: 'desc' },
                take: 500,
              });
            }
          }
        }

        if (!payment) {
          const queueItem = await this.prisma.fragmentQueue.findFirst({
            where: { ton_comment: cleanQuery },
            include: {
              payment: {
                include: {
                  user: true,
                  fragment_queue: true,
                },
              },
            },
          });
          if (queueItem?.payment) {
            payment = queueItem.payment;
          }
        }

        if (!payment) {
          const queueItemByTxHash = await this.prisma.fragmentQueue.findFirst({
            where: { tx_hash: cleanQuery },
            include: {
              payment: {
                include: {
                  user: true,
                  fragment_queue: true,
                },
              },
            },
          });
          if (queueItemByTxHash?.payment) {
            payment = queueItemByTxHash.payment;
          }
        }

        if (!payment && payments.length === 0) {
          const userByUsername = await this.prisma.user.findFirst({
            where: { username: cleanQuery },
          });

          payments = await this.prisma.payment.findMany({
            where: {
              OR: [
                { recipient_username: cleanQuery },
                { recipient_username: { contains: cleanQuery } },
                ...(userByUsername ? [{ user_id: userByUsername.id }] : []),
              ],
            },
            include: {
              user: true,
              fragment_queue: true,
            },
            orderBy: { created_at: 'desc' },
            take: 50,
          });
        } else if (payment) {
          payments = [payment];
        }
      }

      if (payments.length === 0) {
        const text = `
❌ <b>Платеж не найден</b>

По запросу <code>${query}</code> платеж не найден.
Попробуйте другой параметр поиска.
`;

        await ctx.reply(text, {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getBackToSearch().reply_markup,
        });
        return;
      }

      if (payments.length === 1) {
        const payment = payments[0];
        await this.showAdminPaymentDetails(ctx, payment.id);
        return;
      }

      ctx.session.searchResults = payments;
      ctx.session.currentPage = 0;
      ctx.session.searchQuery = query;

      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.ceil(payments.length / ITEMS_PER_PAGE);

      const text = `
🔍 <b>Найдено платежей: ${payments.length}</b>

Запрос: <code>${query}</code>
Страница 1 из ${totalPages}
Выберите платёж для просмотра информации о нем:
`;

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getSearchResultsMenu(
          payments,
          0,
          totalPages,
        ).reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error searching payment: ${error.message}`);
      await ctx.reply('❌ Ошибка поиска платежа', {
        reply_markup: AdminKeyboard.getBackToSearch().reply_markup,
      });
    }
  }

  private async handleBlockUser(ctx: BotContext, query: string): Promise<void> {
    try {
      const cleanQuery = query.replace('@', '').trim();
      const targetUser =
        await this.userService.findUserByIdOrUsername(cleanQuery);

      if (!targetUser) {
        if (/^[a-zA-Z0-9_]+$/.test(cleanQuery)) {
          await this.userService.addBannedUsername(cleanQuery);
          await ctx.reply(
            `✅ Username <b>@${cleanQuery}</b> добавлен в список заблокированных\n\n` +
              `ℹ️ Этот пользователь не сможет получать покупки, даже если он еще не использовал бота`,
            {
              parse_mode: 'HTML',
              reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
            },
          );
        } else {
          await ctx.reply('❌ Пользователь не найден', {
            reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
          });
        }
        return;
      }

      if (targetUser.is_ban) {
        await ctx.reply(
          `⚠️ Пользователь ${targetUser.telegram_id} уже заблокирован`,
          {
            reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
          },
        );
        return;
      }

      await this.userService.blockUser(targetUser.telegram_id);

      if (targetUser.username) {
        await this.userService.addBannedUsername(targetUser.username);
      }

      const userInfo = targetUser.username
        ? `@${targetUser.username} (${targetUser.telegram_id})`
        : targetUser.telegram_id;

      await ctx.reply(`✅ Пользователь <b>${userInfo}</b> заблокирован`, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error blocking user: ${error.message}`);
      await ctx.reply('❌ Ошибка блокировки пользователя', {
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    }
  }

  private async handleUnblockUser(
    ctx: BotContext,
    query: string,
  ): Promise<void> {
    try {
      const cleanQuery = query.replace('@', '').trim();
      const targetUser =
        await this.userService.findUserByIdOrUsername(cleanQuery);

      if (!targetUser) {
        if (/^[a-zA-Z0-9_]+$/.test(cleanQuery)) {
          const isBanned = await this.userService.isUsernameBanned(cleanQuery);
          if (isBanned) {
            await this.userService.removeBannedUsername(cleanQuery);
            await ctx.reply(
              `✅ Username <b>@${cleanQuery}</b> удален из списка заблокированных`,
              {
                parse_mode: 'HTML',
                reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
              },
            );
            return;
          }
        }

        await ctx.reply('❌ Пользователь не найден', {
          reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
        });
        return;
      }

      if (!targetUser.is_ban) {
        await ctx.reply(
          `ℹ️ Пользователь ${targetUser.telegram_id} не заблокирован`,
          {
            reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
          },
        );
        return;
      }

      await this.userService.unblockUser(targetUser.telegram_id);

      if (targetUser.username) {
        await this.userService.removeBannedUsername(targetUser.username);
      }

      const userInfo = targetUser.username
        ? `@${targetUser.username} (${targetUser.telegram_id})`
        : targetUser.telegram_id;

      await ctx.reply(`✅ Пользователь <b>${userInfo}</b> разблокирован`, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error unblocking user: ${error.message}`);
      await ctx.reply('❌ Ошибка разблокировки пользователя', {
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    }
  }

  private async handleMassBlock(ctx: BotContext, query: string): Promise<void> {
    try {
      const identifiers = query
        .split(/[,\n]/)
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      if (identifiers.length === 0) {
        await ctx.reply('❌ Не указаны пользователи для блокировки', {
          reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
        });
        return;
      }

      let blocked = 0;
      let alreadyBlocked = 0;
      let preemptivelyBlocked = 0;
      const errors: string[] = [];

      await ctx.reply('⏳ Обработка массовой блокировки...');

      for (const identifier of identifiers) {
        try {
          const cleanIdentifier = identifier.replace('@', '').trim();
          const targetUser =
            await this.userService.findUserByIdOrUsername(cleanIdentifier);

          if (!targetUser) {
            if (/^[a-zA-Z0-9_]+$/.test(cleanIdentifier)) {
              await this.userService.addBannedUsername(cleanIdentifier);
              preemptivelyBlocked++;
            }
            continue;
          }

          if (targetUser.is_ban) {
            alreadyBlocked++;
            continue;
          }

          await this.userService.blockUser(targetUser.telegram_id);

          if (targetUser.username) {
            await this.userService.addBannedUsername(targetUser.username);
          }

          blocked++;
        } catch (error: any) {
          errors.push(`${identifier}: ${error.message}`);
        }
      }

      const resultText = `
✅ <b>Массовая блокировка завершена</b>

🚫 Заблокировано: <b>${blocked}</b>
🔒 Добавлено в предварительную блокировку: <b>${preemptivelyBlocked}</b>
⚠️ Уже были заблокированы: <b>${alreadyBlocked}</b>
📊 Всего обработано: <b>${identifiers.length}</b>
${errors.length > 0 ? `\n❌ Ошибки: ${errors.length}` : ''}
`;

      await ctx.reply(resultText, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error in mass block: ${error.message}`);
      await ctx.reply('❌ Ошибка массовой блокировки', {
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    }
  }

  private async handleCaptchaUnban(
    ctx: BotContext,
    query: string,
  ): Promise<void> {
    try {
      const cleanQuery = query.replace('@', '').trim();
      const targetUser =
        await this.userService.findUserByIdOrUsername(cleanQuery);

      if (!targetUser) {
        await ctx.reply('❌ Пользователь не найден', {
          reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
        });
        return;
      }

      if (!targetUser.is_captcha_banned) {
        const userInfo = targetUser.username
          ? `@${targetUser.username} (${targetUser.telegram_id})`
          : targetUser.telegram_id;

        await ctx.reply(
          `ℹ️ У пользователя <b>${userInfo}</b> нет ограничений по капче`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
          },
        );
        return;
      }

      await this.userService.liftCaptchaBan(targetUser.telegram_id);

      const userInfo = targetUser.username
        ? `@${targetUser.username} (${targetUser.telegram_id})`
        : targetUser.telegram_id;

      await ctx.reply(
        `✅ Ограничения капчи для пользователя <b>${userInfo}</b> сняты\n\n` +
          `Пользователь снова сможет совершать покупки.`,
        {
          parse_mode: 'HTML',
          reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error lifting captcha ban: ${error.message}`);
      await ctx.reply('❌ Ошибка снятия ограничений капчи', {
        reply_markup: AdminKeyboard.getBackToBlocking().reply_markup,
      });
    }
  }

  private async showFraudList(
    ctx: BotContext,
    page: number = 0,
  ): Promise<void> {
    try {
      const fraudsters = await this.fraudService.getFraudList();

      if (fraudsters.length === 0) {
        await ctx.reply(
          '📋 <b>Список мошенников пуст</b>\n\nНикто еще не добавлен в список.',
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
          },
        );
        return;
      }

      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.ceil(fraudsters.length / ITEMS_PER_PAGE);

      if (page >= totalPages) {
        page = totalPages - 1;
      }
      if (page < 0) {
        page = 0;
      }

      ctx.session.fraudList = fraudsters;
      ctx.session.fraudCurrentPage = page;

      const text = `
🕵️ <b>Список мошенников</b>

Всего в списке: <b>${fraudsters.length}</b>

Нажмите на пользователя, чтобы удалить его из списка:
`;

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: AdminKeyboard.getFraudListMenu(
          fraudsters,
          page,
          totalPages,
        ).reply_markup,
      });
    } catch (error: any) {
      this.logger.error(`Error showing fraud list: ${error.message}`);
      await ctx.reply('❌ Ошибка загрузки списка мошенников', {
        reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
      });
    }
  }

  private async handleAddFraudUser(
    ctx: BotContext,
    query: string,
  ): Promise<void> {
    try {
      const userInfo = await this.fraudService.findByIdentifier(query);

      if (!userInfo) {
        await ctx.reply('❌ Не удалось определить пользователя', {
          reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
        });
        return;
      }

      const adminId = ctx.from?.id.toString() || 'unknown';
      const result = await this.fraudService.addToFraudList({
        telegram_id: userInfo.telegram_id,
        username: userInfo.username,
        added_by: adminId,
      });

      if (result.success) {
        const identifier = userInfo.telegram_id
          ? `ID: ${userInfo.telegram_id}`
          : userInfo.username
            ? `@${userInfo.username}`
            : 'Неизвестен';

        await ctx.reply(
          `✅ <b>Пользователь добавлен в список мошенников</b>\n\n${identifier}\n\n` +
            `ℹ️ Теперь его платежи будут приниматься, но товар не будет доставляться.`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
          },
        );
      } else {
        await ctx.reply(`❌ ${result.message}`, {
          reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error adding fraud user: ${error.message}`);
      await ctx.reply('❌ Ошибка добавления пользователя', {
        reply_markup: AdminKeyboard.getBackToFraud().reply_markup,
      });
    }
  }

  private async handleRemoveFraud(
    ctx: BotContext,
    fraudId: string,
  ): Promise<void> {
    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      const result = await this.fraudService.removeFromFraudList(fraudId);

      if (result.success) {
        await ctx.reply(`✅ ${result.message}`, {
          reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
        });
      } else {
        await ctx.reply(`❌ ${result.message}`, {
          reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error removing fraud: ${error.message}`);
      await ctx.reply('❌ Ошибка удаления из списка', {
        reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
      });
    }
  }

  private async handleFraudUnban(
    ctx: BotContext,
    input: string,
  ): Promise<void> {
    try {
      const identifier = input.replace('@', '').trim();
      if (!identifier) {
        await ctx.reply('❌ Введите ID или @username', {
          reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
        });
        return;
      }

      const isNumeric = /^\d+$/.test(identifier);
      const entry = await this.prisma.fraudList.findFirst({
        where: isNumeric
          ? { telegram_id: identifier }
          : { username: identifier },
      });

      if (!entry) {
        await ctx.reply(
          `❌ Пользователь <code>${input}</code> не найден в списке мошенников`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
          },
        );
        return;
      }

      const result = await this.fraudService.removeFromFraudList(entry.id);

      if (result.success) {
        const who = entry.telegram_id
          ? `ID: <code>${entry.telegram_id}</code>`
          : `@${entry.username}`;
        await ctx.reply(
          `✅ ${who} удалён из списка мошенников и добавлен в белый список`,
          {
            parse_mode: 'HTML',
            reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
          },
        );
      } else {
        await ctx.reply(`❌ ${result.message}`, {
          reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error unbanning fraud user: ${error.message}`);
      await ctx.reply('❌ Ошибка удаления из списка', {
        reply_markup: AdminKeyboard.getFraudMenu().reply_markup,
      });
    }
  }


  @Action('fragment_accounts')
  async onFragmentAccounts(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    await this.showFragmentAccountsList(ctx);
  }

  private async showFragmentAccountsList(ctx: BotContext): Promise<void> {
    try {
      const accounts = await this.fragmentAccountService.getAllAccounts();

      const activeCount = accounts.filter((a) => a.is_active).length;
      const totalCount = accounts.length;

      let message = `🧩 <b>Fragment аккаунты</b>\n\n`;
      message += `📊 Всего: ${totalCount} | Активных: ${activeCount}\n\n`;

      if (accounts.length === 0) {
        message += `❌ Нет аккаунтов. Добавьте первый аккаунт.`;
      } else {
        message += `Выберите аккаунт для управления:`;
      }

      const keyboard = AdminKeyboard.getFragmentAccountsMenu(accounts);

      try {
        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
      } catch {
        await ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error showing fragment accounts: ${error.message}`);
      await ctx.reply('❌ Ошибка при загрузке аккаунтов');
    }
  }

  @Action('frag_acc_check_all')
  async onFragmentAccountCheckAll(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accounts = await this.fragmentAccountService.getAllAccounts();

    if (accounts.length === 0) {
      try {
        await ctx.editMessageText('❌ Нет аккаунтов для проверки', {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'fragment_accounts')],
          ]).reply_markup,
        });
      } catch {
        await ctx.reply('❌ Нет аккаунтов для проверки');
      }
      return;
    }

    let statusMsg = '🔍 <b>Проверка аккаунтов Fragment...</b>\n\n';
    for (const acc of accounts) {
      statusMsg += `${acc.is_active ? '🟢' : '🔴'} ${escapeHtml(acc.name)} — ⏳ проверяется...\n`;
    }

    let msgId: number | undefined;
    try {
      const sent = await ctx.editMessageText(statusMsg, {
        parse_mode: 'HTML',
        reply_markup: undefined,
      });
      msgId =
        typeof sent === 'object' && 'message_id' in sent
          ? sent.message_id
          : undefined;
    } catch {
      const sent = await ctx.reply(statusMsg, { parse_mode: 'HTML' });
      msgId = sent.message_id;
    }

    const results: Array<{
      name: string;
      is_active: boolean;
      alive: boolean;
      error?: string;
    }> = [];

    for (const acc of accounts) {
      if (!acc.is_active) {
        results.push({
          name: acc.name,
          is_active: false,
          alive: false,
          error: 'Отключён',
        });
        continue;
      }

      const creds = await this.fragmentAccountService.getAccountById(acc.id);
      if (!creds) {
        results.push({
          name: acc.name,
          is_active: true,
          alive: false,
          error: 'Не найден в кэше',
        });
        continue;
      }

      const health = await this.fragmentService.checkAccountHealth(creds);
      results.push({
        name: acc.name,
        is_active: true,
        alive: health.alive,
        error: health.error,
      });
    }

    const aliveCount = results.filter((r) => r.alive).length;
    const deadCount = results.filter((r) => r.is_active && !r.alive).length;
    const disabledCount = results.filter((r) => !r.is_active).length;

    let resultMsg = `🔍 <b>Результаты проверки аккаунтов Fragment</b>\n\n`;
    resultMsg += `✅ Живых: ${aliveCount} | ❌ Мёртвых: ${deadCount} | ⚫️ Отключённых: ${disabledCount}\n\n`;

    for (const r of results) {
      if (!r.is_active) {
        resultMsg += `⚫️ ${escapeHtml(r.name)} — отключён\n`;
      } else if (r.alive) {
        resultMsg += `✅ ${escapeHtml(r.name)} — живой\n`;
      } else {
        const errText = r.error ? ` <i>(${escapeHtml(r.error)})</i>` : '';
        resultMsg += `❌ ${escapeHtml(r.name)} — мёртвый${errText}\n`;
      }
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 К списку аккаунтов', 'fragment_accounts')],
    ]);

    try {
      if (msgId) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          msgId,
          undefined,
          resultMsg,
          { parse_mode: 'HTML', reply_markup: keyboard.reply_markup },
        );
      } else {
        await ctx.reply(resultMsg, {
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch {
      await ctx.reply(resultMsg, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
      });
    }
  }

  @Action(
    /^frag_acc_(?!add|toggle_|delete_|update_|confirm_delete_|check_all)(.+)$/,
  )
  async onFragmentAccountDetail(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accountId = (ctx.match as RegExpExecArray)?.[1];
    if (!accountId) return;

    try {
      const accounts = await this.fragmentAccountService.getAllAccounts();
      const account = accounts.find((a) => a.id === accountId);

      if (!account) {
        await ctx.editMessageText('❌ Аккаунт не найден', {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'fragment_accounts')],
          ]).reply_markup,
        });
        return;
      }

      const statusIcon = account.is_active ? '🟢 Активен' : '🔴 Отключен';
      const createdAt = toMoscowTime(account.created_at).toLocaleDateString(
        'ru-RU',
      );

      let message = `🧩 <b>Fragment аккаунт</b>\n\n`;
      message += `📛 <b>Название:</b> ${escapeHtml(account.name)}\n`;
      message += `📊 <b>Статус:</b> ${statusIcon}\n`;
      message += `📦 <b>В очереди:</b> ${account.queue_count}\n`;
      message += `📅 <b>Добавлен:</b> ${createdAt}\n`;
      message += `\n🆔 <code>${account.id}</code>`;

      const keyboard = AdminKeyboard.getFragmentAccountDetail(
        account.id,
        account.is_active,
      );

      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
      });
    } catch (error: any) {
      this.logger.error(
        `Error showing fragment account detail: ${error.message}`,
      );
    }
  }

  @Action('frag_acc_add')
  async onFragmentAccountAdd(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    ctx.session.awaitingFragmentAccountName = true;

    await ctx.editMessageText(
      `➕ <b>Добавление Fragment аккаунта</b>\n\nВведите название для аккаунта (например: "Аккаунт 1"):`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отмена', 'fragment_accounts')],
        ]).reply_markup,
      },
    );
  }

  private async handleFragmentAccountNameInput(
    ctx: BotContext,
    name: string,
  ): Promise<void> {
    ctx.session.awaitingFragmentAccountName = false;
    ctx.session.pendingFragmentAccountName = name;
    ctx.session.awaitingFragmentAccountTokens = true;

    try {
      await ctx.deleteMessage();
    } catch {}

    await ctx.reply(
      `📛 Название: <b>${escapeHtml(name)}</b>\n\n` +
        `Теперь введите токены в формате (каждый на новой строке):\n\n` +
        `<code>stel_ssid\nstel_token\nstel_ton_token</code>\n\n` +
        `⚠️ Скопируйте cookies из Fragment аккаунта.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отмена', 'fragment_accounts')],
        ]).reply_markup,
      },
    );
  }

  private async handleFragmentAccountTokensInput(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    ctx.session.awaitingFragmentAccountTokens = false;

    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length !== 3) {
      await ctx.reply(
        '❌ Неверный формат. Нужно 3 строки:\n\n' +
          '<code>stel_ssid\nstel_token\nstel_ton_token</code>',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'fragment_accounts')],
          ]).reply_markup,
        },
      );
      return;
    }

    const [stel_ssid, stel_token, stel_ton_token] = lines;
    const name = ctx.session.pendingFragmentAccountName || 'Unnamed';

    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      const result = await this.fragmentAccountService.addAccount({
        name,
        stel_ssid,
        stel_token,
        stel_ton_token,
      });

      await ctx.reply(
        `✅ <b>Аккаунт добавлен!</b>\n\n` +
          `📛 <b>Название:</b> ${escapeHtml(result.name)}\n` +
          `🆔 <code>${result.id}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '🧩 К списку аккаунтов',
                'fragment_accounts',
              ),
            ],
          ]).reply_markup,
        },
      );
    } catch (error: any) {
      this.logger.error(`Error adding fragment account: ${error.message}`);
      await ctx.reply('❌ Ошибка при добавлении аккаунта: ' + error.message, {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'fragment_accounts')],
        ]).reply_markup,
      });
    }

    ctx.session.pendingFragmentAccountName = undefined;
  }

  @Action(/^frag_acc_toggle_(.+)$/)
  async onFragmentAccountToggle(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accountId = (ctx.match as RegExpExecArray)?.[1];
    if (!accountId) return;

    try {
      const result = await this.fragmentAccountService.toggleAccount(accountId);
      if (!result) {
        await ctx.answerCbQuery('❌ Аккаунт не найден');
        return;
      }

      const statusText = result.is_active ? '🟢 Включен' : '🔴 Отключен';
      await ctx.answerCbQuery(`${statusText}: ${result.name}`);

      const accounts = await this.fragmentAccountService.getAllAccounts();
      const account = accounts.find((a) => a.id === accountId);

      if (account) {
        const statusIcon = account.is_active ? '🟢 Активен' : '🔴 Отключен';
        const accountDate = new Date(account.created_at);
        const moscowAccountDate = new Date(
          accountDate.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }),
        );
        const createdAt = moscowAccountDate.toLocaleDateString('ru-RU');

        let message = `🧩 <b>Fragment аккаунт</b>\n\n`;
        message += `📛 <b>Название:</b> ${escapeHtml(account.name)}\n`;
        message += `📊 <b>Статус:</b> ${statusIcon}\n`;
        message += `📦 <b>В очереди:</b> ${account.queue_count}\n`;
        message += `📅 <b>Добавлен:</b> ${createdAt}\n`;
        message += `\n🆔 <code>${account.id}</code>`;

        const keyboard = AdminKeyboard.getFragmentAccountDetail(
          account.id,
          account.is_active,
        );

        await ctx.editMessageText(message, {
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error toggling fragment account: ${error.message}`);
    }
  }

  @Action(/^frag_acc_delete_(.+)$/)
  async onFragmentAccountDelete(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accountId = (ctx.match as RegExpExecArray)?.[1];
    if (!accountId) return;

    await ctx.editMessageText(
      `⚠️ <b>Вы уверены, что хотите удалить этот аккаунт?</b>\n\nЭто действие нельзя отменить.`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '🗑 Да, удалить',
              `frag_acc_confirm_delete_${accountId}`,
            ),
            Markup.button.callback('❌ Отмена', `frag_acc_${accountId}`),
          ],
        ]).reply_markup,
      },
    );
  }

  @Action(/^frag_acc_confirm_delete_(.+)$/)
  async onFragmentAccountConfirmDelete(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accountId = (ctx.match as RegExpExecArray)?.[1];
    if (!accountId) return;

    try {
      const removed =
        await this.fragmentAccountService.removeAccount(accountId);
      if (removed) {
        await ctx.answerCbQuery('✅ Аккаунт удален');
      } else {
        await ctx.answerCbQuery('❌ Не удалось удалить аккаунт');
      }

      await this.showFragmentAccountsList(ctx);
    } catch (error: any) {
      this.logger.error(`Error deleting fragment account: ${error.message}`);
    }
  }

  @Action(/^frag_acc_update_(.+)$/)
  async onFragmentAccountUpdate(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const userId = user.id.toString();
    const isAdmin = await this.userService.isAdmin(userId);
    if (!isAdmin) return;

    try {
      ctx.answerCbQuery().catch(() => {});
    } catch {}

    const accountId = (ctx.match as RegExpExecArray)?.[1];
    if (!accountId) return;

    ctx.session.awaitingFragmentAccountUpdate = true;
    ctx.session.pendingFragmentAccountId = accountId;

    await ctx.editMessageText(
      `🔑 <b>Обновление токенов</b>\n\nВведите новые токены в формате (каждый на новой строке):\n\n` +
        `<code>stel_ssid\nstel_token\nstel_ton_token</code>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отмена', `frag_acc_${accountId}`)],
        ]).reply_markup,
      },
    );
  }

  private async handleFragmentAccountUpdateInput(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    ctx.session.awaitingFragmentAccountUpdate = false;
    const accountId = ctx.session.pendingFragmentAccountId;
    ctx.session.pendingFragmentAccountId = undefined;

    if (!accountId) {
      await ctx.reply('❌ Ошибка: не найден ID аккаунта');
      return;
    }

    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length !== 3) {
      await ctx.reply(
        '❌ Неверный формат. Нужно 3 строки:\n\n' +
          '<code>stel_ssid\nstel_token\nstel_ton_token</code>',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', `frag_acc_${accountId}`)],
          ]).reply_markup,
        },
      );
      return;
    }

    const [stel_ssid, stel_token, stel_ton_token] = lines;

    try {
      await ctx.deleteMessage();
    } catch {}

    try {
      const updated = await this.fragmentAccountService.updateAccount(
        accountId,
        {
          stel_ssid,
          stel_token,
          stel_ton_token,
        },
      );

      if (updated) {
        await ctx.reply(`✅ <b>Токены обновлены!</b>`, {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '🧩 К списку аккаунтов',
                'fragment_accounts',
              ),
            ],
          ]).reply_markup,
        });
      } else {
        await ctx.reply('❌ Не удалось обновить токены', {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'fragment_accounts')],
          ]).reply_markup,
        });
      }
    } catch (error: any) {
      this.logger.error(`Error updating fragment account: ${error.message}`);
      await ctx.reply('❌ Ошибка: ' + error.message);
    }
  }

  @Command('set_toncenter_expiry')
  async setToncenterExpiry(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const msg = ctx.message as any;
    const args = (msg?.text ?? '').split(' ').slice(1);

    if (args.length === 0) {
      const current = await this.prisma.botSettings.findUnique({
        where: { setting_key: 'toncenter_subscription_expires_at' },
      });
      await ctx.reply(
        `📅 <b>Дата истечения подписки TonCenter</b>\n\n` +
          `Текущее значение: <b>${current?.setting_value ?? 'не задано'}</b>\n\n` +
          `Использование: <code>/set_toncenter_expiry 2026-06-01</code>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const dateStr = args[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
      await ctx.reply(
        '❌ Неверный формат даты. Используйте: <code>YYYY-MM-DD</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    await this.prisma.botSettings.upsert({
      where: { setting_key: 'toncenter_subscription_expires_at' },
      update: { setting_value: dateStr },
      create: {
        setting_key: 'toncenter_subscription_expires_at',
        setting_value: dateStr,
      },
    });

    await ctx.reply(
      `✅ Дата истечения подписки TonCenter установлена: <b>${dateStr}</b>`,
      { parse_mode: 'HTML' },
    );
  }

  @Command('set_server_expiry')
  async setServerExpiry(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;

    const msg = ctx.message as any;
    const args = (msg?.text ?? '').split(' ').slice(1);

    if (args.length === 0) {
      const current = await this.prisma.botSettings.findUnique({
        where: { setting_key: 'server_expires_at' },
      });
      await ctx.reply(
        `🖥️ <b>Дата оплаты сервера</b>\n\n` +
          `Текущее значение: <b>${current?.setting_value ?? 'не задано'}</b>\n\n` +
          `Использование: <code>/set_server_expiry 2026-06-01</code>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const dateStr = args[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr))) {
      await ctx.reply(
        '❌ Неверный формат даты. Используйте: <code>YYYY-MM-DD</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    await this.prisma.botSettings.upsert({
      where: { setting_key: 'server_expires_at' },
      update: { setting_value: dateStr },
      create: { setting_key: 'server_expires_at', setting_value: dateStr },
    });

    await ctx.reply(`✅ Дата оплаты сервера установлена: <b>${dateStr}</b>`, {
      parse_mode: 'HTML',
    });
  }

  @Action('broadcast_audience_all')
  async broadcastAudienceAll(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.session.broadcastTargetAudience = 'all';
    await this.executeBroadcastSendAll(ctx);
  }

  @Action('broadcast_audience_premium')
  async broadcastAudiencePremium(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.session.broadcastTargetAudience = 'premium';
    await this.executeBroadcastSendAll(ctx);
  }

  @Action('broadcast_audience_non_premium')
  async broadcastAudienceNonPremium(@Ctx() ctx: BotContext): Promise<void> {
    if (!(await this.checkAccess(ctx))) return;
    ctx.answerCbQuery().catch(() => {});
    ctx.session.broadcastTargetAudience = 'non_premium';
    await this.executeBroadcastSendAll(ctx);
  }

  private async executeBroadcastSendAll(ctx: BotContext): Promise<void> {
    try { await ctx.deleteMessage(); } catch {}

    const message =
      ctx.session.broadcastMessage || ctx.session.broadcastCaption;
    const photo = ctx.session.broadcastPhoto;
    const animation = ctx.session.broadcastAnimation;
    const video = ctx.session.broadcastVideo;
    const sticker = ctx.session.broadcastSticker;
    const audio = ctx.session.broadcastAudio;
    const entities = ctx.session.broadcastEntities;
    const captionEntities = ctx.session.broadcastCaptionEntities;
    const buttons = ctx.session.broadcastButtons || [];
    const targetAudience = ctx.session.broadcastTargetAudience || 'all';

    if (!message && !sticker) {
      await ctx.reply('❌ Ошибка: сообщение не найдено');
      return;
    }

    const chatId = ctx.chat!.id;

    ctx.session.lastBroadcastStats = undefined;
    ctx.session.awaitingBroadcast = false;
    ctx.session.awaitingBroadcastButton = false;
    ctx.session.currentBroadcastButtonText = undefined;
    ctx.session.broadcastMessage = undefined;
    ctx.session.broadcastPhoto = undefined;
    ctx.session.broadcastPhotoFileId = undefined;
    ctx.session.broadcastAnimation = undefined;
    ctx.session.broadcastAnimationFileId = undefined;
    ctx.session.broadcastVideo = undefined;
    ctx.session.broadcastVideoFileId = undefined;
    ctx.session.broadcastSticker = undefined;
    ctx.session.broadcastStickerFileId = undefined;
    ctx.session.broadcastAudio = undefined;
    ctx.session.broadcastAudioFileId = undefined;
    ctx.session.broadcastCaption = undefined;
    ctx.session.broadcastMessageId = undefined;
    ctx.session.broadcastFromChatId = undefined;
    ctx.session.broadcastEntities = undefined;
    ctx.session.broadcastCaptionEntities = undefined;
    ctx.session.broadcastButtons = undefined;
    ctx.session.broadcastTargetAudience = undefined;

    const audienceLabel =
      targetAudience === 'premium'
        ? '⭐ Premium пользователям'
        : targetAudience === 'non_premium'
          ? '👤 Пользователям без Premium'
          : '👥 Всем пользователям';

    const progressMsg = await ctx.reply(
      `⏳ Подготовка рассылки (${audienceLabel})...`,
    );
    const progressMsgId = progressMsg.message_id;

    await this.adminHandlers.showAdminMenu(ctx);

    try {
      if (!this.broadcastQueueService) {
        await ctx.reply('❌ Рассылка недоступна на этом инстансе');
        return;
      }

      const broadcastId = await this.broadcastQueueService.queueBroadcast({
        adminTelegramId: ctx.from!.id.toString(),
        adminChatId: chatId.toString(),
        progressMessageId: progressMsgId,
        message: message || '',
        photo,
        animation,
        video,
        sticker,
        audio,
        entities,
        captionEntities,
        buttons,
        targetAudience,
      });

      this.logger.log(
        `Broadcast ${broadcastId} (audience: ${targetAudience}) queued by admin ${ctx.from!.id}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to queue broadcast: ${err?.message ?? err}`);
      try {
        await ctx.telegram.editMessageText(
          chatId,
          progressMsgId,
          undefined,
          `❌ Ошибка постановки рассылки в очередь: ${err?.message ?? String(err)}`,
        );
      } catch {}
    }
  }
}
