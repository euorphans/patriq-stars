import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import {
  PaymentsService,
  TON_PAYMENT_WINDOW_MS,
} from '@/modules/payments/payments.service';
import { FraudService } from '@/modules/fraud/fraud.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { EventLoopMonitorService } from '@/modules/health/event-loop-monitor.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { getProductName } from '@/shared/utils';
import { MainKeyboard } from '@/shared/keyboards/main.keyboard';
import {
  buildPurchaseFollowUpCaption,
  PURCHASE_FOLLOWUP_IMAGE,
  sendOrEditPaymentSuccessPhoto,
} from '@/shared/utils/payment-success-notification';
import { PaymentStatus } from '@prisma/client';
import { I18nService } from '@/shared/services/i18n/i18n.service';
import { UserService } from '@/modules/user/user.service';

@Injectable()
export class PaymentCheckerService {
  private readonly logger = new Logger(PaymentCheckerService.name);

  private isChecking = false;
  private isCancelling = false;

  private readonly CHECKING_LOCK_ID = 'payment-checker-processor';
  private readonly CANCELLING_LOCK_ID = 'payment-checker-canceller';
  private readonly LOCK_TTL_SECONDS = 60;

  private readonly MAX_CONCURRENT_CHECKS = 10;
  private readonly BATCH_DELAY_MS = 200;
  private readonly MAX_PAYMENTS_PER_CYCLE = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly fraudService: FraudService,
    private readonly settingsService: SettingsService,
    private readonly redisLock: RedisLockService,
    private readonly eventLoopMonitor: EventLoopMonitorService,
    private readonly i18n: I18nService,
    private readonly userService: UserService,
    @InjectBot() private readonly bot: Telegraf,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  private async acquireLock(
    lockId: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    const ttl = ttlSeconds ?? this.LOCK_TTL_SECONDS;
    if (this.redisLock.isAvailable()) {
      return await this.redisLock.acquireLock(lockId, ttl);
    }
    return await this.acquireDbLock(lockId);
  }

  private async releaseLock(lockId: string): Promise<void> {
    if (this.redisLock.isAvailable()) {
      await this.redisLock.releaseLock(lockId);
    } else {
      await this.releaseDbLock(lockId);
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
      this.logger.error(`Error acquiring DB lock ${lockId}: ${error.message}`);
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
      this.logger.error(`Error releasing DB lock ${lockId}: ${error.message}`);
    }
  }

