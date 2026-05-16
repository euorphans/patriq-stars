import { Update, Ctx, Start, Action, On } from 'nestjs-telegraf';
import { Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup } from 'telegraf';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as QRCode from 'qrcode';
import { UserService } from '@/modules/user/user.service';
import { PricingService } from '@/modules/pricing/pricing.service';
import { PaymentsService } from '@/modules/payments/payments.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { BOT_STARS_TOPUP_PAYLOAD_PREFIX } from '@/shared/constants/bot-stars-topup.constant';
import {
  MainKeyboard,
  MAIN_MENU_INFO_CUSTOM_EMOJI_ID,
  MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
  MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
  STARS_USERNAME_PROMPT_CUSTOM_EMOJI_ID,
  PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
  PAYMENT_USERNAME_WARNING_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
} from '@/shared/keyboards/main.keyboard';
import { BotContext } from '@/shared/types/bot-context.interface';
import { withRetry } from '@/shared/utils';
import {
  getProductEmoji,
  escapeHtml,
  formatDateTimeMoscow,
} from '@/shared/utils';
import { RapiraService } from '@/shared/services/rapira/rapira.service';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  FragmentService,
  FragmentApiError,
} from '@/shared/services/fragment/fragment.service';
import { FragmentAccountService } from '@/shared/services/fragment/fragment-account.service';
import { I18nService } from '@/shared/services/i18n/i18n.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private userActionLocks = new Map<string, number>();
  /** Антидребезг двойных нажатий; короткий, чтобы не казалось «зависло». */
  private readonly ACTION_LOCK_TTL_MS = 1200;

  constructor(
    private readonly userService: UserService,
    private readonly pricingService: PricingService,
    private readonly paymentsService: PaymentsService,
    private readonly settingsService: SettingsService,
    private readonly rapiraService: RapiraService,
    private readonly prisma: PrismaService,
    private readonly fragmentService: FragmentService,
    private readonly fragmentAccountService: FragmentAccountService,
    private readonly i18n: I18nService,
    private readonly redisLock: RedisLockService,
    private readonly eventEmitter: EventEmitter2,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  private isImagesDisabled(): boolean {
    return process.env.DISABLE_IMAGES === 'true';
  }

  private resetInputFlags(ctx: BotContext): void {
    ctx.session.awaitingUsername = false;
    ctx.session.awaitingQuantity = false;
    ctx.session.awaitingBroadcast = false;
    ctx.session.productType = undefined;
    ctx.session.quantity = undefined;
    ctx.session.recipientUsername = undefined;
    ctx.session.recipientName = undefined;
    ctx.session.isForSelf = undefined;
    ctx.session.captchaCorrectKey = undefined;
    ctx.session.captchaOptions = undefined;
    ctx.session.pendingPaymentMethod = undefined;
  }

  private isActionLocked(userId: number, actionId: string): boolean {
    const lockKey = `${userId}:${actionId}`;
    const lockTime = this.userActionLocks.get(lockKey);

    if (lockTime && Date.now() - lockTime < this.ACTION_LOCK_TTL_MS) {
      return true;
    }

    return false;
  }

  private setActionLock(userId: number, actionId: string): void {
    const lockKey = `${userId}:${actionId}`;
    this.userActionLocks.set(lockKey, Date.now());

    if (this.userActionLocks.size > 1000) {
      const now = Date.now();
      for (const [key, time] of this.userActionLocks.entries()) {
        if (now - time > this.ACTION_LOCK_TTL_MS * 10) {
          this.userActionLocks.delete(key);
        }
      }
    }
  }

  private tryAcquireActionLock(ctx: BotContext, actionId: string): boolean {
    const userId = ctx.from?.id;
    if (!userId) return false;

    if (this.isActionLocked(userId, actionId)) {
      this.logger.debug(
        `Action ${actionId} blocked for user ${userId} (spam protection)`,
      );
      return false;
    }

    this.setActionLock(userId, actionId);
    return true;
  }

  private async tryAcquireActionLockRedis(
    ctx: BotContext,
    actionId: string,
    ttlSeconds: number = 10,
  ): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    const lockKey = `user_action:${userId}:${actionId}`;

    if (this.redisLock.isAvailable()) {
      const acquired = await this.redisLock.setNX(lockKey, '1', ttlSeconds);
      if (!acquired) {
        this.logger.debug(
          `Action ${actionId} blocked for user ${userId} (Redis spam protection)`,
        );
        return false;
      }
      return true;
    }

    return this.tryAcquireActionLock(ctx, actionId);
  }

  private async releaseActionLockRedis(
    userId: number,
    actionId: string,
  ): Promise<void> {
    if (!this.redisLock.isAvailable()) return;
    const lockKey = `user_action:${userId}:${actionId}`;
    await this.redisLock.delete(lockKey).catch(() => {});
  }

  private perfLog(
    userId: number | undefined,
    action: string,
    step: string,
    ms: number,
  ): void {
    this.logger.debug(`[PERF][${userId ?? '?'}] ${action} | ${step}: ${ms}ms`);
  }

  private async getMediaSource(
    imagePath: string,
  ): Promise<string | { source: string }> {
    const fileId = await this.redisLock.getImageFileId(imagePath);
    return fileId || { source: imagePath };
  }

  private cacheFileIdFromResult(imagePath: string, result: any): void {
    if (
      typeof result === 'object' &&
      'photo' in result &&
      result.photo?.length > 0
    ) {
      const largestPhoto = result.photo[result.photo.length - 1];
      this.redisLock.setImageFileId(imagePath, largestPhoto.file_id);
    }
  }

  private buildPhotoCaptionOptions(options: {
    caption?: string;
    parse_mode?: 'HTML' | 'Markdown';
    caption_entities?: any[];
    reply_markup?: any;
  }): Record<string, unknown> {
    const out: Record<string, unknown> = {
      reply_markup: options.reply_markup,
    };
    if (options.caption !== undefined) {
      out.caption = options.caption;
    }
    if (options.caption_entities && options.caption_entities.length > 0) {
      out.caption_entities = options.caption_entities;
    } else if (options.parse_mode) {
      out.parse_mode = options.parse_mode;
    }
    return out;
  }

  private async sendCachedPhoto(
    ctx: BotContext,
    imagePath: string,
    options: {
      caption?: string;
      parse_mode?: 'HTML' | 'Markdown';
      caption_entities?: any[];
      reply_markup?: any;
    },
  ): Promise<any> {
    if (this.isImagesDisabled()) {
      const textOpts: any = { reply_markup: options.reply_markup };
      if (options.caption_entities && options.caption_entities.length > 0) {
        textOpts.entities = options.caption_entities;
      } else if (options.parse_mode) {
        textOpts.parse_mode = options.parse_mode;
      }
      return ctx.reply(options.caption || '', textOpts);
    }

    const media = await this.getMediaSource(imagePath);

    try {
      const message = await ctx.replyWithPhoto(
        media,
        this.buildPhotoCaptionOptions(options) as any,
      );
      this.cacheFileIdFromResult(imagePath, message);
      ctx.session.currentImage = imagePath;
      return message;
    } catch (error) {
      if (typeof media === 'string') {
        this.logger.debug(
          `Cached file_id expired for ${imagePath}, re-uploading`,
        );
        const message = await ctx.replyWithPhoto(
          { source: imagePath },
          this.buildPhotoCaptionOptions(options) as any,
        );
        this.cacheFileIdFromResult(imagePath, message);
        ctx.session.currentImage = imagePath;
        return message;
      }
      throw error;
    }
  }

  private async editOrSendPhoto(
    ctx: BotContext,
    imagePath: string,
    options: {
      caption?: string;
      parse_mode?: 'HTML' | 'Markdown';
      caption_entities?: any[];
      reply_markup?: any;
    },
    forceRefreshMedia = false,
  ): Promise<any> {
    const deleteCurrentMessage = async () => {
      try {
        await ctx.deleteMessage();
      } catch {}
    };

    if (this.isImagesDisabled()) {
      const textOpts: any = { reply_markup: options.reply_markup };
      if (options.caption_entities && options.caption_entities.length > 0) {
        textOpts.entities = options.caption_entities;
      } else if (options.parse_mode) {
        textOpts.parse_mode = options.parse_mode;
      }
      await deleteCurrentMessage();
      return ctx.reply(options.caption || '', textOpts);
    }

    const uid = ctx.from?.id;
    void forceRefreshMedia;
    await deleteCurrentMessage();

    const t2 = Date.now();
    const result = await this.sendCachedPhoto(ctx, imagePath, options);
    this.perfLog(
      uid,
      'editOrSendPhoto',
      `sendCachedPhoto [${imagePath}]`,
      Date.now() - t2,
    );
    return result;
  }

  private getUserLanguage(_ctx: BotContext): 'ru' {
    return 'ru';
  }

  /**
   * Экран способа оплаты: подпись с HTML из i18n переводится в plain + caption_entities,
   * чтобы рядом с «Важно:» показать анимированный custom emoji (нельзя смешивать с parse_mode HTML).
   */
  private buildPaymentMethodsCaptionPayload(
    lang: 'ru',
    productType: string,
    quantity: number,
    recipientDisplayPlain: string,
  ): { caption: string; caption_entities: any[] } {
    const normalizedType = productType.toUpperCase();

    const baseStar = '\u2B50';
    let productCustomEmojiId: string | undefined;
    let productLinePlain: string;
    if (normalizedType === 'PREMIUM') {
      productCustomEmojiId = MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID;
      const durationText = this.i18n.t(
        `product.premium.duration.${quantity}` as any,
        lang,
      );
      productLinePlain = `${baseStar} Товар: Premium на ${durationText}`;
    } else if (normalizedType === 'STARS') {
      productCustomEmojiId = MAIN_MENU_STARS_CUSTOM_EMOJI_ID;
      productLinePlain = `${baseStar} Товар: ${quantity} звёзд`;
    } else {
      const productEmoji = getProductEmoji(normalizedType);
      productLinePlain = `${baseStar} Товар: ${quantity} ${productEmoji}`;
    }

    const recipientLinePlain = `${baseStar} Получатель: ${recipientDisplayPlain}`;

    let productNameForWarning: string;
    if (normalizedType === 'STARS') {
      productNameForWarning = 'звёзд';
    } else if (normalizedType === 'TON') {
      productNameForWarning = 'TON';
    } else if (normalizedType === 'PREMIUM') {
      productNameForWarning = 'Premium';
    } else {
      productNameForWarning = 'товара';
    }

    const warningRest = this.i18n.t('payment.username_warning_rest', lang, {
      product: productNameForWarning,
    });

    const titlePlain = this.i18n
      .t('payment.title', lang)
      .replace(/<\/?b>/gi, '')
      .trim();
    const methodsPlain = this.i18n
      .t('payment.methods', lang)
      .replace(/<\/?b>/gi, '');

    const importantLabel = 'Важно:';

    const entities: any[] = [];
    let caption = '';

    entities.push({ type: 'bold', offset: 0, length: titlePlain.length });
    caption += titlePlain + '\n\n';

    const productLineStart = caption.length;
    caption += productLinePlain + '\n';

    if (productCustomEmojiId) {
      entities.push({
        type: 'custom_emoji',
        offset: productLineStart,
        length: 1,
        custom_emoji_id: productCustomEmojiId,
      });
    }

    const prodBold = 'Товар:';
    const prodIdx = productLinePlain.indexOf(prodBold);
    if (prodIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: productLineStart + prodIdx,
        length: prodBold.length,
      });
    }

    const recipientLineStart = caption.length;
    caption += recipientLinePlain + '\n\n';

    entities.push({
      type: 'custom_emoji',
      offset: recipientLineStart,
      length: 1,
      custom_emoji_id: PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
    });

    const recBold = 'Получатель:';
    const recIdx = recipientLinePlain.indexOf(recBold);
    if (recIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: recipientLineStart + recIdx,
        length: recBold.length,
      });
    }

    const warnStart = caption.length;
    caption += `${baseStar} ${importantLabel} ${warningRest}\n\n`;
    entities.push({
      type: 'custom_emoji',
      offset: warnStart,
      length: 1,
      custom_emoji_id: PAYMENT_USERNAME_WARNING_CUSTOM_EMOJI_ID,
    });
    entities.push({
      type: 'bold',
      offset: warnStart + 2,
      length: importantLabel.length,
    });

    entities.push({
      type: 'bold',
      offset: caption.length,
      length: methodsPlain.length,
    });
    caption += methodsPlain;

    return { caption, caption_entities: entities };
  }

  /**
   * Экран оплаты TON: тот же стиль, что выбор способа оплаты — plain caption + caption_entities
   * (кастомные emoji и жирные подписи, без HTML).
   */
  private buildTonPaymentCaptionPayload(
    lang: 'ru',
    args: {
      productType: string;
      quantity: number;
      recipientDisplayPlain: string;
      amountTonFormatted: string;
      orderNumber: string;
      address: string;
      comment: string;
    },
  ): { caption: string; caption_entities: any[] } {
    const baseStar = '\u2B50';
    const entities: any[] = [];
    let caption = '';

    const title = this.i18n.t('payment.ton.caption_title', lang);
    const line1 = `${baseStar} ${title}`;
    caption += line1 + '\n\n';
    entities.push({
      type: 'custom_emoji',
      offset: 0,
      length: 1,
      custom_emoji_id: PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
    });
    entities.push({
      type: 'bold',
      offset: 2,
      length: title.length,
    });

    const normalizedType = args.productType.toUpperCase();
    let productCustomEmojiId: string | undefined;
    let productLinePlain: string;
    if (normalizedType === 'PREMIUM') {
      productCustomEmojiId = MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID;
      const durationText = this.i18n.t(
        `product.premium.duration.${args.quantity}` as any,
        lang,
      );
      productLinePlain = `${baseStar} Товар: Premium на ${durationText}`;
    } else if (normalizedType === 'STARS') {
      productCustomEmojiId = MAIN_MENU_STARS_CUSTOM_EMOJI_ID;
      productLinePlain = `${baseStar} Товар: ${args.quantity} звёзд`;
    } else {
      const productEmoji = getProductEmoji(normalizedType);
      productLinePlain = `${baseStar} Товар: ${args.quantity} ${productEmoji}`;
    }

    const productLineStart = caption.length;
    caption += productLinePlain + '\n';
    if (productCustomEmojiId) {
      entities.push({
        type: 'custom_emoji',
        offset: productLineStart,
        length: 1,
        custom_emoji_id: productCustomEmojiId,
      });
    }
    const prodBold = 'Товар:';
    const prodIdx = productLinePlain.indexOf(prodBold);
    if (prodIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: productLineStart + prodIdx,
        length: prodBold.length,
      });
    }

    const recipientLinePlain = `${baseStar} Получатель: ${args.recipientDisplayPlain}`;
    const recipientLineStart = caption.length;
    caption += recipientLinePlain + '\n\n';
    entities.push({
      type: 'custom_emoji',
      offset: recipientLineStart,
      length: 1,
      custom_emoji_id: PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
    });
    const recBold = 'Получатель:';
    const recIdx = recipientLinePlain.indexOf(recBold);
    if (recIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: recipientLineStart + recIdx,
        length: recBold.length,
      });
    }

    let productNameForWarning: string;
    if (normalizedType === 'STARS') {
      productNameForWarning = 'звёзд';
    } else if (normalizedType === 'TON') {
      productNameForWarning = 'TON';
    } else if (normalizedType === 'PREMIUM') {
      productNameForWarning = 'Premium';
    } else {
      productNameForWarning = 'товара';
    }
    const warningRest = this.i18n.t('payment.username_warning_rest', lang, {
      product: productNameForWarning,
    });
    const importantLabel = 'Важно:';
    const warnStart = caption.length;
    caption += `${baseStar} ${importantLabel} ${warningRest}\n\n`;
    entities.push({
      type: 'custom_emoji',
      offset: warnStart,
      length: 1,
      custom_emoji_id: PAYMENT_USERNAME_WARNING_CUSTOM_EMOJI_ID,
    });
    entities.push({
      type: 'bold',
      offset: warnStart + 2,
      length: importantLabel.length,
    });

    const amountLabel = this.i18n.t('payment.ton.amount_label', lang);
    const amountLine = `${amountLabel} ${args.amountTonFormatted} TON`;
    const amountLineStart = caption.length;
    caption += amountLine + '\n';
    const amountLabelIdx = amountLine.indexOf(amountLabel);
    if (amountLabelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: amountLineStart + amountLabelIdx,
        length: amountLabel.length,
      });
    }

    const orderLabel = this.i18n.t('payment.ton.order_label', lang);
    const orderHash = `#${args.orderNumber}`;
    const orderLine = `${orderLabel} ${orderHash}`;
    const orderLineStart = caption.length;
    caption += orderLine + '\n\n';
    const orderLabelIdx = orderLine.indexOf(orderLabel);
    if (orderLabelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: orderLineStart + orderLabelIdx,
        length: orderLabel.length,
      });
    }
    const hashIdx = orderLine.indexOf(orderHash);
    if (hashIdx >= 0) {
      entities.push({
        type: 'code',
        offset: orderLineStart + hashIdx,
        length: orderHash.length,
      });
    }

    const timeLine = this.i18n.t('payment.ton.time_window', lang);
    const timeLineStart = caption.length;
    caption += timeLine + '\n\n';
    entities.push({
      type: 'bold',
      offset: timeLineStart,
      length: timeLine.length,
    });

    const manualTitle = this.i18n.t('payment.ton.manual_title', lang);
    const manualTitleStart = caption.length;
    caption += manualTitle + '\n';
    entities.push({
      type: 'bold',
      offset: manualTitleStart,
      length: manualTitle.length,
    });

    const addrLabel = this.i18n.t('payment.ton.address_label', lang);
    const addrLine = `${addrLabel} ${args.address}`;
    const addrLineStart = caption.length;
    caption += addrLine + '\n';
    const addrLabelIdx = addrLine.indexOf(addrLabel);
    if (addrLabelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: addrLineStart + addrLabelIdx,
        length: addrLabel.length,
      });
    }
    const addrValIdx = addrLine.indexOf(args.address);
    if (addrValIdx >= 0) {
      entities.push({
        type: 'code',
        offset: addrLineStart + addrValIdx,
        length: args.address.length,
      });
    }

    const sumLabel = this.i18n.t('payment.ton.sum_label', lang);
    const sumCodePayload = `${args.amountTonFormatted} TON`;
    const sumLine = `${sumLabel} ${sumCodePayload}`;
    const sumLineStart = caption.length;
    caption += sumLine + '\n';
    const sumLabelIdx = sumLine.indexOf(sumLabel);
    if (sumLabelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: sumLineStart + sumLabelIdx,
        length: sumLabel.length,
      });
    }
    const sumCodeIdx = sumLine.indexOf(sumCodePayload);
    if (sumCodeIdx >= 0) {
      entities.push({
        type: 'code',
        offset: sumLineStart + sumCodeIdx,
        length: sumCodePayload.length,
      });
    }

    const commLabel = this.i18n.t('payment.ton.comment_label', lang);
    const commLine = `${commLabel} ${args.comment}`;
    const commLineStart = caption.length;
    caption += commLine + '\n\n';
    const commLabelIdx = commLine.indexOf(commLabel);
    if (commLabelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: commLineStart + commLabelIdx,
        length: commLabel.length,
      });
    }
    const commValIdx = commLine.indexOf(args.comment);
    if (commValIdx >= 0) {
      entities.push({
        type: 'code',
        offset: commLineStart + commValIdx,
        length: args.comment.length,
      });
    }

    const commentHint = this.i18n.t('payment.ton.comment_hint', lang);
    const hintStart = caption.length;
    caption += commentHint;
    const hintBold = 'Важно:';
    const hintBoldIdx = commentHint.indexOf(hintBold);
    if (hintBoldIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: hintStart + hintBoldIdx,
        length: hintBold.length,
      });
    }

    return { caption, caption_entities: entities };
  }

  /** Экран выбора получателя для Stars: emoji главного меню + заголовок, emoji «получатель» + подзаголовок. */
  private getStarsRecipientCaptionPayload(_lang: 'ru'): {
    caption: string;
    caption_entities: any[];
  } {
    const base = '\u2B50';
    const title = 'Покупка звёзд';
    const subtitle = 'Выберите, кому будем отправлять звёзды';
    const line1 = `${base} ${title}`;
    const line2 = `${base} ${subtitle}`;
    const caption = `${line1}\n\n${line2}`;
    const line2Start = line1.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        {
          type: 'custom_emoji',
          offset: line2Start,
          length: 1,
          custom_emoji_id: PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
        },
      ],
    };
  }

  /** Ввод @username для звёзд: заголовок как на экране «кому», затем подсказка с отдельным custom emoji. */
  private getStarsUsernameEnterCaptionPayload(
    _lang: 'ru',
    buyerUsername?: string | null,
  ): {
    caption: string;
    caption_entities: any[];
  } {
    const base = '\u2B50';
    const title = 'Покупка звёзд';
    const example = buyerUsername?.trim()
      ? `@${buyerUsername.replace(/^@+/, '')}`
      : '@username';
    const body = `Введите юзернейм пользователя, которому будем дарить звёзды:\n— Пример: ${example}`;
    const line1 = `${base} ${title}`;
    const line2 = `${base} ${body}`;
    const caption = `${line1}\n\n${line2}`;
    const line2Start = line1.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        {
          type: 'custom_emoji',
          offset: line2Start,
          length: 1,
          custom_emoji_id: STARS_USERNAME_PROMPT_CUSTOM_EMOJI_ID,
        },
      ],
    };
  }

  /** Ввод @username для Premium — тот же шаблон, что для звёзд; иконка строки 1 из главного меню Premium. */
  private getPremiumUsernameEnterCaptionPayload(
    _lang: 'ru',
    buyerUsername?: string | null,
  ): {
    caption: string;
    caption_entities: any[];
  } {
    const base = '\u2B50';
    const title = 'Покупка Premium';
    const example = buyerUsername?.trim()
      ? `@${buyerUsername.replace(/^@+/, '')}`
      : '@username';
    const body = `Введите юзернейм пользователя, которому будем дарить Premium:\n— Пример: ${example}`;
    const line1 = `${base} ${title}`;
    const line2 = `${base} ${body}`;
    const caption = `${line1}\n\n${line2}`;
    const line2Start = line1.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        {
          type: 'custom_emoji',
          offset: line2Start,
          length: 1,
          custom_emoji_id: STARS_USERNAME_PROMPT_CUSTOM_EMOJI_ID,
        },
      ],
    };
  }

  /** Экран выбора суммы Stars (пресеты): заголовок с emoji главного меню, лимиты и подсказка про «Свой ввод». */
  private getStarsQuantityPickCaptionPayload(
    minStars: number,
    maxStars: number,
  ): { caption: string; caption_entities: any[] } {
    const base = '\u2B50';
    const title = 'Покупка звёзд';
    const minStr = minStars.toLocaleString('ru-RU');
    const maxStr = maxStars.toLocaleString('ru-RU');
    const line1 = `${base} ${title}`;
    const para2 = `Доступно от ${minStr} до ${maxStr}.`;
    const p3pre = 'Выберите сумму кнопкой или нажмите ';
    const p3bold = '«Свой ввод»';
    const p3suf = ' и отправьте число сообщением.';
    const caption = `${line1}\n\n${para2}\n\n${p3pre}${p3bold}${p3suf}`;

    const para2Start = line1.length + 2;
    const minOff = para2Start + 'Доступно от '.length;
    const maxOff = minOff + minStr.length + ' до '.length;
    const para3Start = para2Start + para2.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        { type: 'bold', offset: minOff, length: minStr.length },
        { type: 'bold', offset: maxOff, length: maxStr.length },
        {
          type: 'bold',
          offset: para3Start + p3pre.length,
          length: p3bold.length,
        },
      ],
    };
  }

  /** Экран выбора срока Premium: как у Stars — корона из главного меню, сроки 3/6/12, подсказка. */
  private getPremiumDurationPickCaptionPayload(): {
    caption: string;
    caption_entities: any[];
  } {
    const base = '\u2B50';
    const title = 'Покупка Premium';
    const line1 = `${base} ${title}`;
    const para2 = 'Доступно: 3, 6 или 12 месяцев.';
    const p3pre = 'Выберите срок подписки ';
    const p3bold = 'кнопкой.';
    const caption = `${line1}\n\n${para2}\n\n${p3pre}${p3bold}`;

    const para2Start = line1.length + 2;
    const idx3 = para2Start + para2.indexOf('3');
    const idx6 = para2Start + para2.indexOf('6');
    const idx12 = para2Start + para2.indexOf('12');
    const para3Start = para2Start + para2.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        { type: 'bold', offset: idx3, length: 1 },
        { type: 'bold', offset: idx6, length: 1 },
        { type: 'bold', offset: idx12, length: 2 },
        {
          type: 'bold',
          offset: para3Start + p3pre.length,
          length: p3bold.length,
        },
      ],
    };
  }

  /** Экран выбора получателя для Premium: emoji «Premium» из главного меню + заголовок, emoji «получатель» + подзаголовок. */
  private getPremiumRecipientCaptionPayload(_lang: 'ru'): {
    caption: string;
    caption_entities: any[];
  } {
    const base = '\u2B50';
    const title = 'Покупка Premium';
    const subtitle = 'Выберите, кому будем отправлять Premium';
    const line1 = `${base} ${title}`;
    const line2 = `${base} ${subtitle}`;
    const caption = `${line1}\n\n${line2}`;
    const line2Start = line1.length + 2;

    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: 2, length: title.length },
        {
          type: 'custom_emoji',
          offset: line2Start,
          length: 1,
          custom_emoji_id: PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
        },
      ],
    };
  }

  /**
   * Подпись экрана «Информация»: анимированный emoji рядом с заголовком через caption_entities.
   * В тексте нужен один «базовый» символ (⭐); сущность custom_emoji заменяет его на стикер бота.
   * Символ U+FFFC и т.п. клиент часто не рисует как кастомный emoji.
   */
  private getMenuInfoCaptionPayload(lang: 'ru'): {
    caption: string;
    caption_entities: any[];
  } {
    const title = this.i18n.t('menu.info.title', lang);
    const body = this.i18n.t('menu.info.body', lang);
    const baseStar = '\u2B50';
    const caption = `${baseStar} ${title}\n\n${body}`;
    const titleOffset = 2;
    return {
      caption,
      caption_entities: [
        {
          type: 'custom_emoji',
          offset: 0,
          length: 1,
          custom_emoji_id: MAIN_MENU_INFO_CUSTOM_EMOJI_ID,
        },
        { type: 'bold', offset: titleOffset, length: title.length },
      ],
    };
  }

  /** Экран «Информация»: images/main2.webp (из images/new/main2.png); иначе запас — main_menu.webp. */
  private resolveInfoScreenImage(): string {
    const webpAbsolute = path.join(process.cwd(), 'images', 'main2.webp');
    if (fs.existsSync(webpAbsolute)) {
      return './images/main2.webp';
    }
    this.logger.warn(
      `Info screen: images/main2.webp not found (${webpAbsolute}), using main_menu.webp`,
    );
    return './images/main_menu.webp';
  }

  /** Экран согласия: предпочитаем images/main2.webp, иначе public_offer.webp. */
  private resolveAgreementScreenImage(): string {
    const main2Absolute = path.join(process.cwd(), 'images', 'main2.webp');
    if (fs.existsSync(main2Absolute)) {
      return './images/main2.webp';
    }
    this.logger.warn(
      `Agreement screen: images/main2.webp not found (${main2Absolute}), using public_offer.webp`,
    );
    return './images/public_offer.webp';
  }

  /** Шапка экрана «Способ оплаты»: арт «в течение 5 минут» для Stars / Premium. */
  private paymentMethodsHeroImage(productType: string | undefined): string {
    const t = productType?.toLowerCase();
    if (t === 'stars') {
      return './images/new/starsIn5min.png';
    }
    if (t === 'premium') {
      return './images/new/premIn5min.png';
    }
    return './images/main_menu.webp';
  }

  /** Экран выбора срока Premium: предпочитаем premIn5min, иначе старый premium_duration. */
  private resolvePremiumDurationImage(): string {
    const preferred = path.join(
      process.cwd(),
      'images',
      'new',
      'premIn5min.png',
    );
    if (fs.existsSync(preferred)) {
      return './images/new/premIn5min.png';
    }
    this.logger.warn(
      `Premium duration: images/new/premIn5min.png not found (${preferred}), using premium_duration.webp`,
    );
    return './images/premium_duration.webp';
  }

  private getMenuInfoCaptionHtmlFallback(lang: 'ru'): {
    caption: string;
    parse_mode: 'HTML';
  } {
    const title = escapeHtml(this.i18n.t('menu.info.title', lang));
    const body = escapeHtml(this.i18n.t('menu.info.body', lang));
    return {
      caption: `<b>⭐ ${title}</b>\n\n${body}`,
      parse_mode: 'HTML',
    };
  }

  private normalizeTxForTonscan(tx: string): string | null {
    const t = tx.trim();
    if (!t || t.length < 32) return null;
    if (
      /^[0-9a-fA-F]{64}$/i.test(t) ||
      (/^[0-9a-fA-F]+$/i.test(t) && t.length >= 32)
    ) {
      return t;
    }
    try {
      const clean = t.replace(/\s/g, '');
      const buffer = Buffer.from(clean, 'base64');
      const hex = buffer.toString('hex');
      if (hex.length >= 32) return hex;
      return clean.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    } catch {
      return t.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }
  }

  private readonly SUBSCRIPTION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timed out after ${ms}ms`)),
          ms,
        ),
      ),
    ]);
  }

  private async checkSubscriptionMiddleware(
    ctx: BotContext,
    forceCheck = false,
  ): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return true;

    try {
      if (
        !forceCheck &&
        ctx.session.subscriptionCheckedAt &&
        Date.now() - ctx.session.subscriptionCheckedAt <
          this.SUBSCRIPTION_CACHE_TTL_MS
      ) {
        this.logger.debug(`[PERF][${userId}] checkSub: HIT cache`);
        return true;
      }

      const t0 = Date.now();
      const channels = await this.settingsService.getRequiredChannels();
      this.perfLog(
        userId,
        'checkSub',
        `getRequiredChannels (${channels?.length ?? 0} ch)`,
        Date.now() - t0,
      );
      if (!channels || channels.length === 0) return true;

      const t1 = Date.now();
      const checkResults = await Promise.allSettled(
        channels.map(async (channel) => {
          try {
            const member = await withRetry(
              () =>
                this.withTimeout(
                  this.bot.telegram.getChatMember(channel.channel_id, userId),
                  5000,
                ),
              {
                maxAttempts: 2,
                delayMs: 0,
                exponentialBackoff: false,
                shouldRetry: (err: any) =>
                  !err?.response?.error_code || err.response.error_code >= 500,
              },
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

      this.perfLog(
        userId,
        'checkSub',
        `getChatMember x${channels.length}`,
        Date.now() - t1,
      );

      const unsubscribed: any[] = [];
      for (const result of checkResults) {
        if (result.status === 'fulfilled' && !result.value.isSubscribed) {
          unsubscribed.push(result.value.channel);
        }
      }

      if (unsubscribed.length === 0) {
        ctx.session.subscriptionCheckedAt = Date.now();
        return true;
      }

      ctx.session.subscriptionCheckedAt = undefined;

      try {
        await this.showSubscriptionRequired(ctx, unsubscribed);
      } catch (displayError: any) {
        const isBlocked =
          displayError?.response?.error_code === 403 &&
          /blocked by the user/i.test(
            displayError?.response?.description || '',
          );
        if (!isBlocked) {
          this.logger.error(
            'Failed to display subscription screen:',
            displayError,
          );
        }
      }

      return false;
    } catch (error: any) {
      const isBlocked =
        error?.response?.error_code === 403 &&
        /blocked by the user/i.test(error?.response?.description || '');
      if (!isBlocked) {
        this.logger.error('Subscription check error:', error);
      }
      return true;
    }
  }

  private async showSubscriptionRequired(
    ctx: BotContext,
    unsubscribed: any[],
  ): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    const buttons = unsubscribed.map((channel) => [
      Markup.button.url(
        channel.channel_name || 'Канал',
        channel.channel_link ||
          `https://t.me/${channel.channel_id.replace('@', '')}`,
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        this.i18n.t('subscription.check', lang),
        'check_subscription',
      ) as any,
    ]);

    const caption = this.i18n.t('subscription.screen', lang);

    await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
      caption,
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  }

  @Start()
  async onStart(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const startPayload =
      (ctx as any).startPayload ||
      (ctx.message as any)?.text?.split(' ')[1] ||
      '';

    try {
      let { user: dbUser } = await this.userService.createOrUpdateFromTelegram({
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username,
        is_premium: (user as any).is_premium ?? false,
      });

      if (!dbUser?.language || dbUser.language === '') {
        await this.userService.setUserLanguage(user.id.toString(), 'ru');
        const refreshed = await this.userService.findByTelegramId(
          user.id.toString(),
        );
        if (refreshed) {
          dbUser = refreshed;
        }
      }

      const lang = 'ru';
      ctx.session.userLang = lang;
      ctx.session.isBan = dbUser?.is_ban ?? false;
      ctx.dbUser = dbUser;

      if (dbUser?.is_ban) {
        await ctx.reply(this.i18n.t('start.banned', lang), {
          parse_mode: 'HTML',
        });
        return;
      }

      if (!dbUser?.agreement) {
        if (startPayload) {
          ctx.session.pendingDeepLink = startPayload;
        }
        const text = this.i18n.t('start.agreement', lang);
        const agreementImage = this.resolveAgreementScreenImage();

        try {
          await ctx.replyWithPhoto(
            { source: agreementImage },
            {
              caption: text,
              parse_mode: 'HTML',
              reply_markup: MainKeyboard.getAgreementKeyboard(lang, this.i18n)
                .reply_markup,
            },
          );
        } catch {
          await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: MainKeyboard.getAgreementKeyboard(lang, this.i18n)
              .reply_markup,
            link_preview_options: { is_disabled: true },
          });
        }
        return;
      }

      const subscriptionAllowed = await this.checkSubscriptionMiddleware(
        ctx,
        true,
      );
      if (!subscriptionAllowed) {
        return;
      }

      await this.handleDeepLink(ctx, startPayload);
    } catch (error: any) {
      if (error?.response?.error_code === 403) {
        this.logger.debug(
          `User ${ctx.from?.id} blocked the bot, skipping error message`,
        );
        return;
      }

      try {
        const lang = this.getUserLanguage(ctx);
        await ctx.reply(this.i18n.t('common.error', lang));
      } catch (replyError: any) {
        if (replyError?.response?.error_code !== 403) {
          this.logger.error(
            `Failed to send error message: ${replyError.message}`,
          );
        }
      }
    }
  }

  private async handleDeepLink(
    ctx: BotContext,
    payload: string,
    edit: boolean = false,
  ): Promise<void> {
    const deepLink = payload || ctx.session.pendingDeepLink;
    ctx.session.pendingDeepLink = undefined;

    if (!deepLink) {
      await this.showMainMenu(ctx, edit);
      return;
    }

    const lang = this.getUserLanguage(ctx);
    const deepLinkLower = deepLink.toLowerCase();

    switch (deepLinkLower) {
      case 'stars':
        ctx.session.productType = 'stars';
        {
          const starsCap = this.getStarsRecipientCaptionPayload(lang);
          const recipientKb = MainKeyboard.getRecipientSelection(
            this.i18n,
            lang,
          ).reply_markup;
          if (edit) {
            try {
              await this.editOrSendPhoto(
                ctx,
                './images/where_delivery_stars.webp',
                {
                  caption: starsCap.caption,
                  caption_entities: starsCap.caption_entities,
                  reply_markup: recipientKb,
                },
              );
            } catch {
              await ctx.reply(starsCap.caption, {
                entities: starsCap.caption_entities,
                reply_markup: recipientKb,
              });
            }
          } else {
            try {
              await ctx.replyWithPhoto(
                { source: './images/where_delivery_stars.webp' },
                {
                  caption: starsCap.caption,
                  caption_entities: starsCap.caption_entities,
                  reply_markup: recipientKb,
                },
              );
              ctx.session.currentImage = './images/where_delivery_stars.webp';
            } catch {
              await ctx.reply(starsCap.caption, {
                entities: starsCap.caption_entities,
                reply_markup: recipientKb,
              });
            }
          }
        }
        break;

      case 'ton':
        await this.showMainMenu(ctx, edit);
        break;

      case 'premium':
        ctx.session.productType = 'premium';
        {
          const premiumCap = this.getPremiumRecipientCaptionPayload(lang);
          const recipientKb = MainKeyboard.getRecipientSelection(
            this.i18n,
            lang,
          ).reply_markup;
          if (edit) {
            try {
              await this.editOrSendPhoto(
                ctx,
                './images/where_delivery_premium.webp',
                {
                  caption: premiumCap.caption,
                  caption_entities: premiumCap.caption_entities,
                  reply_markup: recipientKb,
                },
              );
            } catch {
              await ctx.reply(premiumCap.caption, {
                entities: premiumCap.caption_entities,
                reply_markup: recipientKb,
              });
            }
          } else {
            try {
              await ctx.replyWithPhoto(
                { source: './images/where_delivery_premium.webp' },
                {
                  caption: premiumCap.caption,
                  caption_entities: premiumCap.caption_entities,
                  reply_markup: recipientKb,
                },
              );
              ctx.session.currentImage = './images/where_delivery_premium.webp';
            } catch {
              await ctx.reply(premiumCap.caption, {
                entities: premiumCap.caption_entities,
                reply_markup: recipientKb,
              });
            }
          }
        }
        break;

      default:
        await this.showMainMenu(ctx, edit);
    }
  }

  private async checkUserAccess(ctx: BotContext): Promise<boolean> {
    const userId = ctx.from?.id;
    if (!userId) return false;

    const lang = this.getUserLanguage(ctx);

    if (ctx.session.isBan) {
      ctx
        .answerCbQuery(
          this.i18n.t('start.banned', lang).replace(/<[^>]*>/g, ''),
          { show_alert: true },
        )
        .catch(() => {});
      return false;
    }

    const isEnabled = await this.settingsService.isBotEnabled();

    if (!isEnabled) {
      const isAdmin = await this.userService.isAdmin(userId.toString());
      if (isAdmin) {
        return true;
      }

      const disabledText = this.i18n.t('start.bot.disabled', lang);
      const backKeyboard =
        MainKeyboard.getBackButton('back_to_main').reply_markup;
      try {
        ctx.answerCbQuery().catch(() => {});
        const msg = ctx.callbackQuery?.message;
        if (msg && 'text' in msg) {
          await ctx.editMessageText(disabledText, {
            parse_mode: 'HTML',
            reply_markup: backKeyboard,
          });
        } else if (msg && 'caption' in msg) {
          await ctx.editMessageCaption(disabledText, {
            parse_mode: 'HTML',
            reply_markup: backKeyboard,
          });
        } else {
          await ctx.reply(disabledText, {
            parse_mode: 'HTML',
            reply_markup: backKeyboard,
          });
        }
      } catch {
        await ctx
          .reply(disabledText, {
            parse_mode: 'HTML',
            reply_markup: backKeyboard,
          })
          .catch(() => {});
      }
      return false;
    }

    return true;
  }

  @Action('accept_agreement')
  async acceptAgreement(@Ctx() ctx: BotContext): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    try {
      const lang = this.getUserLanguage(ctx);
      ctx
        .answerCbQuery(this.i18n.t('start.agreement.accepted', lang))
        .catch(() => {});
      await this.userService.acceptAgreement(user.id.toString());

      const subscriptionAllowed = await this.checkSubscriptionMiddleware(
        ctx,
        true,
      );
      if (!subscriptionAllowed) {
        return;
      }

      await this.handleDeepLink(ctx, '', true);
    } catch {
      const lang = this.getUserLanguage(ctx);
      ctx.answerCbQuery(this.i18n.t('error.agreement', lang)).catch(() => {});
    }
  }

  @Action('decline_agreement')
  async declineAgreement(@Ctx() ctx: BotContext): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    ctx.answerCbQuery().catch(() => {});
    ctx.deleteMessage().catch(() => {});
    try {
      await ctx.reply(this.i18n.t('start.agreement.declined', lang));
    } catch (error: any) {
      if (error?.response?.error_code !== 403) {
        throw error;
      }
    }
  }

  @Action('check_subscription')
  async checkSubscription(@Ctx() ctx: BotContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = this.getUserLanguage(ctx);
    const subscribed = await this.checkSubscriptionMiddleware(ctx, true);

    if (!subscribed) {
      ctx
        .answerCbQuery(this.i18n.t('subscription.failed', lang), {
          show_alert: true,
        })
        .catch(() => {});
      return;
    }

    await ctx
      .answerCbQuery(this.i18n.t('subscription.passed', lang))
      .catch(() => {});

    await this.handleDeepLink(ctx, '', true);
  }

  @Action('back_to_main')
  async backToMain(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    this.resetInputFlags(ctx);

    await this.showMainMenu(ctx, true);
  }

  @Action('back_to_recipient')
  async backToRecipient(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    ctx.session.awaitingUsername = false;
    ctx.session.awaitingQuantity = false;
    ctx.session.quantity = undefined;
    ctx.session.recipientUsername = undefined;
    ctx.session.recipientName = undefined;
    ctx.session.isForSelf = undefined;

    const productType = ctx.session.productType;
    if (!productType || productType === 'ton') {
      ctx.session.productType = undefined;
      await this.showMainMenu(ctx, true);
      return;
    }

    const lang = this.getUserLanguage(ctx);

    const imageMap: Record<string, string> = {
      stars: './images/where_delivery_stars.webp',
      premium: './images/where_delivery_premium.webp',
    };

    const textMap: Record<string, string> = {
      stars: 'product.delivery.stars',
      premium: 'product.delivery.premium',
    };

    const imagePath = imageMap[productType] || './images/main_menu.webp';
    const recipientKb = MainKeyboard.getRecipientSelection(this.i18n, lang)
      .reply_markup;

    if (productType === 'stars') {
      const starsCap = this.getStarsRecipientCaptionPayload(lang);
      try {
        await this.editOrSendPhoto(ctx, imagePath, {
          caption: starsCap.caption,
          caption_entities: starsCap.caption_entities,
          reply_markup: recipientKb,
        });
      } catch {
        await ctx.reply(starsCap.caption, {
          entities: starsCap.caption_entities,
          reply_markup: recipientKb,
        });
      }
      return;
    }

    if (productType === 'premium') {
      const premiumCap = this.getPremiumRecipientCaptionPayload(lang);
      try {
        await this.editOrSendPhoto(ctx, imagePath, {
          caption: premiumCap.caption,
          caption_entities: premiumCap.caption_entities,
          reply_markup: recipientKb,
        });
      } catch {
        await ctx.reply(premiumCap.caption, {
          entities: premiumCap.caption_entities,
          reply_markup: recipientKb,
        });
      }
      return;
    }

    const text = this.i18n.t(
      textMap[productType] || 'product.delivery.stars',
      lang,
    );

    try {
      await this.editOrSendPhoto(ctx, imagePath, {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: recipientKb,
      });
    } catch {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: recipientKb,
      });
    }
  }

  @Action('back_to_quantity')
  async backToQuantity(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    ctx.session.quantity = undefined;

    await this.askQuantity(ctx, true);
  }

  async showMainMenu(ctx: BotContext, edit: boolean = false): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    const welcomeText = this.i18n.t('menu.welcome', lang);

    const userId = ctx.from?.id?.toString();
    const isAdmin = userId ? await this.userService.isAdmin(userId) : false;

    const keyboard = isAdmin
      ? MainKeyboard.getMainMenuAdmin(this.i18n, lang)
      : MainKeyboard.getMainMenu(this.i18n, lang);

    try {
      if (edit) {
        await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
          caption: welcomeText,
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
      } else {
        const message = await this.sendCachedPhoto(
          ctx,
          './images/main_menu.webp',
          {
            caption: welcomeText,
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup,
          },
        );
        ctx.session.lastBotMessageId = message.message_id;
      }
    } catch {
      const message = await ctx.reply(welcomeText, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup,
      });
      ctx.session.lastBotMessageId = message.message_id;
    }
  }

  @Action('buy_stars')
  async buyStars(@Ctx() ctx: BotContext): Promise<void> {
    const t0 = Date.now();
    const uid = ctx.from?.id;

    if (!this.tryAcquireActionLock(ctx, 'buy_stars')) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }

    ctx.answerCbQuery().catch(() => {});
    this.perfLog(uid, 'buy_stars', 'answerCbQuery', Date.now() - t0);

    const t1 = Date.now();
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;
    this.perfLog(uid, 'buy_stars', 'checkSubscription', Date.now() - t1);

    ctx.session.productType = 'stars';
    const lang = this.getUserLanguage(ctx);
    const starsCap = this.getStarsRecipientCaptionPayload(lang);
    const recipientKb = MainKeyboard.getRecipientSelection(this.i18n, lang)
      .reply_markup;

    const t2 = Date.now();
    try {
      await this.editOrSendPhoto(ctx, './images/where_delivery_stars.webp', {
        caption: starsCap.caption,
        caption_entities: starsCap.caption_entities,
        reply_markup: recipientKb,
      });
    } catch {
      await ctx.reply(starsCap.caption, {
        entities: starsCap.caption_entities,
        reply_markup: recipientKb,
      });
    }
    this.perfLog(uid, 'buy_stars', 'editOrSendPhoto', Date.now() - t2);
    this.perfLog(uid, 'buy_stars', 'TOTAL', Date.now() - t0);
  }

  @Action('buy_premium')
  async buyPremium(@Ctx() ctx: BotContext): Promise<void> {
    const t0 = Date.now();
    const uid = ctx.from?.id;

    if (!this.tryAcquireActionLock(ctx, 'buy_premium')) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    this.perfLog(uid, 'buy_premium', 'answerCbQuery', Date.now() - t0);

    const t1 = Date.now();
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;
    this.perfLog(uid, 'buy_premium', 'checkSubscription', Date.now() - t1);

    ctx.session.productType = 'premium';
    const lang = this.getUserLanguage(ctx);
    const premiumCap = this.getPremiumRecipientCaptionPayload(lang);
    const recipientKb = MainKeyboard.getRecipientSelection(this.i18n, lang)
      .reply_markup;

    const t2 = Date.now();
    try {
      await this.editOrSendPhoto(ctx, './images/where_delivery_premium.webp', {
        caption: premiumCap.caption,
        caption_entities: premiumCap.caption_entities,
        reply_markup: recipientKb,
      });
    } catch {
      await ctx.reply(premiumCap.caption, {
        entities: premiumCap.caption_entities,
        reply_markup: recipientKb,
      });
    }
    this.perfLog(uid, 'buy_premium', 'editOrSendPhoto', Date.now() - t2);
    this.perfLog(uid, 'buy_premium', 'TOTAL', Date.now() - t0);
  }

  @Action('my_profile')
  async showMyProfile(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    this.resetInputFlags(ctx);

    const lang = this.getUserLanguage(ctx);
    const text = this.i18n.t('profile.title', lang);

    await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: MainKeyboard.getProfileMenu(this.i18n, lang).reply_markup,
    });
  }

  @Action('menu_info')
  async showMenuInfo(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    this.resetInputFlags(ctx);

    const lang = this.getUserLanguage(ctx);
    const reply_markup = MainKeyboard.getInfoMenu(this.i18n, lang).reply_markup;
    const infoImage = this.resolveInfoScreenImage();
    const rich = this.getMenuInfoCaptionPayload(lang);

    try {
      await this.editOrSendPhoto(ctx, infoImage, {
        caption: rich.caption,
        caption_entities: rich.caption_entities,
        reply_markup,
      });
    } catch (err: any) {
      this.logger.warn(`menu_info (caption_entities): ${err?.message ?? err}`);
      const plain = this.getMenuInfoCaptionHtmlFallback(lang);
      try {
        await this.editOrSendPhoto(ctx, infoImage, {
          caption: plain.caption,
          parse_mode: plain.parse_mode,
          reply_markup,
        });
      } catch (err2: any) {
        this.logger.warn(`menu_info (HTML caption): ${err2?.message ?? err2}`);
        try {
          await this.sendCachedPhoto(ctx, infoImage, {
            caption: plain.caption,
            parse_mode: plain.parse_mode,
            reply_markup,
          });
        } catch (err3: any) {
          this.logger.error(`menu_info failed: ${err3?.message ?? err3}`);
          await ctx
            .reply(plain.caption, {
              parse_mode: 'HTML',
              reply_markup,
              link_preview_options: { is_disabled: true },
            })
            .catch(() => {});
        }
      }
    }
  }

  /** Старые клавиатуры с кнопкой «Франшизы» — ведём на тот же экран «Информация». */
  @Action('menu_info_franchises')
  async legacyMenuInfoFranchises(@Ctx() ctx: BotContext): Promise<void> {
    return this.showMenuInfo(ctx);
  }

  /** Устаревшие callback с прошлых клавиатур */
  @Action(
    /^(mops_balance|mops_daily_bonus|mops_coin_info|mops_referral|referral_program|buy_ton)$/,
  )
  async removedOrLegacyRoutes(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    await this.showMainMenu(ctx, true);
  }

  /** Старые клавиатуры с «Оферта и политика» → тот же экран, что «Информация». */
  @Action('public_offer')
  async showPublicOffer(@Ctx() ctx: BotContext): Promise<void> {
    return this.showMenuInfo(ctx);
  }

  @Action('my_purchases')
  @Action(/^purchases_filter_(.+)$/)
  async showMyPurchases(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;
    const user = ctx.from;
    if (!user) return;

    ctx.session.fromAdminSearch = false;

    try {
      const match = ctx.match as RegExpExecArray | null;
      const filter = match ? match[1] : 'all';
      const page = 0;

      await this.showPurchasesPage(ctx, user, filter, page);
    } catch (error) {
      this.logger.error(`Error showing purchases: ${error.message}`);
      const lang = this.getUserLanguage(ctx);
      await ctx.reply(this.i18n.t('purchases.load_error', lang));
    }
  }

  @Action(/^purchases_page_(.+)_(\d+)$/)
  async showPurchasesPage_Action(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;
    const user = ctx.from;
    if (!user) return;

    try {
      const match = ctx.match as RegExpExecArray | null;
      if (!match) return;

      const filter = match[1];
      const page = parseInt(match[2]);

      await this.showPurchasesPage(ctx, user, filter, page);
    } catch (error) {
      this.logger.error(`Error showing purchases page: ${error.message}`);
    }
  }

  private async showPurchasesPage(
    ctx: BotContext,
    user: any,
    filter: string,
    page: number,
  ): Promise<void> {
    const ITEMS_PER_PAGE = 10;
    const lang = this.getUserLanguage(ctx);

    const {
      payments: paymentsToShow,
      totalCount,
      completedCount,
    } = await this.paymentsService.getUserPaymentsFiltered(
      user.id.toString(),
      filter,
      page * ITEMS_PER_PAGE,
      ITEMS_PER_PAGE + 1,
    );

    const hasMore = paymentsToShow.length > ITEMS_PER_PAGE;
    const displayPayments = hasMore
      ? paymentsToShow.slice(0, ITEMS_PER_PAGE)
      : paymentsToShow;

    let text = this.i18n.t('purchases.title', lang);
    text += this.i18n.t('purchases.total', lang, { count: totalCount }) + '\n';
    text += this.i18n.t('purchases.completed', lang, {
      count: completedCount,
    });

    if (displayPayments.length === 0 && page === 0) {
      text += this.i18n.t('purchases.empty', lang);
    } else if (displayPayments.length === 0) {
      text += this.i18n.t('purchases.page_empty', lang);
    } else {
      const filteredTotal =
        filter === 'completed'
          ? completedCount
          : filter === 'failed'
            ? totalCount - completedCount
            : totalCount;
      text += this.i18n.t('purchases.page_info', lang, {
        page: String(page + 1),
        total: String(Math.ceil(filteredTotal / ITEMS_PER_PAGE)),
      });
    }

    await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: MainKeyboard.getMyPurchasesKeyboard(
        displayPayments,
        filter,
        this.i18n,
        lang,
        page,
        hasMore,
      ).reply_markup,
    });
  }

  @Action(/^payment_details_(.+)$/)
  async showPaymentDetails(@Ctx() ctx: BotContext): Promise<void> {
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;
    const user = ctx.from;
    if (!user) return;

    try {
      const match = ctx.match as RegExpExecArray | null;
      if (!match) return;

      const paymentId = match[1];
      const userId = user.id.toString();

      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { fragment_queue: true },
      });

      const lang = this.getUserLanguage(ctx);

      if (!payment || payment.user_telegram_id !== userId) {
        await ctx.reply(this.i18n.t('purchases.not_found', lang));
        return;
      }

      const fq = payment.fragment_queue?.[0];
      const deliveryPending =
        payment.status === 'COMPLETED' &&
        fq &&
        (fq.status === 'PENDING' || fq.status === 'PROCESSING');
      const deliveryFailed =
        payment.status === 'COMPLETED' && fq && fq.status === 'FAILED';

      let statusEmoji: string;
      let statusText: string;
      if (payment.status === 'CANCELLED') {
        statusEmoji = '❌';
        statusText = this.i18n.t('purchases.status.cancelled', lang);
      } else if (payment.status === 'FAILED') {
        statusEmoji = '🔴';
        statusText = this.i18n.t('purchases.status.failed', lang);
      } else if (
        payment.status === 'PENDING' ||
        payment.status === 'PROCESSING'
      ) {
        statusEmoji = '⏳';
        statusText = this.i18n.t('purchases.status.processing', lang);
      } else if (deliveryPending) {
        statusEmoji = '⏳';
        statusText = this.i18n.t('purchases.status.delivering', lang);
      } else if (deliveryFailed) {
        statusEmoji = '⏳';
        statusText = this.i18n.t('purchases.status.delivering', lang);
      } else {
        statusEmoji = '✅';
        statusText = this.i18n.t('purchases.status.completed', lang);
      }

      const productEmoji = getProductEmoji(payment.product_type);
      let productText: string;
      if (payment.product_type === 'STARS') {
        productText = `⭐ STARS x${payment.product_quantity}`;
      } else if (payment.product_type === 'TON') {
        productText = `💎 TON x${payment.product_quantity}`;
      } else if (payment.product_type === 'PREMIUM') {
        productText = `👑 Telegram Premium на ${payment.product_quantity} месяцев`;
      } else {
        productText = `${productEmoji} ${payment.product_type} x${payment.product_quantity}`;
      }

      const isFreekassaCrypto =
        payment.payment_method === 'FREEKASSA' &&
        payment.crypto_currency === 'USD';

      const paymentMethodText =
        payment.payment_method === 'TON'
          ? this.i18n.t('payment.method.ton', lang)
          : payment.payment_method === 'PLATEGA'
            ? this.i18n.t('payment.method.platega', lang)
            : isFreekassaCrypto
              ? this.i18n.t('payment.method.freekassa_crypto', lang)
              : payment.payment_method === 'FREEKASSA'
                ? this.i18n.t('payment.method.freekassa', lang)
                : payment.payment_method === 'HELEKET'
                  ? this.i18n.t('payment.method.heleket', lang)
                  : payment.payment_method;

      let recipientText: string;
      if (payment.recipient_username) {
        recipientText = `@${payment.recipient_username}`;
      } else if (payment.recipient_name) {
        recipientText = payment.recipient_name;
      } else {
        recipientText = payment.recipient || this.i18n.t('common.you', lang);
      }

      let amountText: string;
      if (payment.payment_method === 'TON' && payment.amount_ton) {
        amountText = `${this.i18n.t('purchases.details.amount', lang)} ${Number(payment.amount_ton).toFixed(4)} TON`;
      } else if (payment.payment_method === 'TON' && payment.amount_usd) {
        amountText = `${this.i18n.t('purchases.details.amount', lang)} $${Number(payment.amount_usd).toFixed(2)}`;
      } else if (
        (payment.payment_method === 'HELEKET' || isFreekassaCrypto) &&
        payment.amount_usd
      ) {
        amountText = `${this.i18n.t('purchases.details.amount', lang)} $${Number(payment.amount_usd).toFixed(2)}`;
      } else {
        amountText = `${this.i18n.t('purchases.details.amount', lang)} ${Number(payment.amount_rub).toFixed(2)} ₽`;
      }

      const date = new Date(payment.created_at);
      const formattedDate = formatDateTimeMoscow(date);

      const tonscanLinks: string[] = [];

      if (fq?.tx_hash) {
        const tx = fq.tx_hash.trim();
        const txid = this.normalizeTxForTonscan(tx);
        if (txid) {
          tonscanLinks.push(
            this.i18n.t('purchases.details.tonscan_delivery', lang, { txid }),
          );
        }
      }
      if (payment.payment_method === 'TON' && payment.provider_transaction_id) {
        const txid = this.normalizeTxForTonscan(
          payment.provider_transaction_id.trim(),
        );
        if (txid) {
          tonscanLinks.push(
            this.i18n.t('purchases.details.tonscan', lang, { txid }),
          );
        }
      }
      const tonscanBlock =
        tonscanLinks.length > 0 ? tonscanLinks.join('\n') : '';

      const detailsText = `${this.i18n.t('purchases.details.title', lang)}\n${statusEmoji} ${this.i18n.t('purchases.details.status', lang)} ${statusText}\n🛍 ${this.i18n.t('purchases.details.product', lang)} ${productText}\n${amountText}\n💳 ${this.i18n.t('purchases.details.method', lang)} ${paymentMethodText}\n👤 ${this.i18n.t('purchases.details.recipient', lang)} ${recipientText}\n📅 ${this.i18n.t('purchases.details.date', lang)} ${formattedDate}\n🔑 ${this.i18n.t('purchases.details.order', lang)} <code>#${payment.order_number}</code>${tonscanBlock}`;

      await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
        caption: detailsText,
        parse_mode: 'HTML',
        reply_markup: MainKeyboard.getPaymentDetailsKeyboard(this.i18n, lang)
          .reply_markup,
      });
    } catch (error) {
      this.logger.error(`Error showing payment details: ${error.message}`);
      const lang = this.getUserLanguage(ctx);
      await ctx.reply(this.i18n.t('purchases.details.error', lang));
    }
  }

  @Action('recipient_self')
  async recipientSelf(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.tryAcquireActionLock(ctx, 'recipient_self')) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.callbackQuery?.message) {
      ctx.session.lastBotMessageId = ctx.callbackQuery.message.message_id;
    }

    if (ctx.session.productType === 'ton') {
      ctx.session.productType = undefined;
      await this.showMainMenu(ctx, true);
      return;
    }

    const user = ctx.from;
    if (!user?.username || user.username.trim() === '') {
      const lang = this.getUserLanguage(ctx);

      this.logger.debug(
        `User ${user?.id} tried to send to self without username`,
      );

      const noUsernameText =
        this.i18n.t('username.required.detailed', lang) ||
        `❌ <b>Для отправки себе необходим username</b>\n\n` +
          `Чтобы установить username:\n` +
          `1. Откройте настройки Telegram\n` +
          `2. Нажмите на "Имя пользователя"\n` +
          `3. Установите уникальный username\n\n` +
          `После этого вернитесь и попробуйте снова.`;

      const productType = ctx.session.productType || 'stars';
      const imageMap: Record<string, string> = {
        stars: './images/where_delivery_stars.webp',
        premium: './images/where_delivery_premium.webp',
      };
      const imagePath = imageMap[productType] || './images/main_menu.webp';

      try {
        await this.editOrSendPhoto(ctx, imagePath, {
          caption: noUsernameText,
          parse_mode: 'HTML',
          reply_markup:
            MainKeyboard.getBackButton('back_to_recipient').reply_markup,
        });
      } catch (error: any) {
        if (error?.response?.error_code !== 403) {
          this.logger.error(
            `Error sending no-username message: ${error.message}`,
          );
        }
      }
      return;
    }

    const productType = ctx.session.productType || 'stars';
    const lang = this.getUserLanguage(ctx);

    const imageMap: Record<string, string> = {
      stars: './images/where_delivery_stars.webp',
      premium: './images/where_delivery_premium.webp',
    };
    const imagePath = imageMap[productType] || './images/main_menu.webp';

    if (productType === 'premium' && user?.username) {
      try {
        const fragmentAccount =
          await this.fragmentAccountService.getNextAccount();
        if (!fragmentAccount) {
          this.logger.error('No active Fragment accounts for premium check');
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: this.i18n.t('product.username.check_error', lang),
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
          return;
        }
        const { recipient, info } = await this.fragmentService.getUser(
          fragmentAccount,
          user.username,
          'premium',
        );

        if (!recipient || !recipient.recipient) {
          this.logger.warn(
            `Could not verify premium status for ${user.username} (user ${user.id})`,
          );

          await this.editOrSendPhoto(ctx, imagePath, {
            caption: this.i18n.t('product.username.check_error', lang),
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
          return;
        }

        if (info?.name) {
          ctx.session.recipientName = info.name;
        }
      } catch (validationError: any) {
        if (validationError instanceof FragmentApiError) {
          switch (validationError.errorType) {
            case 'ALREADY_PREMIUM':
              await this.editOrSendPhoto(ctx, imagePath, {
                caption: this.i18n.t('product.username.already_premium', lang, {
                  username: `@${user.username}`,
                }),
                parse_mode: 'HTML',
                reply_markup:
                  MainKeyboard.getBackButton('back_to_recipient').reply_markup,
              });
              return;
            case 'GIFTS_CLOSED':
              await this.editOrSendPhoto(ctx, imagePath, {
                caption: this.i18n.t('product.username.not_found', lang),
                parse_mode: 'HTML',
                reply_markup:
                  MainKeyboard.getBackButton('back_to_recipient').reply_markup,
              });
              return;
            default:
              await this.editOrSendPhoto(ctx, imagePath, {
                caption: this.i18n.t('product.username.check_error', lang),
                parse_mode: 'HTML',
                reply_markup:
                  MainKeyboard.getBackButton('back_to_recipient').reply_markup,
              });
              return;
          }
        } else {
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: this.i18n.t('product.username.check_error', lang),
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
          return;
        }
      }
    }

    ctx.session.isForSelf = true;
    ctx.session.recipientUsername = ctx.from?.username;
    ctx.session.recipientName = ctx.from?.first_name;

    await this.askQuantity(ctx, true);
  }

  @Action('recipient_other')
  async recipientOther(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.tryAcquireActionLock(ctx, 'recipient_other')) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.callbackQuery?.message) {
      ctx.session.lastBotMessageId = ctx.callbackQuery.message.message_id;
    }

    ctx.session.isForSelf = false;

    const lang = this.getUserLanguage(ctx);
    const productType = ctx.session.productType;

    if (!productType) {
      this.logger.warn(
        'recipientOther: productType is undefined, redirecting to main menu',
      );
      await ctx.reply(this.i18n.t('error.session_expired', lang), {
        reply_markup: MainKeyboard.getMainMenu(this.i18n, lang).reply_markup,
      });
      return;
    }

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      await this.showMainMenu(ctx, true);
      return;
    }

    const backKb = MainKeyboard.getBackButton('back_to_recipient').reply_markup;

    const imagePath =
      productType === 'premium'
        ? './images/where_delivery_premium.webp'
        : productType === 'stars'
          ? './images/where_delivery_stars.webp'
          : './images/main_menu.webp';

    if (productType === 'stars') {
      const cap = this.getStarsUsernameEnterCaptionPayload(
        lang,
        ctx.from?.username,
      );
      try {
        await this.editOrSendPhoto(ctx, imagePath, {
          caption: cap.caption,
          caption_entities: cap.caption_entities,
          reply_markup: backKb,
        });
      } catch {
        const message = await ctx.reply(cap.caption, {
          entities: cap.caption_entities,
          reply_markup: backKb,
        });
        ctx.session.lastBotMessageId = message.message_id;
      }
      ctx.session.awaitingUsername = true;
      return;
    }

    if (productType === 'premium') {
      const cap = this.getPremiumUsernameEnterCaptionPayload(
        lang,
        ctx.from?.username,
      );
      try {
        await this.editOrSendPhoto(ctx, imagePath, {
          caption: cap.caption,
          caption_entities: cap.caption_entities,
          reply_markup: backKb,
        });
      } catch {
        const message = await ctx.reply(cap.caption, {
          entities: cap.caption_entities,
          reply_markup: backKb,
        });
        ctx.session.lastBotMessageId = message.message_id;
      }
      ctx.session.awaitingUsername = true;
      return;
    }

    const productEmoji = getProductEmoji(
      (productType as string).toUpperCase(),
    );
    const productName = this.i18n.t('product.premium', lang);
    const text = this.i18n.t('product.recipient.enter_username', lang, {
      product: productName,
      emoji: productEmoji,
    });

    try {
      await this.editOrSendPhoto(ctx, imagePath, {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: backKb,
      });
    } catch {
      const message = await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: backKb,
      });
      ctx.session.lastBotMessageId = message.message_id;
    }

    ctx.session.awaitingUsername = true;
  }

  private async askQuantity(
    ctx: BotContext,
    edit: boolean = false,
  ): Promise<void> {
    const productType = ctx.session.productType;
    if (!productType) return;

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      ctx.session.quantity = undefined;
      await this.showMainMenu(ctx, edit);
      return;
    }

    const lang = this.getUserLanguage(ctx);

    if (productType === 'premium') {
      const premCap = this.getPremiumDurationPickCaptionPayload();
      const premKb = MainKeyboard.getPremiumDurationKeyboard(
        this.i18n,
        lang,
      ).reply_markup;
      const premiumDurationImage = this.resolvePremiumDurationImage();

      if (edit) {
        try {
          await this.editOrSendPhoto(ctx, premiumDurationImage, {
            caption: premCap.caption,
            caption_entities: premCap.caption_entities,
            reply_markup: premKb,
          });
        } catch {
          await ctx.reply(premCap.caption, {
            entities: premCap.caption_entities,
            reply_markup: premKb,
          });
        }
      } else {
        try {
          ctx.deleteMessage().catch(() => {});
        } catch {}
        try {
          await ctx.replyWithPhoto(
            { source: premiumDurationImage },
            {
              caption: premCap.caption,
              caption_entities: premCap.caption_entities,
              reply_markup: premKb,
            },
          );
        } catch {
          await ctx.reply(premCap.caption, {
            entities: premCap.caption_entities,
            reply_markup: premKb,
          });
        }
      }
    } else if (productType === 'stars') {
      const limits = await this.settingsService.getPurchaseLimits();
      const minAmount = limits.minStars;
      const maxAmount = limits.maxStars;

      const qtyCap = this.getStarsQuantityPickCaptionPayload(
        minAmount,
        maxAmount,
      );

      const imagePath = './images/new/starsIn5min.png';
      const qtyKb = MainKeyboard.getStarsQuantityKeyboard(
        this.i18n,
        lang,
        minAmount,
        maxAmount,
        'pick',
      ).reply_markup;

      if (edit) {
        try {
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: qtyCap.caption,
            caption_entities: qtyCap.caption_entities,
            reply_markup: qtyKb,
          });
        } catch {
          const sentMessage = await ctx.reply(qtyCap.caption, {
            entities: qtyCap.caption_entities,
            reply_markup: qtyKb,
          });
          ctx.session.lastBotMessageId = sentMessage.message_id;
        }
      } else {
        try {
          ctx.deleteMessage().catch(() => {});
        } catch {}
        try {
          const sentMessage = await ctx.replyWithPhoto(
            { source: imagePath },
            {
              caption: qtyCap.caption,
              caption_entities: qtyCap.caption_entities,
              reply_markup: qtyKb,
            },
          );
          ctx.session.lastBotMessageId = sentMessage.message_id;
        } catch {
          const sentMessage = await ctx.reply(qtyCap.caption, {
            entities: qtyCap.caption_entities,
            reply_markup: qtyKb,
          });
          ctx.session.lastBotMessageId = sentMessage.message_id;
        }
      }

      ctx.session.awaitingUsername = false;
      ctx.session.awaitingQuantity = false;
    } else {
      ctx.session.productType = undefined;
      await this.showMainMenu(ctx, edit);
    }
  }

  private static isMessageNotModifiedError(error: any): boolean {
    const desc =
      error?.response?.description ??
      error?.description ??
      error?.message ??
      '';
    return String(desc).toLowerCase().includes('message is not modified');
  }

  private async editLastBotMessageWithError(
    ctx: BotContext,
    errorText: string,
    backCallback: string = 'back_to_recipient',
  ): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const messageId = ctx.session.lastBotMessageId;
    if (!chatId || !messageId) return false;

    const lang = this.getUserLanguage(ctx);
    const reply_markup = MainKeyboard.getBackButton(backCallback).reply_markup;

    try {
      await ctx.telegram.editMessageCaption(
        chatId,
        messageId,
        undefined,
        errorText,
        { parse_mode: 'HTML', reply_markup },
      );
      return true;
    } catch (err: any) {
      if (BotUpdate.isMessageNotModifiedError(err)) return true;
      try {
        await ctx.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          errorText,
          { parse_mode: 'HTML', reply_markup },
        );
        return true;
      } catch (err2: any) {
        if (BotUpdate.isMessageNotModifiedError(err2)) return true;
        return false;
      }
    }
  }

  private async editQuantityMessageWithError(
    ctx: BotContext,
    errorText: string,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const messageId = ctx.session.lastBotMessageId;
    if (!chatId || !messageId) return false;

    const lang = this.getUserLanguage(ctx);
    let reply_markup =
      MainKeyboard.getBackButton('back_to_recipient').reply_markup;
    if (ctx.session.productType === 'stars') {
      const { minStars, maxStars } =
        await this.settingsService.getPurchaseLimits();
      reply_markup = MainKeyboard.getStarsQuantityKeyboard(
        this.i18n,
        lang,
        minStars,
        maxStars,
        'manual',
      ).reply_markup;
    }

    try {
      await ctx.telegram.editMessageCaption(
        chatId,
        messageId,
        undefined,
        errorText,
        { parse_mode: 'HTML', reply_markup },
      );
      return true;
    } catch (err: any) {
      if (BotUpdate.isMessageNotModifiedError(err)) return true;
      try {
        await ctx.telegram.editMessageText(
          chatId,
          messageId,
          undefined,
          errorText,
          { parse_mode: 'HTML', reply_markup },
        );
        return true;
      } catch (err2: any) {
        if (BotUpdate.isMessageNotModifiedError(err2)) return true;
        return false;
      }
    }
  }

  private async askQuantityByMessageId(ctx: BotContext): Promise<void> {
    const productType = ctx.session.productType;
    if (!productType) return;

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      ctx.session.quantity = undefined;
      await this.showMainMenu(ctx, false);
      return;
    }

    const lang = this.getUserLanguage(ctx);
    const chatId = ctx.chat?.id;
    const messageId = ctx.session.lastBotMessageId;

    if (productType === 'premium') {
      const premCap = this.getPremiumDurationPickCaptionPayload();
      const keyboard = MainKeyboard.getPremiumDurationKeyboard(this.i18n, lang);
      const imagePath = this.resolvePremiumDurationImage();
      const media = await this.getMediaSource(imagePath);

      if (messageId && chatId) {
        try {
          const result = await ctx.telegram.editMessageMedia(
            chatId,
            messageId,
            undefined,
            {
              type: 'photo',
              media,
              caption: premCap.caption,
              caption_entities: premCap.caption_entities,
            },
            { reply_markup: keyboard.reply_markup },
          );
          ctx.session.currentImage = imagePath;
          this.cacheFileIdFromResult(imagePath, result);
          return;
        } catch (error) {
          this.logger.debug(`Edit by ID failed: ${error.message}`);
        }
      }

      const msg = await this.sendCachedPhoto(ctx, imagePath, {
        caption: premCap.caption,
        caption_entities: premCap.caption_entities,
        reply_markup: keyboard.reply_markup,
      });
      ctx.session.lastBotMessageId = msg.message_id;
    } else if (productType === 'stars') {
      const limits = await this.settingsService.getPurchaseLimits();
      const minAmount = limits.minStars;
      const maxAmount = limits.maxStars;

      const qtyCap = this.getStarsQuantityPickCaptionPayload(
        minAmount,
        maxAmount,
      );

      const imagePath = './images/new/starsIn5min.png';

      const qtyKb = MainKeyboard.getStarsQuantityKeyboard(
        this.i18n,
        lang,
        minAmount,
        maxAmount,
        'pick',
      ).reply_markup;
      const media = await this.getMediaSource(imagePath);

      if (messageId && chatId) {
        try {
          const result = await ctx.telegram.editMessageMedia(
            chatId,
            messageId,
            undefined,
            {
              type: 'photo',
              media,
              caption: qtyCap.caption,
              caption_entities: qtyCap.caption_entities,
            },
            { reply_markup: qtyKb },
          );
          ctx.session.currentImage = imagePath;
          ctx.session.awaitingUsername = false;
          ctx.session.awaitingQuantity = false;
          this.cacheFileIdFromResult(imagePath, result);
          return;
        } catch (error) {
          this.logger.debug(`Edit by ID failed: ${error.message}`);
        }
      }

      const msg = await this.sendCachedPhoto(ctx, imagePath, {
        caption: qtyCap.caption,
        caption_entities: qtyCap.caption_entities,
        reply_markup: qtyKb,
      });
      ctx.session.lastBotMessageId = msg.message_id;
      ctx.session.awaitingUsername = false;
      ctx.session.awaitingQuantity = false;
    }
  }

  @Action(/^premium_duration_(\d+)$/)
  async selectPremiumDuration(@Ctx() ctx: BotContext): Promise<void> {
    const match = ctx.match;
    if (!match) return;

    if (!this.tryAcquireActionLock(ctx, `premium_duration_${match[1]}`)) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.session.productType !== 'premium') {
      await this.showMainMenu(ctx, true);
      return;
    }

    const months = parseInt(match[1]);

    ctx.session.quantity = months;
    await this.showPaymentMethods(ctx, true);
  }

  @Action('stars_qty_manual')
  async starsQtyManual(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.tryAcquireActionLock(ctx, 'stars_qty_manual')) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.session.productType !== 'stars') {
      await this.showMainMenu(ctx, true);
      return;
    }

    const lang = this.getUserLanguage(ctx);
    const limits = await this.settingsService.getPurchaseLimits();
    const minAmount = limits.minStars;
    const maxAmount = limits.maxStars;

    const text = this.i18n.t('product.quantity.stars.manual_caption', lang, {
      min: minAmount.toLocaleString('ru-RU'),
      max: maxAmount.toLocaleString('ru-RU'),
    });

    const qtyKb = MainKeyboard.getStarsQuantityKeyboard(
      this.i18n,
      lang,
      minAmount,
      maxAmount,
      'manual',
    ).reply_markup;

    const chatId = ctx.chat?.id;
    const mq = ctx.callbackQuery?.message;
    const messageId =
      mq && 'message_id' in mq ? mq.message_id : ctx.session.lastBotMessageId;

    if (chatId && messageId) {
      try {
        await ctx.telegram.editMessageCaption(
          chatId,
          messageId,
          undefined,
          text,
          { parse_mode: 'HTML', reply_markup: qtyKb },
        );
        ctx.session.lastBotMessageId = messageId;
      } catch (err: any) {
        if (!BotUpdate.isMessageNotModifiedError(err)) {
          try {
            await ctx.telegram.editMessageText(
              chatId,
              messageId,
              undefined,
              text,
              { parse_mode: 'HTML', reply_markup: qtyKb },
            );
            ctx.session.lastBotMessageId = messageId;
          } catch {
            /* fall through */
          }
        }
      }
    }

    ctx.session.awaitingQuantity = true;
  }

  @Action(/^stars_qty_(\d+)$/)
  async selectStarsQtyPreset(@Ctx() ctx: BotContext): Promise<void> {
    const match = ctx.match;
    if (!match) return;

    const qty = parseInt(match[1], 10);
    if (!this.tryAcquireActionLock(ctx, `stars_qty_${qty}`)) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }
    ctx.answerCbQuery().catch(() => {});
    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.session.productType !== 'stars') {
      await this.showMainMenu(ctx, true);
      return;
    }

    const lang = this.getUserLanguage(ctx);
    const { minStars, maxStars } =
      await this.settingsService.getPurchaseLimits();
    if (qty < minStars || qty > maxStars) {
      const errText = this.i18n.t('product.quantity.range', lang, {
        min: minStars.toString(),
        max: maxStars.toString(),
        emoji: '⭐️',
      });
      await ctx.reply(errText, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    ctx.session.quantity = qty;
    ctx.session.awaitingQuantity = false;

    const mq = ctx.callbackQuery?.message;
    if (mq && 'message_id' in mq) {
      ctx.session.lastBotMessageId = mq.message_id;
    }

    await this.showPaymentMethodsByMessageId(ctx);
  }

  private async showPaymentMethods(
    ctx: BotContext,
    edit: boolean = false,
  ): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    const { productType, quantity, recipientUsername } = ctx.session;
    const user = ctx.from;

    if (!productType || !quantity) {
      await ctx.reply(this.i18n.t('payment.restart', lang));
      return;
    }

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      ctx.session.quantity = undefined;
      await this.showMainMenu(ctx, edit);
      return;
    }

    try {
      const cachedRates = await this.rapiraService.getCachedRates();

      const rateCheck = await this.settingsService.checkRateProtection(
        cachedRates.tonToUsd,
        cachedRates.usdtToRub,
      );

      if (!rateCheck.allowed) {
        this.logger.warn(
          `Payment methods blocked due to rate protection: ${rateCheck.reason}`,
        );

        this.eventEmitter.emit('rate.protection.triggered', {
          reason: rateCheck.reason,
          userTelegramId: String(user?.id || ''),
          tonRate: cachedRates.tonToUsd,
          usdtRate: cachedRates.usdtToRub,
        });

        const errorText = this.i18n.t('payment.rate_protection', lang, {
          reason: rateCheck.reason || 'Exchange rate is too low',
        });

        if (edit) {
          await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
            caption: errorText,
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_main').reply_markup,
          });
        } else {
          try {
            ctx.deleteMessage().catch(() => {});
          } catch {}
          await ctx.reply(errorText, {
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_main').reply_markup,
          });
        }
        return;
      }

      const [prices, enabledMethods, { sbpLimitRub }] = await Promise.all([
        this.pricingService.getAllPricesForProduct(
          productType.toUpperCase(),
          quantity,
        ),
        this.settingsService.getEnabledPaymentMethods(),
        this.settingsService.getPurchaseLimits(),
      ]);

      const tonAmount = prices.ton.usd / cachedRates.tonToUsd;

      let recipientDisplay: string;
      if (ctx.session.isForSelf) {
        const userName =
          user?.first_name || this.i18n.t('common.you', lang);
        const userUsername = ctx.from?.username;
        recipientDisplay = userUsername
          ? `${userName} (@${userUsername})`
          : userName;
      } else if (recipientUsername) {
        recipientDisplay = `@${recipientUsername}`;
      } else {
        recipientDisplay = this.i18n.t('common.you', lang);
      }

      const paymentCaption = this.buildPaymentMethodsCaptionPayload(
        lang,
        productType,
        quantity,
        recipientDisplay,
      );

      const paymentHero = this.paymentMethodsHeroImage(productType);

      if (edit) {
        try {
          await this.editOrSendPhoto(ctx, paymentHero, {
            caption: paymentCaption.caption,
            caption_entities: paymentCaption.caption_entities,
            reply_markup: MainKeyboard.getPaymentMethodKeyboard(
              prices,
              tonAmount,
              this.i18n,
              lang,
              enabledMethods,
              sbpLimitRub,
            ).reply_markup,
          });
        } catch {
          await ctx.reply(paymentCaption.caption, {
            entities: paymentCaption.caption_entities,
            reply_markup: MainKeyboard.getPaymentMethodKeyboard(
              prices,
              tonAmount,
              this.i18n,
              lang,
              enabledMethods,
              sbpLimitRub,
            ).reply_markup,
          });
        }
      } else {
        try {
          ctx.deleteMessage().catch(() => {});
        } catch {}
        try {
          await ctx.replyWithPhoto(
            { source: paymentHero },
            {
              caption: paymentCaption.caption,
              caption_entities: paymentCaption.caption_entities,
              reply_markup: MainKeyboard.getPaymentMethodKeyboard(
                prices,
                tonAmount,
                this.i18n,
                lang,
                enabledMethods,
                sbpLimitRub,
              ).reply_markup,
            },
          );
        } catch {
          await ctx.reply(paymentCaption.caption, {
            entities: paymentCaption.caption_entities,
            reply_markup: MainKeyboard.getPaymentMethodKeyboard(
              prices,
              tonAmount,
              this.i18n,
              lang,
              enabledMethods,
              sbpLimitRub,
            ).reply_markup,
          });
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Price calculation error in showPaymentMethods: ${error.message}`,
        error.stack,
      );
      await ctx.reply(this.i18n.t('payment.calc_error', lang));
    }
  }

  private async showPaymentMethodsByMessageId(ctx: BotContext): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    const { productType, quantity, recipientUsername } = ctx.session;
    const user = ctx.from;
    const chatId = ctx.chat?.id;
    const messageId = ctx.session.lastBotMessageId;

    if (!productType || !quantity || !chatId) {
      await ctx.reply(this.i18n.t('payment.restart', lang));
      return;
    }

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      ctx.session.quantity = undefined;
      await this.showMainMenu(ctx, false);
      return;
    }

    try {
      const cachedRates = await this.rapiraService.getCachedRates();

      const rateCheck = await this.settingsService.checkRateProtection(
        cachedRates.tonToUsd,
        cachedRates.usdtToRub,
      );

      if (!rateCheck.allowed) {
        this.eventEmitter.emit('rate.protection.triggered', {
          reason: rateCheck.reason,
          userTelegramId: String(user?.id || ''),
          tonRate: cachedRates.tonToUsd,
          usdtRate: cachedRates.usdtToRub,
        });

        const errorText = this.i18n.t('payment.rate_protection', lang, {
          reason: rateCheck.reason || 'Exchange rate is too low',
        });
        await ctx.reply(errorText, {
          parse_mode: 'HTML',
          reply_markup: MainKeyboard.getBackButton('back_to_main').reply_markup,
        });
        return;
      }

      const [prices, enabledMethods, { sbpLimitRub }] = await Promise.all([
        this.pricingService.getAllPricesForProduct(
          productType.toUpperCase(),
          quantity,
        ),
        this.settingsService.getEnabledPaymentMethods(),
        this.settingsService.getPurchaseLimits(),
      ]);
      const tonAmount = prices.ton.usd / cachedRates.tonToUsd;

      let recipientDisplay: string;
      if (ctx.session.isForSelf) {
        const userName =
          user?.first_name || this.i18n.t('common.you', lang);
        const userUsername = ctx.from?.username;
        recipientDisplay = userUsername
          ? `${userName} (@${userUsername})`
          : userName;
      } else if (recipientUsername) {
        recipientDisplay = `@${recipientUsername}`;
      } else {
        recipientDisplay = this.i18n.t('common.you', lang);
      }

      const paymentCaption = this.buildPaymentMethodsCaptionPayload(
        lang,
        productType,
        quantity,
        recipientDisplay,
      );

      const keyboard = MainKeyboard.getPaymentMethodKeyboard(
        prices,
        tonAmount,
        this.i18n,
        lang,
        enabledMethods,
        sbpLimitRub,
      );
      const imagePath = this.paymentMethodsHeroImage(productType);
      const media = await this.getMediaSource(imagePath);

      if (messageId) {
        try {
          const result = await ctx.telegram.editMessageMedia(
            chatId,
            messageId,
            undefined,
            {
              type: 'photo',
              media,
              caption: paymentCaption.caption,
              caption_entities: paymentCaption.caption_entities,
            },
            { reply_markup: keyboard.reply_markup },
          );
          ctx.session.currentImage = imagePath;
          this.cacheFileIdFromResult(imagePath, result);
          return;
        } catch (error) {
          this.logger.debug(`Edit by ID failed: ${error.message}`);
        }
      }

      const msg = await withRetry(
        () =>
          this.sendCachedPhoto(ctx, imagePath, {
            caption: paymentCaption.caption,
            caption_entities: paymentCaption.caption_entities,
            reply_markup: keyboard.reply_markup,
          }),
        {
          maxAttempts: 2,
          delayMs: 0,
          exponentialBackoff: false,
          shouldRetry: (err: any) =>
            !err?.response?.error_code || err.response.error_code >= 500,
        },
      );
      ctx.session.lastBotMessageId = msg.message_id;
    } catch (error: any) {
      this.logger.error(
        `Price calculation error in showPaymentMethodsByMessageId: ${error.message}`,
        error.stack,
      );
      await ctx.reply(this.i18n.t('payment.calc_error', lang)).catch(() => {});
    }
  }

  @Action(/^payment_(platega|freekassa|freekassa_crypto|ton)$/)
  async selectPaymentMethod(@Ctx() ctx: BotContext): Promise<void> {
    const match = ctx.match;
    if (!match) return;

    const paymentMethod = match[1] as
      | 'platega'
      | 'freekassa'
      | 'freekassa_crypto'
      | 'ton';
    const userId = ctx.from?.id;

    if (
      !(await this.tryAcquireActionLockRedis(
        ctx,
        `payment_${paymentMethod}`,
        30,
      ))
    ) {
      await ctx
        .answerCbQuery('⏳ Подождите...', { show_alert: false })
        .catch(() => {});
      return;
    }

    try {
      ctx.answerCbQuery().catch(() => {});
      if (!(await this.checkSubscriptionMiddleware(ctx))) return;

      if (!(await this.checkUserAccess(ctx))) return;

      await this.processPaymentCreation(ctx, paymentMethod);
    } finally {
      if (userId) {
        await this.releaseActionLockRedis(userId, `payment_${paymentMethod}`);
      }
    }
  }

  private async processPaymentCreation(
    ctx: BotContext,
    paymentMethod: 'platega' | 'freekassa' | 'freekassa_crypto' | 'ton',
  ): Promise<void> {
    const userId = ctx.from?.id;

    if (!(await this.tryAcquireActionLockRedis(ctx, `payment_creation`, 30))) {
      await ctx.answerCbQuery('⏳', { show_alert: false }).catch(() => {});
      return;
    }

    try {
      await this.doProcessPaymentCreation(ctx, paymentMethod);
    } finally {
      if (userId) {
        await this.releaseActionLockRedis(userId, `payment_creation`);
      }
    }
  }

  private async doProcessPaymentCreation(
    ctx: BotContext,
    paymentMethod: 'platega' | 'freekassa' | 'freekassa_crypto' | 'ton',
  ): Promise<void> {
    const { productType, quantity, recipientUsername, recipientName } =
      ctx.session;

    const lang = this.getUserLanguage(ctx);

    if (!productType || !quantity) {
      await ctx.reply(this.i18n.t('payment.restart', lang));
      return;
    }

    if (productType === 'ton') {
      ctx.session.productType = undefined;
      ctx.session.quantity = undefined;
      await this.showMainMenu(ctx, true);
      return;
    }

    if (productType === 'stars') {
      const { minStars, maxStars } =
        await this.settingsService.getPurchaseLimits();
      if (quantity < minStars || quantity > maxStars) {
        await ctx.reply(this.i18n.t('payment.restart', lang));
        return;
      }
    } else if (productType === 'premium') {
      if (![3, 6, 12].includes(quantity)) {
        await ctx.reply(this.i18n.t('payment.restart', lang));
        return;
      }
    } else {
      await this.showMainMenu(ctx, true);
      return;
    }

    try {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      const limits = await this.settingsService.getPurchaseLimits();
      const isSbpOrCard =
        paymentMethod === 'platega' || paymentMethod === 'freekassa';

      const pricingKey =
        paymentMethod === 'freekassa_crypto' ? 'heleket' : paymentMethod;

      const cryptoFkCurId = parseInt(
        process.env.FREEKASSA_CRYPTO_CUR_ID || '15',
        10,
      );

      let effectiveQuantity = quantity;
      let showSbpStarsCapNotice = false;
      if (
        isSbpOrCard &&
        productType === 'stars' &&
        quantity > limits.sbpLimitStars
      ) {
        effectiveQuantity = limits.sbpLimitStars;
        showSbpStarsCapNotice = true;
      }

      const [cachedRates, dbUser, priceDetails] = await Promise.all([
        this.rapiraService.getCachedRates(),
        this.userService.findByTelegramId(userId),
        this.pricingService.calculatePriceForPaymentSystemDetailed(
          productType.toUpperCase(),
          effectiveQuantity,
          pricingKey,
        ),
      ]);

      if (
        isSbpOrCard &&
        productType !== 'stars' &&
        priceDetails.amount_rub > limits.sbpLimitRub
      ) {
        this.logger.warn(
          `${paymentMethod.toUpperCase()} payment rejected: amount ${priceDetails.amount_rub} RUB exceeds ${limits.sbpLimitRub} RUB limit`,
        );
        const errorText =
          this.i18n.t('payment.platega_limit_exceeded', lang) ||
          `❌ Сумма (${priceDetails.amount_rub.toFixed(2)} ₽) превышает лимит СБП/карты.\n\nВыберите другой способ оплаты.`;
        await ctx.reply(errorText, {
          parse_mode: 'HTML',
          reply_markup: MainKeyboard.getBackButton('back_to_main').reply_markup,
        });
        return;
      }

      if (!dbUser) {
        throw new Error('User not found');
      }

      const rateCheck = await this.settingsService.checkRateProtection(
        cachedRates.tonToUsd,
        cachedRates.usdtToRub,
      );

      if (!rateCheck.allowed) {
        this.logger.warn(
          `Purchase blocked due to rate protection: ${rateCheck.reason}`,
        );

        this.eventEmitter.emit('rate.protection.triggered', {
          reason: rateCheck.reason,
          userTelegramId: userId,
          tonRate: cachedRates.tonToUsd,
          usdtRate: cachedRates.usdtToRub,
        });

        const errorText = this.i18n.t('payment.rate_protection', lang, {
          reason: rateCheck.reason || 'Exchange rate is too low',
        });
        await ctx.reply(errorText, {
          parse_mode: 'HTML',
          reply_markup: MainKeyboard.getBackButton('back_to_main').reply_markup,
        });
        return;
      }

      const amountTon =
        paymentMethod === 'ton'
          ? priceDetails.amount_usd / cachedRates.tonToUsd
          : undefined;

      if (paymentMethod !== 'ton') {
        await this.editOrSendPhoto(ctx, './images/main_menu.webp', {
          caption: this.i18n.t('payment.creating', lang),
          parse_mode: 'HTML',
        }).catch(() => {});
      }

      const prismaPaymentMethod =
        paymentMethod === 'freekassa' || paymentMethod === 'freekassa_crypto'
          ? 'FREEKASSA'
          : paymentMethod.toUpperCase();

      const payment = await this.paymentsService.createPayment({
        user_id: dbUser.id,
        user_telegram_id: userId,
        recipient: recipientUsername || recipientName || 'self',
        recipient_username: recipientUsername,
        recipient_name: recipientName,
        payment_method: prismaPaymentMethod as any,
        payment_system: prismaPaymentMethod as any,
        product_type: productType.toUpperCase() as any,
        product_quantity: effectiveQuantity.toString(),
        amount_rub: priceDetails.amount_rub.toString(),
        amount_usd: priceDetails.amount_usd.toString(),
        amount_crypto:
          paymentMethod === 'ton'
            ? amountTon?.toString()
            : paymentMethod === 'freekassa_crypto'
              ? priceDetails.amount_usd.toString()
              : undefined,
        amount_ton: amountTon?.toString(),
        crypto_currency:
          paymentMethod === 'ton'
            ? 'TON'
            : paymentMethod === 'freekassa_crypto'
              ? 'USD'
              : undefined,
        usd_rate: priceDetails.usd_rate.toString(),
        service_markup_percent: priceDetails.service_markup_percent.toString(),
        payment_system_fee_percent: priceDetails.payment_fee_percent.toString(),
        purchase_price_usd: priceDetails.purchase_price_usd.toString(),
        net_profit_rub: priceDetails.net_profit_rub.toString(),
        freekassa_suggested_method_id:
          paymentMethod === 'freekassa_crypto' &&
          Number.isFinite(cryptoFkCurId) &&
          cryptoFkCurId > 0
            ? cryptoFkCurId
            : undefined,
      });

      if (paymentMethod === 'ton') {
        await this.showTonPayment(ctx, payment, amountTon);
      } else {
        if (!payment.payment_url || payment.payment_url === '#') {
          this.logger.error(
            `Payment ${payment.id} created without valid payment_url for method ${paymentMethod}`,
          );
          throw new Error('Payment URL was not generated');
        }

        const paymentMethodDisplay =
          paymentMethod === 'platega'
            ? this.i18n.t('payment.method.platega', lang)
            : paymentMethod === 'freekassa'
              ? this.i18n.t('payment.method.freekassa', lang)
              : paymentMethod === 'freekassa_crypto'
                ? this.i18n.t('payment.method.freekassa_crypto', lang)
                : this.i18n.t('payment.method.ton', lang);

        let recipientDisplay: string;
        if (payment.recipient_username && payment.recipient_name) {
          recipientDisplay = `${escapeHtml(payment.recipient_name)} (@${payment.recipient_username})`;
        } else if (payment.recipient_username) {
          recipientDisplay = `@${payment.recipient_username}`;
        } else if (payment.recipient_name) {
          recipientDisplay = escapeHtml(payment.recipient_name);
        } else {
          const userName = escapeHtml(
            ctx.from?.first_name || this.i18n.t('common.you', lang),
          );
          const userUsername = ctx.from?.username;
          recipientDisplay = userUsername
            ? `${userName} (@${userUsername})`
            : userName;
        }

        let amountDisplay: string;
        if (
          paymentMethod === 'freekassa_crypto' &&
          payment.amount_crypto &&
          payment.crypto_currency
        ) {
          amountDisplay = this.i18n.t('payment.other.amount_crypto', lang, {
            amount: Number(payment.amount_crypto).toFixed(2),
            currency: payment.crypto_currency,
          });
        } else {
          amountDisplay = this.i18n.t('payment.other.amount', lang, {
            amount: Number(payment.amount_rub).toFixed(2),
          });
        }

        let productNameForWarning: string;
        if (productType.toUpperCase() === 'STARS') {
          productNameForWarning = 'ЗВЕЗД';
        } else if (productType.toUpperCase() === 'TON') {
          productNameForWarning = 'TON';
        } else if (productType.toUpperCase() === 'PREMIUM') {
          productNameForWarning = 'PREMIUM';
        } else {
          productNameForWarning = 'ТОВАРА';
        }

        const productLine = this.i18n.t('payment.product', lang, {
          quantity: payment.product_quantity,
          emoji: getProductEmoji(productType.toUpperCase()),
        });
        let paymentText = `${this.i18n.t('payment.other.title', lang, { method: paymentMethodDisplay })}\n${this.i18n.t('payment.other.recipient', lang, { recipient: recipientDisplay })}\n\n${productLine}\n\n`;
        if (showSbpStarsCapNotice) {
          paymentText +=
            this.i18n.t('payment.sbp_stars_cap', lang, {
              max: limits.sbpLimitStars.toLocaleString('ru'),
            }) + '\n\n';
        }
        paymentText += `${this.i18n.t('payment.other.username_warning', lang, { product: productNameForWarning })}\n\n${amountDisplay}\n${this.i18n.t('payment.other.order', lang, { order: payment.order_number.toString() })}\n\n${this.i18n.t('payment.other.warning', lang)}\n\n${this.i18n.t('payment.other.link', lang)}`;

        const paymentMessage = await this.editOrSendPhoto(
          ctx,
          './images/main_menu.webp',
          {
            caption: paymentText,
            parse_mode: 'HTML',
            reply_markup: MainKeyboard.getPaymentUrlKeyboard(
              payment.payment_url,
              this.i18n,
              lang,
            ).reply_markup,
          },
        );

        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            payment_message_id: paymentMessage.message_id.toString(),
          },
        });
      }

      ctx.session = {};
    } catch (error) {
      this.logger.error(
        `Error creating payment for user ${ctx.from?.id}: ${error.message}`,
        error.stack,
      );
      const lang = this.getUserLanguage(ctx);
      await ctx.reply(this.i18n.t('payment.create_error', lang));
    }
  }

  private async showTonPayment(
    ctx: BotContext,
    payment: any,
    amountTon: number,
  ): Promise<void> {
    const lang = this.getUserLanguage(ctx);
    const tonAddress = process.env.WALLET_ADDRESS || '';
    const tonLink = `ton://transfer/${tonAddress}?amount=${Math.floor(amountTon * 1e9)}&text=${payment.id}`;

    let recipientDisplay: string;
    if (payment.recipient_name && payment.recipient_username) {
      recipientDisplay = `${payment.recipient_name} (@${payment.recipient_username})`;
    } else if (payment.recipient_username) {
      recipientDisplay = `@${payment.recipient_username}`;
    } else if (payment.recipient_name) {
      recipientDisplay = payment.recipient_name;
    } else {
      recipientDisplay = this.i18n.t('common.you', lang);
    }

    const tonCaption = this.buildTonPaymentCaptionPayload(lang, {
      productType: payment.product_type,
      quantity: Number(payment.product_quantity) || 0,
      recipientDisplayPlain: recipientDisplay,
      amountTonFormatted: amountTon.toFixed(4),
      orderNumber: payment.order_number.toString(),
      address: tonAddress,
      comment: payment.id,
    });

    const tonKeyboard = MainKeyboard.getTonPayKeyboard(
      tonLink,
      this.i18n,
      lang,
    ).reply_markup;

    let paymentMessageId: number | undefined;

    try {
      const qrCodeBuffer = await QRCode.toBuffer(tonLink, {
        type: 'png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
      });

      try {
        const editResult = await ctx.editMessageMedia(
          {
            type: 'photo',
            media: { source: qrCodeBuffer },
            caption: tonCaption.caption,
            caption_entities: tonCaption.caption_entities,
          },
          {
            reply_markup: tonKeyboard,
          },
        );
        if (typeof editResult === 'object' && 'message_id' in editResult) {
          paymentMessageId = editResult.message_id;
        }
      } catch {
        const qrMessage = await ctx.replyWithPhoto(
          { source: qrCodeBuffer },
          {
            caption: tonCaption.caption,
            caption_entities: tonCaption.caption_entities,
            reply_markup: tonKeyboard,
          },
        );
        paymentMessageId = qrMessage.message_id;
      }
    } catch (error) {
      this.logger.error(`Error sending QR code: ${error.message}`);
      const textMessage = await ctx.reply(tonCaption.caption, {
        entities: tonCaption.caption_entities,
        reply_markup: tonKeyboard,
      });
      paymentMessageId = textMessage.message_id;
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        payment_message_id: paymentMessageId?.toString(),
      },
    });
  }

  @On('text')
  async onTextMessage(@Ctx() ctx: BotContext): Promise<void> {
    const text = (ctx.message as any)?.text;
    if (!text) return;

    if (text.startsWith('/')) {
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) return;

    const lang = this.getUserLanguage(ctx);

    const startButtonText = this.i18n.t('keyboard.start', lang);

    if (
      text === startButtonText ||
      text === '🏠 Главное меню' ||
      text === '🏠 Main Menu' ||
      text === '🏠 主菜单' ||
      text === '🏠 मुख्य मेनू' ||
      text === '🏠 На хату'
    ) {
      return await this.onStart(ctx);
    }

    if (!(await this.checkSubscriptionMiddleware(ctx))) return;

    if (ctx.session.awaitingUsername) {
      ctx.session.awaitingUsername = false;

      ctx.deleteMessage().catch(() => {});

      if (ctx.session.productType === 'ton') {
        ctx.session.productType = undefined;
        await this.showMainMenu(ctx, false);
        return;
      }

      let username = text.trim();

      if (username.startsWith('@')) {
        username = username.substring(1);
      }

      const telegramLinkRegex =
        /(?:https?:\/\/)?(?:www\.)?t\.me\/([a-zA-Z0-9_]+)/i;
      const linkMatch = username.match(telegramLinkRegex);
      if (linkMatch) {
        username = linkMatch[1];
      }

      if (!username || username.length < 1 || username.length > 64) {
        const errorText = this.i18n.t('product.username.invalid', lang);
        const edited = await this.editLastBotMessageWithError(ctx, errorText);
        if (!edited) {
          const productType = ctx.session.productType || 'stars';
          const imageMap: Record<string, string> = {
            stars: './images/where_delivery_stars.webp',
            premium: './images/where_delivery_premium.webp',
          };
          const imagePath = imageMap[productType] || './images/main_menu.webp';
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: errorText,
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
        }
        ctx.session.awaitingUsername = true;
        return;
      }

      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        const errorText = this.i18n.t('product.username.format', lang);
        const edited = await this.editLastBotMessageWithError(ctx, errorText);
        if (!edited) {
          const productType = ctx.session.productType || 'stars';
          const imageMap: Record<string, string> = {
            stars: './images/where_delivery_stars.webp',
            premium: './images/where_delivery_premium.webp',
          };
          const imagePath = imageMap[productType] || './images/main_menu.webp';
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: errorText,
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
        }
        ctx.session.awaitingUsername = true;
        return;
      }

      const productType = ctx.session.productType || 'stars';
      try {
        const fragmentAccount =
          await this.fragmentAccountService.getNextAccount();
        if (!fragmentAccount) {
          this.logger.error('No active Fragment accounts for username check');
          const errorText = this.i18n.t('product.username.check_error', lang);
          const edited = await this.editLastBotMessageWithError(ctx, errorText);
          if (!edited) {
            const imageMap2: Record<string, string> = {
              stars: './images/where_delivery_stars.webp',
              premium: './images/where_delivery_premium.webp',
            };
            const errImage =
              imageMap2[productType] || './images/main_menu.webp';
            await this.editOrSendPhoto(ctx, errImage, {
              caption: errorText,
              parse_mode: 'HTML',
              reply_markup:
                MainKeyboard.getBackButton('back_to_recipient').reply_markup,
            });
          }
          ctx.session.awaitingUsername = true;
          return;
        }
        const { recipient, info } = await this.fragmentService.getUser(
          fragmentAccount,
          username,
          productType as 'stars' | 'premium',
        );

        if (!recipient || !recipient.recipient) {
          this.logger.warn(
            `Username ${username} not found for user ${ctx.from?.id} (${ctx.from?.username}). Product type: ${productType}`,
          );

          const errorText = this.i18n.t('product.username.not_found', lang);
          const edited = await this.editLastBotMessageWithError(ctx, errorText);
          if (!edited) {
            const imageMap: Record<string, string> = {
              stars: './images/where_delivery_stars.webp',
              premium: './images/where_delivery_premium.webp',
            };
            const imagePath =
              imageMap[productType] || './images/main_menu.webp';
            await this.editOrSendPhoto(ctx, imagePath, {
              caption: errorText,
              parse_mode: 'HTML',
              reply_markup:
                MainKeyboard.getBackButton('back_to_recipient').reply_markup,
            });
          }
          ctx.session.awaitingUsername = true;
          return;
        }

        if (info?.name) {
          ctx.session.recipientName = info.name;
        }

        const isRecipientBanned =
          await this.userService.isUserBannedByUsername(username);
        if (isRecipientBanned) {
          const errorText = this.i18n.t(
            'product.username.recipient_banned',
            lang,
          );
          const edited = await this.editLastBotMessageWithError(ctx, errorText);
          if (!edited) {
            const imageMap: Record<string, string> = {
              stars: './images/where_delivery_stars.webp',
              premium: './images/where_delivery_premium.webp',
            };
            const imagePath =
              imageMap[productType] || './images/main_menu.webp';
            await this.editOrSendPhoto(ctx, imagePath, {
              caption: errorText,
              parse_mode: 'HTML',
              reply_markup:
                MainKeyboard.getBackButton('back_to_recipient').reply_markup,
            });
          }
          ctx.session.awaitingUsername = true;
          return;
        }
      } catch (validationError: any) {
        this.logger.warn(
          `Fragment validation error for username ${username}: ${validationError.message}`,
        );

        const productType = ctx.session.productType || 'stars';
        const imageMap: Record<string, string> = {
          stars: './images/where_delivery_stars.webp',
          ton: './images/where_delivery_ton.webp',
          premium: './images/where_delivery_premium.webp',
        };
        const imagePath = imageMap[productType] || './images/main_menu.webp';

        const getErrorCaption = (): string => {
          if (validationError instanceof FragmentApiError) {
            switch (validationError.errorType) {
              case 'ALREADY_PREMIUM':
                return this.i18n.t('product.username.already_premium', lang, {
                  username: `@${username}`,
                });
              case 'GIFTS_CLOSED':
              case 'USER_NOT_FOUND':
                return this.i18n.t('product.username.not_found', lang);
              default:
                return this.i18n.t('product.username.check_error', lang);
            }
          }
          return this.i18n.t('product.username.check_error', lang);
        };

        const errorText = getErrorCaption();
        const edited = await this.editLastBotMessageWithError(ctx, errorText);
        if (!edited) {
          await this.editOrSendPhoto(ctx, imagePath, {
            caption: errorText,
            parse_mode: 'HTML',
            reply_markup:
              MainKeyboard.getBackButton('back_to_recipient').reply_markup,
          });
        }

        ctx.session.awaitingUsername = true;
        return;
      }

      ctx.deleteMessage().catch(() => {});

      ctx.session.recipientUsername = username;

      await this.askQuantityByMessageId(ctx);
      return;
    }

    if (ctx.session.awaitingQuantity) {
      ctx.session.awaitingQuantity = false;

      const productType = ctx.session.productType;
      const raw = text.trim();

      const quantity = parseInt(raw, 10);

      if (isNaN(quantity) || quantity <= 0) {
        ctx.deleteMessage().catch(() => {});
        const errorText = this.i18n.t('product.quantity.invalid', lang);
        const edited = await this.editQuantityMessageWithError(ctx, errorText);
        if (!edited) await ctx.reply(errorText);
        ctx.session.awaitingQuantity = true;
        return;
      }

      if (productType === 'stars') {
        const { minStars: minAmount, maxStars: maxAmount } =
          await this.settingsService.getPurchaseLimits();
        const q = Math.floor(quantity);

        if (q < minAmount || q > maxAmount) {
          ctx.deleteMessage().catch(() => {});
          const errorText = this.i18n.t('product.quantity.range', lang, {
            min: minAmount.toString(),
            max: maxAmount.toString(),
            emoji: '⭐️',
          });
          const edited = await this.editQuantityMessageWithError(
            ctx,
            errorText,
          );
          if (!edited) await ctx.reply(errorText);
          ctx.session.awaitingQuantity = true;
          return;
        }
        ctx.session.quantity = q;
      } else if (productType === 'ton') {
        ctx.session.awaitingQuantity = false;
        ctx.session.productType = undefined;
        ctx.session.quantity = undefined;
        ctx.deleteMessage().catch(() => {});
        await this.showMainMenu(ctx, false);
        return;
      } else if (productType === 'premium') {
        const q = Math.floor(quantity);
        if (![3, 6, 12].includes(q)) {
          ctx.deleteMessage().catch(() => {});
          const errorText = this.i18n.t(
            'product.quantity.premium.invalid',
            lang,
          );
          const edited = await this.editQuantityMessageWithError(
            ctx,
            errorText,
          );
          if (!edited) await ctx.reply(errorText);
          ctx.session.awaitingQuantity = true;
          return;
        }
        ctx.session.quantity = q;
      }

      ctx.deleteMessage().catch(() => {});

      await this.showPaymentMethodsByMessageId(ctx);
      return;
    }
  }

  @On('pre_checkout_query')
  async onPreCheckoutQuery(@Ctx() ctx: BotContext): Promise<void> {
    const query =
      (ctx as any).preCheckoutQuery ?? (ctx.update as any)?.pre_checkout_query;
    if (!query) return;

    const payload = query.invoice_payload;
    if (
      typeof payload === 'string' &&
      payload.startsWith(BOT_STARS_TOPUP_PAYLOAD_PREFIX)
    ) {
      await ctx.answerPreCheckoutQuery(true).catch(() => {});
      return;
    }

    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err: any) {
      this.logger.error(`answerPreCheckoutQuery failed: ${err.message}`);
    }
  }

  @On('successful_payment')
  async onSuccessfulPayment(@Ctx() ctx: BotContext): Promise<void> {
    const payment = (ctx.message as any)?.successful_payment;
    if (!payment) return;

    const payload = payment.invoice_payload;
    if (
      typeof payload === 'string' &&
      payload.startsWith(BOT_STARS_TOPUP_PAYLOAD_PREFIX)
    ) {
      const n = payment.total_amount as number;
      await ctx
        .reply(
          `✅ Оплачено <b>${n}</b> ⭐ — звёзды зачислены на баланс бота.`,
          {
            parse_mode: 'HTML',
          },
        )
        .catch(() => {});
      return;
    }

    this.logger.log(
      `Successful star payment: ${payment.total_amount} ${payment.currency}, payload: ${payment.invoice_payload}`,
    );
  }
}
