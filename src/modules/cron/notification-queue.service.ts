import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { EventLoopMonitorService } from '@/modules/health/event-loop-monitor.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Markup } from 'telegraf';
import { MainKeyboard } from '@/shared/keyboards/main.keyboard';
import { backInlineButton } from '@/shared/keyboards/back-inline-button';
import * as QRCode from 'qrcode';

@Injectable()
export class NotificationQueueService {
  private readonly logger = new Logger(NotificationQueueService.name);

  private readonly LOCK_ID = 'notification-queue-processor';
  private readonly RECOVERY_LOCK_ID = 'notification-queue-recovery';
  private readonly LOCK_TTL_SECONDS = 60;
  private readonly BATCH_SIZE = 50;
  private readonly CONCURRENT_LIMIT = 10;
  private readonly BATCH_DELAY_MS = 500;
  private readonly MAX_NOTIFICATION_AGE_MS = 2 * 60 * 60 * 1000;
  private readonly MAX_RETRIES = 10;

  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly eventLoopMonitor: EventLoopMonitorService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  private async acquireLock(lockId?: string): Promise<boolean> {
    const id = lockId || this.LOCK_ID;
    if (this.redisLock.isAvailable()) {
      return await this.redisLock.acquireLock(id, this.LOCK_TTL_SECONDS);
    }
    return await this.acquireDbLock(id);
  }

  private async releaseLock(lockId?: string): Promise<void> {
    const id = lockId || this.LOCK_ID;
    if (this.redisLock.isAvailable()) {
      await this.redisLock.releaseLock(id);
    } else {
      await this.releaseDbLock(id);
    }
  }

  private async acquireDbLock(lockId: string): Promise<boolean> {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.LOCK_TTL_SECONDS * 1000);
      const instanceId = this.redisLock.getInstanceId();

      const result = await this.prisma.$transaction(async (tx) => {
        const existingLock = await tx.distributedLock.findUnique({
          where: { id: lockId },
        });

        if (existingLock) {
          if (
            existingLock.expires_at > now &&
            existingLock.locked_by !== instanceId
          ) {
            return false;
          }

          await tx.distributedLock.update({
            where: { id: lockId },
            data: {
              locked_by: instanceId,
              locked_at: now,
              expires_at: expiresAt,
            },
          });
          return true;
        }

        await tx.distributedLock.create({
          data: {
            id: lockId,
            locked_by: instanceId,
            locked_at: now,
            expires_at: expiresAt,
          },
        });
        return true;
      });