  @Cron('*/3 * * * * *')
  async checkPayments(): Promise<void> {
    if (this.isChecking) {
      return;
    }
    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }
    await this.processPayments();
  }

  @Cron('15,45 * * * * *')
  async cancelExpiredPayments(): Promise<void> {
    if (this.isCancelling) {
      return;
    }

    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }

    if (!(await this.acquireLock(this.CANCELLING_LOCK_ID))) {
      return;
    }

    this.isCancelling = true;

    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      const tonExpiryAgo = new Date(Date.now() - TON_PAYMENT_WINDOW_MS);

      const expiredPayments = await this.prisma.payment.findMany({
        where: {
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
          OR: [
            {
              payment_method: 'TON',
              created_at: { lt: tonExpiryAgo },
            },
            {
              payment_method: { not: 'TON' },
              created_at: { lt: thirtyMinutesAgo },
            },
          ],
        },
        orderBy: { created_at: 'asc' },
        take: 500,
      });

      if (expiredPayments.length === 0) {
        return;
      }

      this.logger.log(
        `Found ${expiredPayments.length} expired payments to cancel`,
      );

      let cancelled = 0;

      const chunks = this.chunkArray(expiredPayments, 20);

      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map((payment) => this.cancelExpiredPayment(payment)),
        );

        cancelled += results.filter(
          (r) => r.status === 'fulfilled' && r.value,
        ).length;
      }

      if (cancelled > 0) {
        this.logger.log(`Successfully cancelled ${cancelled} expired payments`);
      }
    } catch (error: any) {
      this.logger.error(`Error in cancelExpiredPayments: ${error.message}`);
    } finally {
      this.isCancelling = false;
      await this.releaseLock(this.CANCELLING_LOCK_ID);
    }
  }

  private async cancelExpiredPayment(payment: any): Promise<boolean> {
    try {
      const currentPayment = await this.prisma.payment.findUnique({
        where: { id: payment.id },
      });

      if (!currentPayment) {
        return false;
      }

      if (
        currentPayment.status === PaymentStatus.CANCELLED ||
        currentPayment.status === PaymentStatus.COMPLETED ||
        currentPayment.status === PaymentStatus.FRAUD
      ) {
        return false;
      }

      try {
        const finalStatus =
          await this.paymentsService.checkPaymentStatus(currentPayment);
        if (finalStatus === PaymentStatus.COMPLETED) {
          this.logger.log(
            `${currentPayment.payment_method} payment #${currentPayment.order_number} was paid just before expiry - processing`,
          );

          const completedPayment = await this.prisma.payment.findUnique({
            where: { id: currentPayment.id },
          });

          if (
            completedPayment &&
            completedPayment.status === PaymentStatus.COMPLETED
          ) {
            const result =
              await this.paymentsService.handleCompletedPayment(
                completedPayment,
              );

            const freshPayment = await this.prisma.payment.findUnique({
              where: { id: completedPayment.id },
            });

            if (freshPayment?.status === PaymentStatus.FRAUD) {
              await this.queuePaymentFraudNotification(freshPayment);
            } else {
              await this.queuePaymentSuccessNotification(completedPayment);
            }

            if (result.created) {
              await this.notifySalesChannels(completedPayment);
            }
          }
          return false;
        }
      } catch (checkError: any) {
        this.logger.warn(
          `Failed to do final check for ${currentPayment.payment_method} payment #${currentPayment.order_number}: ${checkError.message}. Proceeding with cancellation.`,
        );
      }

      const cancelledPayment = await this.prisma.$transaction(async (tx) => {
        const p = await tx.payment.findUnique({
          where: { id: payment.id },
        });

        if (
          !p ||
          p.status === PaymentStatus.COMPLETED ||
          p.status === PaymentStatus.CANCELLED ||
          p.status === PaymentStatus.FRAUD
        ) {
          return null;
        }

        return tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.CANCELLED, updated_at: new Date() },
        });
      });

      if (!cancelledPayment) {
        return false;
      }

      await this.queueExpiredPaymentNotification(cancelledPayment);

      this.fraudService
        .checkConsecutiveCancellations(cancelledPayment.user_telegram_id)
        .catch((err) =>
          this.logger.error(
            `Consecutive cancellation check failed: ${err.message}`,
          ),
        );

      this.logger.log(
        `Cancelled expired payment #${cancelledPayment.order_number} (${cancelledPayment.payment_method})`,
      );

      return true;
    } catch (error: any) {
      this.logger.error(
        `Error cancelling expired payment #${payment.order_number || payment.id}: ${error.message}`,
      );
      return false;
    }
  }

  private async processPayments(): Promise<void> {
    if (!(await this.acquireLock(this.CHECKING_LOCK_ID))) {
      return;
    }

    this.isChecking = true;

    try {
      const tonPayments = await this.prisma.payment.findMany({
        where: {
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
          payment_method: 'TON',
          created_at: {
            gte: new Date(Date.now() - TON_PAYMENT_WINDOW_MS),
          },
        },
        orderBy: { created_at: 'asc' },
        take: this.MAX_PAYMENTS_PER_CYCLE,
      });

      if (tonPayments.length === 0) {
        return;
      }

      this.logger.debug(`Processing ${tonPayments.length} TON payments`);

      let completed = 0;

      for (let i = 0; i < tonPayments.length; i += this.MAX_CONCURRENT_CHECKS) {
        const batch = tonPayments.slice(i, i + this.MAX_CONCURRENT_CHECKS);

        const results = await Promise.allSettled(
          batch.map((payment) => this.checkSinglePayment(payment)),
        );

        completed += results.filter(
          (r) => r.status === 'fulfilled' && r.value,
        ).length;

        if (i + this.MAX_CONCURRENT_CHECKS < tonPayments.length) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.BATCH_DELAY_MS),
          );
        }
      }

      if (completed > 0) {
        this.logger.log(`Completed ${completed} payments`);
      }
    } catch (error: any) {
      this.logger.error(`Payment checker error: ${error.message}`);
    } finally {
      this.isChecking = false;
      await this.releaseLock(this.CHECKING_LOCK_ID);
    }
  }

  private async checkSinglePayment(payment: any): Promise<boolean> {
    try {
      const currentPayment = await this.prisma.payment.findUnique({
        where: { id: payment.id },
      });

      if (!currentPayment) {
        return false;
      }

      if (
        currentPayment.status === PaymentStatus.COMPLETED ||
        currentPayment.status === PaymentStatus.FRAUD
      ) {
        return false;
      }

      let newStatus: string;
      try {
        newStatus =
          await this.paymentsService.checkPaymentStatus(currentPayment);
      } catch (checkError: any) {
        this.logger.warn(
          `Error checking payment #${payment.order_number}: ${checkError.message}. Will retry on next cycle.`,
        );
        return false;
      }

      if (newStatus === PaymentStatus.COMPLETED) {
        const updatedPayment = await this.prisma.payment.findUnique({
          where: { id: payment.id },
        });

        if (
          updatedPayment &&
          updatedPayment.status === PaymentStatus.COMPLETED
        ) {
          const result =
            await this.paymentsService.handleCompletedPayment(updatedPayment);

          await this.queuePaymentSuccessNotification(updatedPayment);

          if (result.created) {
            await this.notifySalesChannels(updatedPayment);
          }

          return true;
        }
      }

      return false;
    } catch (error: any) {
      this.logger.error(
        `Unexpected error processing payment #${payment.order_number}: ${error.message}`,
      );
      return false;
    }
  }

  async forceCompletePayment(paymentId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment) {
        return { success: false, message: 'Платеж не найден' };
      }

      if (payment.status === PaymentStatus.COMPLETED) {
        return { success: false, message: 'Платеж уже выполнен' };
      }

      if (payment.status === PaymentStatus.REFUNDED) {
        return {
          success: false,
          message: 'Невозможно протолкнуть возвращённый платеж',
        };
      }

      await this.paymentsService.updatePaymentStatus(
        paymentId,
        PaymentStatus.COMPLETED,
      );

      const updatedPayment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (updatedPayment) {
        const result =
          await this.paymentsService.handleCompletedPayment(updatedPayment);

        await this.queuePaymentSuccessNotification(updatedPayment);

        if (result.created) {
          await this.notifySalesChannels(updatedPayment);
        }
      }

      this.logger.log(
        `Payment ${paymentId} manually completed by admin (order #${payment.order_number})`,
      );

      return {
        success: true,
        message: `Платеж #${payment.order_number} успешно протолкнут`,
      };
    } catch (error: any) {
      this.logger.error(
        `Error force completing payment ${paymentId}: ${error.message}`,
      );
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  }

  private async queuePaymentFraudNotification(payment: any): Promise<void> {
    try {
      const supportUrl = process.env.SUPPORT_URL || 'https://t.me/patriq_star';

      await this.prisma.notificationQueue.create({
        data: {
          user_telegram_id: payment.user_telegram_id,
          message_type: 'success',
          payment_id: payment.id,
          message_data: {
            message: `❌ <b>Произошла ошибка доставки</b>\n\nПожалуйста, обратитесь в поддержку: ${supportUrl}`,
            order_number: payment.order_number,
            product_type: payment.product_type,
            payment_message_id: payment.payment_message_id,
            details_message_id: payment.details_message_id,
          },
        },
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue fraud notification for user ${payment.id}: ${error.message}`,
      );
    }
  }

  private async queuePaymentSuccessNotification(payment: any): Promise<void> {
    try {
      const productName = getProductName(payment);

      await this.prisma.notificationQueue.create({
        data: {
          user_telegram_id: payment.user_telegram_id,
          message_type: 'success',
          payment_id: payment.id,
          message_data: {
            productName,
            order_number: payment.order_number,
            product_type: payment.product_type,
            payment_message_id: payment.payment_message_id,
            details_message_id: payment.details_message_id,
          },
        },
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue success notification for ${payment.id}: ${error.message}`,
      );
      await this.sendPaymentSuccessNotificationDirect(payment);
    }
  }

  private async queueExpiredPaymentNotification(payment: any): Promise<void> {
    try {
      const userLanguage = await this.userService.getUserLanguage(
        payment.user_telegram_id,
      );

      const paymentMethodKey =
        payment.payment_method === 'TON'
          ? 'payment.method.ton'
          : payment.payment_method === 'FREEKASSA' &&
                payment.crypto_currency === 'USD'
              ? 'payment.method.freekassa_crypto'
              : payment.payment_method === 'FREEKASSA' &&
                  payment.crypto_currency === 'CARD'
                ? 'payment.method.freekassa_card'
                : payment.payment_method === 'FREEKASSA'
                  ? 'payment.method.freekassa'
                : payment.payment_method === 'HELEKET'
                  ? 'payment.method.heleket'
                  : payment.payment_method;

      const paymentMethod =
        typeof paymentMethodKey === 'string' &&
        paymentMethodKey.startsWith('payment.')
          ? this.i18n.t(paymentMethodKey, userLanguage)
          : paymentMethodKey;

      const windowText =
        payment.payment_method === 'TON'
          ? this.i18n.t('payment.expired.window_ton', userLanguage)
          : this.i18n.t('payment.expired.window_other', userLanguage);

      const message = this.i18n.t('payment.expired.title', userLanguage, {
        order: payment.order_number,
        method: paymentMethod,
        window: windowText,
      });

      const notificationData = {
        user_telegram_id: payment.user_telegram_id,
        message_type: 'cancelled',
        payment_id: payment.id,
        message_data: {
          order_number: payment.order_number,
          payment_message_id: payment.payment_message_id,
          details_message_id: payment.details_message_id,
          message: message,
        },
      };

      await this.prisma.notificationQueue.create({
        data: notificationData,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue expired notification for ${payment.id}: ${error.message}`,
      );
    }
  }

  private async sendPaymentSuccessNotificationDirect(
    payment: any,
  ): Promise<void> {
    try {
      const lang = await this.userService.getUserLanguage(
        payment.user_telegram_id,
      );
      const caption = await buildPurchaseFollowUpCaption(this.i18n, lang, {
        product_type: payment.product_type,
        product_quantity: payment.product_quantity,
      });
      const reply_markup = MainKeyboard.getPurchaseFollowUpKeyboard(
        this.i18n,
        lang,
      ).reply_markup;
      await sendOrEditPaymentSuccessPhoto(this.bot, {
        userTelegramId: payment.user_telegram_id,
        paymentMessageId: payment.payment_message_id,
        detailsMessageId: payment.details_message_id,
        caption,
        imagePath: PURCHASE_FOLLOWUP_IMAGE,
        reply_markup,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to send payment success notification: ${error.message}`,
      );
    }
  }

  private async notifySalesChannels(payment: any): Promise<void> {
    try {
      if (
        !(await this.settingsService.shouldNotifySalesChannelsForPayment(
          payment,
        ))
      ) {
        return;
      }

      const channels = await this.settingsService.getSalesChannels();

      if (!channels || channels.length === 0) {
        return;
      }

      if (this.redisLock.isAvailable()) {
        const claimed = await this.redisLock.tryClaimSalesNotification(
          payment.id,
        );
        if (!claimed) {
          this.logger.debug(
            `Sales notification for payment ${payment.id} already sent, skipping`,
          );
          return;
        }
      }

      const paymentMethods: Record<string, string> = {
        FREEKASSA: '🏦 СБП (Freekassa)',
        HELEKET: '🪙 Криптовалюта',
        TON: '💎 TON',
      };

      const productNames: Record<string, string> = {
        STARS: '⭐ STARS',
        PREMIUM: '👑 PREMIUM',
        TON: '💎 TON',
      };

      const timeStr =
        new Date(payment.created_at)
          .toLocaleString('ru-RU', {
            timeZone: 'Europe/Moscow',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
          .replace(',', '') + ' (МСК)';

      const buyerId = payment.user_telegram_id;
      const buyerInfo = buyerId ? `ID: ${buyerId}` : 'Не указан';

      const recipient = payment.recipient_username || payment.recipient_name;
      const recipientInfo = recipient ? `@${recipient}` : 'Не указан';

      const paymentMethod =
        payment.payment_method === 'FREEKASSA' &&
        payment.crypto_currency === 'USD'
          ? '🪙 Крипто (Freekassa)'
          : payment.payment_method === 'FREEKASSA' &&
              payment.crypto_currency === 'CARD'
            ? '💳 Карта 5.7 (Freekassa)'
            : paymentMethods[payment.payment_method] || payment.payment_method;
      const product =
        productNames[payment.product_type] || payment.product_type;
      const productLine =
        productNames[payment.product_type] != null
          ? `${product} x${payment.product_quantity}`
          : getProductName(payment);

      const amountRub = parseFloat(payment.amount_rub?.toString() || '0');
      const amountUsd = parseFloat(payment.amount_usd?.toString() || '0');
      const amountTon = parseFloat(payment.amount_ton?.toString() || '0');
      const netProfit = parseFloat(payment.net_profit_rub?.toString() || '0');

      let amountText = '';
      if (payment.payment_method === 'TON' && amountTon > 0) {
        amountText = `${amountTon.toFixed(9)} TON`;
      } else if (
        (payment.payment_method === 'HELEKET' ||
          (payment.payment_method === 'FREEKASSA' &&
            payment.crypto_currency === 'USD')) &&
        amountUsd > 0
      ) {
        amountText = `$${amountUsd.toFixed(2)}`;
      } else {
        amountText = `${amountRub.toFixed(2)} ₽`;
      }

      const orderNumberLink = `<code>#${payment.order_number}</code>`;

      const text = `
💰 <b>Новая продажа!</b>

🕐 <b>Время:</b> ${timeStr}
🆔 <b>Номер заказа:</b> ${orderNumberLink}

👤 <b>Покупатель:</b> ${buyerInfo}
🎁 <b>Получатель:</b> ${recipientInfo}

📦 <b>Товар:</b> ${productLine}
💳 <b>Способ оплаты:</b> ${paymentMethod}

💵 <b>Сумма оплаты:</b> ${amountText}
💸 <b>Наш доход:</b> ${netProfit.toFixed(2)} ₽
      `;

      for (const channel of channels) {
        if (!channel.is_active) {
          continue;
        }

        try {
          await this.adminBot.telegram.sendMessage(channel.channel_id, text, {
            parse_mode: 'HTML',
          });
        } catch (error: any) {
          const errorMessage = error.message || '';

          if (
            errorMessage.includes('chat not found') ||
            errorMessage.includes('chat_id is empty') ||
            errorMessage.includes('Bad Request: chat not found')
          ) {
            this.logger.warn(
              `Sales channel ${channel.channel_id} unavailable. Check bot is added to channel.`,
            );
          } else {
            this.logger.error(
              `Failed to send to channel ${channel.channel_id}: ${error.message}`,
            );
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error sending sales notifications: ${error.message}`);
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