      return result;
    } catch (error: any) {
      if (error.code === 'P2002') {
        return false;
      }
      this.logger.error(`Error acquiring DB lock: ${error.message}`);
      return false;
    }
  }

  private async releaseDbLock(lockId: string): Promise<void> {
    try {
      const instanceId = this.redisLock.getInstanceId();
      await this.prisma.distributedLock.deleteMany({
        where: {
          id: lockId,
          locked_by: instanceId,
        },
      });
    } catch (error: any) {
      this.logger.error(`Error releasing DB lock: ${error.message}`);
    }
  }

  @Cron('*/5 * * * * *')
  async processNotificationQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }

    if (!(await this.acquireLock())) {
      return;
    }

    this.isProcessing = true;

    try {
      const pendingNotifications = await this.prisma.$transaction(
        async (tx) => {
          const cutoff = new Date(Date.now() - this.MAX_NOTIFICATION_AGE_MS);

          const tooOld = await tx.notificationQueue.updateMany({
            where: { status: 'PENDING', created_at: { lt: cutoff } },
            data: { status: 'FAILED', last_error: 'Skipped: too old' },
          });

          if (tooOld.count > 0) {
            this.logger.warn(
              `Skipped ${tooOld.count} notifications older than 2h`,
            );
          }

          const notifications = await tx.notificationQueue.findMany({
            where: { status: 'PENDING' },
            orderBy: { created_at: 'asc' },
            take: this.BATCH_SIZE,
          });

          if (notifications.length === 0) {
            return [];
          }

          await tx.notificationQueue.updateMany({
            where: {
              id: { in: notifications.map((n) => n.id) },
              status: 'PENDING',
            },
            data: { status: 'PROCESSING' },
          });

          return notifications;
        },
      );

      if (pendingNotifications.length === 0) {
        return;
      }

      this.logger.debug(
        `Processing ${pendingNotifications.length} notifications [${this.redisLock.getInstanceId().slice(-8)}]`,
      );

      await this.processWithConcurrency(
        pendingNotifications,
        (notification) => this.processDbNotification(notification),
        this.CONCURRENT_LIMIT,
        this.BATCH_DELAY_MS,
      );
    } catch (error: any) {
      this.logger.error(`Notification queue processor error: ${error.message}`);
    } finally {
      this.isProcessing = false;
      await this.releaseLock();
    }
  }

  private async processWithConcurrency<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    concurrency: number,
    delayMs = 200,
  ): Promise<void> {
    for (let i = 0; i < items.length; i += concurrency) {
      const chunk = items.slice(i, i + concurrency);
      await Promise.allSettled(chunk.map(processor));
      if (i + concurrency < items.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  private async processDbNotification(notification: any): Promise<void> {
    try {
      const data = notification.message_data as any;

      switch (notification.message_type) {
        case 'completed':
          await this.sendCompletedNotification(notification, data);
          break;
        case 'success':
          await this.sendSuccessNotification(notification, data);
          break;
        case 'cancelled':
          await this.sendCancelledNotification(notification, data);
          break;
        case 'failed':
          await this.sendFailedNotification(notification, data);
          break;
        case 'refunded':
          await this.sendRefundedNotification(notification, data);
          break;
        case 'underpayment':
          await this.sendUnderpaymentNotification(notification, data);
          break;
        case 'partial_underpayment':
          await this.sendPartialUnderpaymentNotification(notification, data);
          break;
        case 'referral_reward':
          this.logger.debug(
            `Skipping deprecated referral_reward notification ${notification.id}`,
          );
          break;
        default:
          this.logger.warn(
            `Unknown notification type: ${notification.message_type}`,
          );
      }

      await this.prisma.notificationQueue.update({
        where: { id: notification.id },
        data: { status: 'SENT', updated_at: new Date() },
      });
    } catch (error: any) {
      const errorMessage = error.message || '';

      const isBlocked =
        errorMessage.includes('bot was blocked by the user') ||
        errorMessage.includes('user is deactivated') ||
        errorMessage.includes('PEER_ID_INVALID') ||
        (error.code === 403 && errorMessage.includes('Forbidden'));

      if (isBlocked) {
        this.logger.debug(
          `User ${notification.user_telegram_id} blocked the bot, skipping notification`,
        );
        await this.prisma.notificationQueue.update({
          where: { id: notification.id },
          data: {
            status: 'FAILED',
            retry_count: (notification.retry_count || 0) + 1,
            last_error: 'User blocked the bot',
            updated_at: new Date(),
          },
        });
        return;
      }

      const isRateLimit =
        error.response?.error_code === 429 ||
        errorMessage.includes('Too Many Requests');

      if (isRateLimit) {
        await this.prisma.notificationQueue.update({
          where: { id: notification.id },
          data: {
            status: 'PENDING',
            last_error: errorMessage,
            updated_at: new Date(),
          },
        });
        return;
      }

      const newRetryCount = (notification.retry_count || 0) + 1;

      if (newRetryCount >= this.MAX_RETRIES) {
        await this.prisma.notificationQueue.update({
          where: { id: notification.id },
          data: {
            status: 'FAILED',
            retry_count: newRetryCount,
            last_error: errorMessage,
            updated_at: new Date(),
          },
        });
        this.logger.error(
          `Notification ${notification.id} failed after ${newRetryCount} retries: ${errorMessage}`,
        );
      } else {
        await this.prisma.notificationQueue.update({
          where: { id: notification.id },
          data: {
            status: 'PENDING',
            retry_count: newRetryCount,
            last_error: errorMessage,
            updated_at: new Date(),
          },
        });
      }
    }
  }

  private async sendCompletedNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    let productText: string;
    if (data.type === 'stars') {
      productText = `${data.amount_value} звёзд ⭐`;
    } else if (data.type === 'premium') {
      productText = `Telegram Premium 👑`;
    } else if (data.type === 'ton') {
      productText = `${data.amount_value} TON 💎`;
    } else {
      productText = `${data.amount_value} ${data.type}`;
    }

    let notificationText = `✅ <b>Ваш заказ выполнен!</b>\n\n📦 <b>Товар:</b> ${productText}`;

    if (data.order_number) {
      notificationText += `\n\n🆔 <b>Номер заказа:</b> <code>#${data.order_number}</code>`;
    }

    if (data.tonscanUrl) {
      notificationText += `\n\n🔗 <a href="${data.tonscanUrl}">Посмотреть транзакцию</a>`;
    }
    notificationText += `\n\nСпасибо за покупку! Если у вас есть вопросы, пожалуйста, свяжитесь с нашей поддержкой.`;

    let successImage: string;
    if (data.type === 'ton') {
      successImage = './images/ton_success.webp';
    } else if (data.type === 'stars') {
      successImage = './images/stars_success.webp';
    } else if (data.type === 'premium') {
      successImage = './images/premium_success.webp';
    } else {
      successImage = './images/main_menu.webp';
    }

    if (data.payment_message_id) {
      try {
        await this.bot.telegram.editMessageMedia(
          notification.user_telegram_id,
          parseInt(data.payment_message_id),
          undefined,
          {
            type: 'photo',
            media: { source: successImage },
            caption: notificationText,
            parse_mode: 'HTML',
          },
          {
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );
        return;
      } catch (editError: any) {
        this.logger.warn(
          `editMessageMedia failed for completed notification: ${editError.message}`,
        );
      }

      try {
        await this.bot.telegram.editMessageCaption(
          notification.user_telegram_id,
          parseInt(data.payment_message_id),
          undefined,
          notificationText,
          {
            parse_mode: 'HTML',
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );
        return;
      } catch {}
    }

    await this.sendPhotoWithFallback(
      notification.user_telegram_id,
      successImage,
      notificationText,
    );
  }

  private async sendSuccessNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    const message =
      data.message ||
      (() => {
        const productName = data.productName || 'Товар';
        const pendingText = 'будет отправлен в ближайшее время';
        return `✅ <b>Оплата успешна!</b>\n\n${productName} ${pendingText}.\n\nВаш заказ: <code>#${data.order_number}</code>`;
      })();

    let successImage = './images/main_menu.webp';
    if (data.product_type === 'TON') {
      successImage = './images/ton_success.webp';
    } else if (data.product_type === 'STARS') {
      successImage = './images/stars_success.webp';
    } else if (data.product_type === 'PREMIUM') {
      successImage = './images/premium_success.webp';
    }

    const deletePaymentDetailsMessage = async (): Promise<void> => {
      if (!data.details_message_id) return;
      try {
        await this.bot.telegram.deleteMessage(
          notification.user_telegram_id,
          parseInt(String(data.details_message_id), 10),
        );
      } catch {}
    };

    if (data.payment_message_id) {
      try {
        await this.bot.telegram.editMessageMedia(
          notification.user_telegram_id,
          parseInt(data.payment_message_id, 10),
          undefined,
          {
            type: 'photo',
            media: { source: successImage },
            caption: message,
            parse_mode: 'HTML',
          },
          {
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );
        await deletePaymentDetailsMessage();
      } catch (editError: any) {
        this.logger.warn(
          `editMessageMedia failed for success notification: ${editError.message}`,
        );
        try {
          await this.bot.telegram.editMessageCaption(
            notification.user_telegram_id,
            parseInt(data.payment_message_id, 10),
            undefined,
            message,
            {
              parse_mode: 'HTML',
              reply_markup: MainKeyboard.getBackButton().reply_markup,
            },
          );
          await deletePaymentDetailsMessage();
        } catch (captionError: any) {
          this.logger.warn(
            `editMessageCaption failed for success notification: ${captionError.message}`,
          );
          await this.sendPhotoWithFallback(
            notification.user_telegram_id,
            successImage,
            message,
          );
          await deletePaymentDetailsMessage();
        }
      }
    } else {
      await this.sendPhotoWithFallback(
        notification.user_telegram_id,
        successImage,
        message,
      );
      await deletePaymentDetailsMessage();
    }

    // Do not send extra follow-up message after successful delivery.
  }

  private async sendCancelledNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    const message =
      data.message ||
      `❌ <b>Оплата отменена</b>\n\nЗаказ <code>#${data.order_number}</code> был отменен.\n\nВы можете создать новый заказ.`;

    if (data.payment_message_id) {
      try {
        await this.bot.telegram.editMessageMedia(
          notification.user_telegram_id,
          parseInt(data.payment_message_id),
          undefined,
          {
            type: 'photo',
            media: { source: './images/main_menu.webp' },
            caption: message,
            parse_mode: 'HTML',
          },
          {
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );

        if (data.details_message_id) {
          try {
            await this.bot.telegram.deleteMessage(
              notification.user_telegram_id,
              parseInt(data.details_message_id),
            );
          } catch {}
        }
        return;
      } catch {}
    }

    await this.sendPhotoWithFallback(
      notification.user_telegram_id,
      './images/main_menu.webp',
      message,
    );
  }

  private async sendFailedNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    try {
      const isDeliveryError = !!notification.queue_item_id;

      if (notification.payment_id && !isDeliveryError) {
        const payment = await this.prisma.payment.findUnique({
          where: { id: notification.payment_id },
          select: { status: true, order_number: true },
        });

        if (payment?.status === 'COMPLETED') {
          this.logger.warn(
            `Skipping failed payment notification for ${notification.payment_id} - already COMPLETED`,
          );
          return;
        }
      }

      const orderIdentifier = data.order_number
        ? `#${data.order_number}`
        : data.queue_item_id || notification.queue_item_id;

      this.logger.log(
        `Skipping failed notification to user ${notification.user_telegram_id} for order ${orderIdentifier}`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to send failed notification: ${error.message}`);
      throw error;
    }
  }

  private async sendRefundedNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    const message =
      data.message ||
      `💸 <b>Возврат средств</b>\n\nСредства по заказу <code>#${data.order_number}</code> были возвращены.\n\nЕсли у вас есть вопросы, обратитесь в поддержку.`;

    if (data.payment_message_id) {
      try {
        await this.bot.telegram.editMessageMedia(
          notification.user_telegram_id,
          parseInt(data.payment_message_id),
          undefined,
          {
            type: 'photo',
            media: { source: './images/main_menu.webp' },
            caption: message,
            parse_mode: 'HTML',
          },
          {
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );
        return;
      } catch {}
    }

    await this.sendPhotoWithFallback(
      notification.user_telegram_id,
      './images/main_menu.webp',
      message,
    );
  }

  private async sendUnderpaymentNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    const supportUrl = process.env.SUPPORT_URL || 'https://t.me/patriq_star';

    const message =
      `⚠️ <b>Получена неполная оплата по заказу <code>#${data.order_number}</code></b>\n\n` +
      `💎 Ожидалось: <b>${data.expected_ton} TON</b>\n` +
      `💸 Получено: <b>${data.actual_ton} TON</b>\n` +
      `❗️ Недоплата: <b>${data.shortfall_ton} TON</b>\n\n` +
      `Ваш заказ принят и будет выполнен.\n\n` +
      `Если вы считаете, что это ошибка — обратитесь в поддержку: ${supportUrl}`;

    if (data.payment_message_id) {
      try {
        await this.bot.telegram.editMessageCaption(
          notification.user_telegram_id,
          parseInt(data.payment_message_id),
          undefined,
          message,
          {
            parse_mode: 'HTML',
            reply_markup: MainKeyboard.getBackButton().reply_markup,
          },
        );
        return;
      } catch {}
    }

    await this.bot.telegram.sendMessage(
      notification.user_telegram_id,
      message,
      {
        parse_mode: 'HTML',
        reply_markup: MainKeyboard.getBackButton().reply_markup,
      },
    );
  }

  private async sendPartialUnderpaymentNotification(
    notification: any,
    data: any,
  ): Promise<void> {
    const walletAddress = process.env.WALLET_ADDRESS || '';
    const paymentId: string = data.payment_id || '';
    const shortfallTon: string = data.shortfall_ton || '0';

    const tonLink = `ton://transfer/${walletAddress}?amount=${Math.round(parseFloat(shortfallTon) * 1e9)}&text=${paymentId}`;

    const message =
      `⚠️ <b>Недостаточная оплата по заказу <code>#${data.order_number}</code></b>\n\n` +
      `💎 Ожидалось: <code>${data.expected_ton} TON</code>\n` +
      `💸 Получено: <code>${data.actual_ton} TON</code>\n` +
      `❗️ Необходимо доплатить: <code>${shortfallTon} TON</code>\n\n` +
      `Пожалуйста, отправьте недостающую сумму на тот же адрес с тем же комментарием:\n\n` +
      `💼 Адрес: <code>${walletAddress}</code>\n` +
      `💬 Комментарий: <code>${paymentId}</code>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(`💳 Доплатить ${shortfallTon} TON`, tonLink)],
      [backInlineButton('back_to_main')],
    ]);

    let qrBuffer: Buffer | undefined;
    try {
      qrBuffer = await QRCode.toBuffer(tonLink, {
        type: 'png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
    } catch {}

    const chatId = notification.user_telegram_id;

    if (data.payment_message_id && qrBuffer) {
      const msgId = parseInt(data.payment_message_id);

      try {
        await this.bot.telegram.editMessageMedia(
          chatId,
          msgId,
          undefined,
          {
            type: 'photo',
            media: { source: qrBuffer },
            caption: message,
            parse_mode: 'HTML',
          },
          { reply_markup: keyboard.reply_markup },
        );
        return;
      } catch (e: any) {
        this.logger.warn(
          `partial_underpayment editMessageMedia failed: ${e.message}`,
        );
      }

      try {
        await this.bot.telegram.editMessageCaption(
          chatId,
          msgId,
          undefined,
          message,
          { parse_mode: 'HTML', reply_markup: keyboard.reply_markup },
        );
        return;
      } catch (e: any) {
        this.logger.warn(
          `partial_underpayment editMessageCaption failed: ${e.message}`,
        );
      }
    }

    try {
      let newMsgId: number | undefined;

      if (qrBuffer) {
        const sent = await this.bot.telegram.sendPhoto(
          chatId,
          { source: qrBuffer },
          {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: keyboard.reply_markup,
          },
        );
        newMsgId = sent.message_id;
      } else {
        const sent = await this.bot.telegram.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: keyboard.reply_markup,
        });
        newMsgId = sent.message_id;
      }

      if (newMsgId && notification.payment_id) {
        await this.prisma.payment.update({
          where: { id: notification.payment_id },
          data: { payment_message_id: newMsgId.toString() },
        });
      }
    } catch (e: any) {
      this.logger.error(`partial_underpayment send failed: ${e.message}`);
    }
  }

  private async sendPhotoWithFallback(
    chatId: string,
    image: string,
    caption: string,
    retryCount = 0,
  ): Promise<void> {
    try {
      await this.bot.telegram.sendPhoto(
        chatId,
        { source: image },
        {
          caption,
          parse_mode: 'HTML',
          reply_markup: MainKeyboard.getBackButton().reply_markup,
        },
      );
    } catch (err: any) {
      if (err.response?.error_code === 429 && retryCount < 3) {
        const retryAfter = err.response.parameters?.retry_after ?? 1;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return this.sendPhotoWithFallback(
          chatId,
          image,
          caption,
          retryCount + 1,
        );
      }
      await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        reply_markup: MainKeyboard.getBackButton().reply_markup,
      });
    }
  }

  @Cron('0 */1 * * * *')
  async recoverStuckNotifications(): Promise<void> {
    if (!(await this.acquireLock(this.RECOVERY_LOCK_ID))) {
      return;
    }

    try {
      const stuckThreshold = new Date(Date.now() - 2 * 60 * 1000);

      const recovered = await this.prisma.notificationQueue.updateMany({
        where: {
          status: 'PROCESSING',
          updated_at: { lt: stuckThreshold },
        },
        data: {
          status: 'PENDING',
          updated_at: new Date(),
        },
      });

      if (recovered.count > 0) {
        this.logger.log(
          `Recovered ${recovered.count} stuck PROCESSING notifications`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error recovering stuck notifications: ${error.message}`,
      );
    } finally {
      await this.releaseLock(this.RECOVERY_LOCK_ID);
    }
  }

  @Cron('0 0 * * * *')
  async cleanupOldNotifications(): Promise<void> {
    if (!(await this.acquireLock('notification-queue-cleanup'))) {
      return;
    }

    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const deleted = await this.prisma.notificationQueue.deleteMany({
        where: {
          status: 'SENT',
          updated_at: { lt: oneDayAgo },
        },
      });

      if (deleted.count > 0) {
        this.logger.log(`Cleaned up ${deleted.count} old notifications`);
      }
    } catch (error: any) {
      this.logger.error(`Error cleaning up notifications: ${error.message}`);
    } finally {
      await this.releaseLock('notification-queue-cleanup');
    }
  }
}
