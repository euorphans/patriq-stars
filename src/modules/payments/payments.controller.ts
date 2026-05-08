import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { SkipThrottle } from '@nestjs/throttler';
import { PaymentsService } from './payments.service';
import { PlategaService } from './providers/platega.service';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { getProductName, withTransactionRetry } from '@/shared/utils';
import { WebhookGuard } from '@/shared/guards/webhook.guard';
import { IpWhitelistGuard } from '@/shared/guards/ip-whitelist.guard';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { FraudService } from '@/modules/fraud/fraud.service';
import { MainKeyboard } from '@/shared/keyboards/main.keyboard';
import { UserService } from '@/modules/user/user.service';
import { I18nService } from '@/shared/services/i18n/i18n.service';
import {
  buildMopsPurchaseRewardCaption,
  MOPS_PURCHASE_SUCCESS_IMAGE,
  sendOrEditPaymentSuccessPhoto,
} from '@/shared/utils/payment-success-notification';

interface PlategaCallbackPayload {
  id: string;
  status: number | string;
  amount?: number;
  currency?: string;
  paymentMethod?: number | string;
  payload?: string;
  merchantId?: string;
}

interface HeleketCallbackPayload {
  type?: string;
  uuid?: string;
  order_id?: string;
  amount?: string;
  payment_amount?: string;
  payment_amount_usd?: string;
  merchant_amount?: string;
  commission?: string;
  is_final?: boolean;
  status?: string;
  payment_status?: string;
  from?: string;
  wallet_address_uuid?: string;
  network?: string;
  currency?: string;
  payer_currency?: string;
  additional_data?: string;
  convert?: {
    to_currency?: string;
    commission?: string;
    rate?: string;
    amount?: string;
  };
  txid?: string;
  sign?: string;
  [key: string]: any;
}

/** Колбэк Platega: числовые и строковые коды (док. статусы — PENDING, CONFIRMED, EXPIRED, CANCELED, FAILED). */
const PLATEGA_STATUS = {
  PENDING: [1, 'PENDING', 'pending'],
  CANCELED: [6, 'CANCELED', 'CANCELED', 'canceled'],
  CONFIRMED: [7, 'CONFIRMED', 'confirmed'],
} as const;

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);
  private readonly UNDERPAYMENT_TOLERANCE_PERCENT = 1;

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly plategaService: PlategaService,
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly fraudService: FraudService,
    private readonly userService: UserService,
    private readonly i18n: I18nService,
    @InjectBot() private readonly bot: Telegraf,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  @SkipThrottle()
  @UseGuards(IpWhitelistGuard, WebhookGuard)
  @Post('platega/callback')
  @HttpCode(HttpStatus.OK)
  async handlePlategaCallback(
    @Body() payload: PlategaCallbackPayload,
    @Headers() _headers: Record<string, string>,
  ): Promise<{ success: boolean }> {
    try {
      this.logger.warn(`Platega callback body: ${JSON.stringify(payload)}`);
      const transactionId = payload.id;

      let payment =
        await this.paymentsService.getPaymentByExternalId(transactionId);

      if (!payment && payload.payload) {
        let orderId = payload.payload;
        try {
          const parsedPayload = JSON.parse(payload.payload);
          if (parsedPayload.orderId) {
            orderId = parsedPayload.orderId;
          }
        } catch {}
        payment = await this.paymentsService.getPayment(orderId);
      }

      if (!payment) {
        return { success: true };
      }

      const status = payload.status;
      const statusNum =
        typeof status === 'number' ? status : parseInt(String(status), 10);

      const matchesStatus = (
        statusCode: number | string,
        allowedValues: readonly (number | string)[],
      ): boolean => {
        return (
          allowedValues.includes(statusCode) ||
          allowedValues.includes(String(statusCode).toUpperCase())
        );
      };

      if (statusNum === 7 || matchesStatus(status, PLATEGA_STATUS.CONFIRMED)) {
        if (payload.amount !== undefined && payment.amount_rub) {
          const expectedAmount = Number(payment.amount_rub);
          const receivedAmount = Number(payload.amount);
          const minAllowed =
            expectedAmount * (1 - this.UNDERPAYMENT_TOLERANCE_PERCENT / 100);
          const maxAllowed = expectedAmount * 1.5;

          if (receivedAmount < minAllowed) {
            this.logger.warn(
              `Payment ${payment.id} underpayment: expected ${expectedAmount}, received ${receivedAmount}`,
            );
            await this.prisma.payment.update({
              where: { id: payment.id },
              data: { status: PaymentStatus.FAILED, updated_at: new Date() },
            });
            throw new BadRequestException('Payment amount too low');
          }

          if (receivedAmount > maxAllowed) {
            this.logger.warn(
              `Payment ${payment.id} suspicious overpayment: expected ${expectedAmount}, received ${receivedAmount}`,
            );
          }
        }

        await this.checkPlategaPhoneFraud(
          transactionId,
          payment.id,
          payment.user_telegram_id,
          Number(payment.amount_rub || 0),
        );

        const result = await this.paymentsService.completePaymentWithQueue(
          payment.id,
          { provider_transaction_id: transactionId },
        );

        if (result) {
          const isFraud = result.payment.status === 'FRAUD';

          this.paymentsService['eventEmitter'].emit(
            'payment.completed',
            result.payment,
          );

          if (isFraud) {
            await this.queuePaymentFraudNotification(result.payment);
          } else {
            await this.queuePaymentSuccessNotification(result.payment);
          }
          if (result.queueCreated) {
            await this.queueSalesChannelNotification(result.payment);
          }
        }

        return { success: true };
      }

      if (
        statusNum === 6 ||
        matchesStatus(status, PLATEGA_STATUS.CANCELED)
      ) {
        const cancelledPayment = await this.prisma.$transaction(async (tx) => {
          const currentPayment = await tx.payment.findUnique({
            where: { id: payment.id },
          });

          if (
            !currentPayment ||
            currentPayment.status === PaymentStatus.COMPLETED ||
            currentPayment.status === PaymentStatus.CANCELLED ||
            currentPayment.status === PaymentStatus.REFUNDED
          ) {
            return null;
          }

          return tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.CANCELLED, updated_at: new Date() },
          });
        });

        if (cancelledPayment) {
          await this.queuePaymentCancellationNotification(cancelledPayment);

          this.fraudService
            .checkConsecutiveCancellations(cancelledPayment.user_telegram_id)
            .catch((err) =>
              this.logger.error(
                `Consecutive cancellation check failed: ${err.message}`,
              ),
            );
        }
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error(
        `Error processing Platega callback: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @SkipThrottle()
  @UseGuards(IpWhitelistGuard, WebhookGuard)
  @Post('heleket/callback')
  @HttpCode(HttpStatus.OK)
  async handleHeleketCallback(
    @Body() payload: HeleketCallbackPayload,
    @Headers() _headers: Record<string, string>,
  ): Promise<{ success: boolean }> {
    try {
      const uuid = payload.uuid;
      const orderId = payload.order_id;
      const status = payload.status || payload.payment_status;

      let payment = null;
      if (uuid) {
        payment = await this.paymentsService.getPaymentByExternalId(uuid);
      }
      if (!payment && orderId) {
        payment = await this.paymentsService.getPayment(orderId);
      }

      if (!payment) {
        return { success: true };
      }

      const statusStr = String(status || '').toLowerCase();

      if (
        payload.is_final === false &&
        statusStr !== 'paid' &&
        statusStr !== 'paid_over' &&
        statusStr !== 'cancel' &&
        statusStr !== 'cancelled' &&
        statusStr !== 'canceled'
      ) {
        return { success: true };
      }

      if (statusStr === 'paid' || statusStr === 'paid_over') {
        if (payload.currency && payment.crypto_currency) {
          const receivedCurrency = String(payload.currency).toUpperCase();
          const expectedCurrency = String(
            payment.crypto_currency,
          ).toUpperCase();

          if (receivedCurrency !== expectedCurrency) {
            this.logger.error(
              `Payment ${payment.id} currency mismatch: expected ${expectedCurrency}, received ${receivedCurrency}`,
            );
            await this.prisma.payment.update({
              where: { id: payment.id },
              data: { status: PaymentStatus.FAILED, updated_at: new Date() },
            });
            throw new BadRequestException('Payment currency mismatch');
          }
        }

        if (payload.amount !== undefined && payment.amount_crypto) {
          const expectedAmount = Number(payment.amount_crypto);
          const receivedAmount = Number(payload.amount);
          const minAllowed =
            expectedAmount * (1 - this.UNDERPAYMENT_TOLERANCE_PERCENT / 100);

          if (receivedAmount < minAllowed) {
            this.logger.warn(
              `Payment ${payment.id} underpayment: expected ${expectedAmount}, received ${receivedAmount}`,
            );
            await this.prisma.payment.update({
              where: { id: payment.id },
              data: { status: PaymentStatus.FAILED, updated_at: new Date() },
            });
            throw new BadRequestException('Payment amount too low');
          }
        }

        const txid = payload.txid;
        const result = await this.paymentsService.completePaymentWithQueue(
          payment.id,
          { provider_transaction_id: txid },
        );

        if (result) {
          this.paymentsService['eventEmitter'].emit(
            'payment.completed',
            result.payment,
          );

          await this.queuePaymentSuccessNotification(result.payment);
          if (result.queueCreated) {
            await this.queueSalesChannelNotification(result.payment);
          }
        }

        return { success: true };
      }

      if (
        statusStr === 'cancel' ||
        statusStr === 'cancelled' ||
        statusStr === 'canceled'
      ) {
        const cancelledPayment = await withTransactionRetry(
          () =>
            this.prisma.$transaction(
              async (tx) => {
                const currentPayment = await tx.payment.findUnique({
                  where: { id: payment.id },
                });

                if (
                  !currentPayment ||
                  currentPayment.status === PaymentStatus.COMPLETED ||
                  currentPayment.status === PaymentStatus.CANCELLED
                ) {
                  return null;
                }

                return tx.payment.update({
                  where: { id: payment.id },
                  data: {
                    status: PaymentStatus.CANCELLED,
                    updated_at: new Date(),
                  },
                });
              },
              {
                timeout: 3000,
                isolationLevel: 'ReadCommitted',
              },
            ),
          {
            maxAttempts: 2,
            delayMs: 50,
            operationName: `Heleket cancel ${payment.id}`,
          },
        );

        if (cancelledPayment) {
          await this.queuePaymentCancellationNotification(cancelledPayment);

          this.fraudService
            .checkConsecutiveCancellations(cancelledPayment.user_telegram_id)
            .catch((err) =>
              this.logger.error(
                `Consecutive cancellation check failed: ${err.message}`,
              ),
            );
        }

        return { success: true };
      }

      if (
        statusStr === 'fail' ||
        statusStr === 'wrong_amount' ||
        statusStr === 'system_fail'
      ) {
        this.logger.warn(
          `Payment ${payment.id} failed with status: ${statusStr}`,
        );
        const failedPayment = await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FAILED, updated_at: new Date() },
        });

        await this.queuePaymentFailedNotification(failedPayment);

        return { success: true };
      }

      if (statusStr === 'refund_paid') {
        this.logger.log(`Payment ${payment.id} was refunded`);
        const refundedPayment = await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED, updated_at: new Date() },
        });

        await this.queuePaymentRefundedNotification(refundedPayment);

        return { success: true };
      }

      if (
        statusStr === 'confirm_check' ||
        statusStr === 'refund_process' ||
        statusStr === 'refund_fail'
      ) {
        this.logger.debug(
          `Payment ${payment.id} intermediate status: ${statusStr}`,
        );
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error(
        `Error processing Heleket callback: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async findPaymentByOrderNumber(
    orderNumberStr: string,
  ): Promise<any | null> {
    const num = parseInt(orderNumberStr, 10);
    if (isNaN(num)) return null;
    return this.prisma.payment.findFirst({
      where: { order_number: num },
    });
  }

  private async queuePaymentSuccessNotification(payment: any): Promise<void> {
    try {
      const productName = getProductName(payment);
      const notificationData = {
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
      };

      await this.prisma.notificationQueue.create({
        data: notificationData,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue success notification for ${payment.id}: ${error.message}`,
      );

      await this.sendPaymentSuccessNotificationDirect(payment);
    }
  }

  private async queuePaymentCancellationNotification(
    payment: any,
  ): Promise<void> {
    try {
      const notificationData = {
        user_telegram_id: payment.user_telegram_id,
        message_type: 'cancelled',
        payment_id: payment.id,
        message_data: {
          order_number: payment.order_number,
          payment_message_id: payment.payment_message_id,
          details_message_id: payment.details_message_id,
        },
      };

      await this.prisma.notificationQueue.create({
        data: notificationData,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue cancellation notification for ${payment.id}: ${error.message}`,
      );
    }
  }

  private async queuePaymentFailedNotification(payment: any): Promise<void> {
    try {
      const notificationData = {
        user_telegram_id: payment.user_telegram_id,
        message_type: 'failed',
        payment_id: payment.id,
        message_data: {
          order_number: payment.order_number,
          payment_message_id: payment.payment_message_id,
        },
      };

      await this.prisma.notificationQueue.create({
        data: notificationData,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue failed notification for ${payment.id}: ${error.message}`,
      );
    }
  }

  private async queuePaymentRefundedNotification(payment: any): Promise<void> {
    try {
      const notificationData = {
        user_telegram_id: payment.user_telegram_id,
        message_type: 'refunded',
        payment_id: payment.id,
        message_data: {
          order_number: payment.order_number,
          payment_message_id: payment.payment_message_id,
        },
      };

      await this.prisma.notificationQueue.create({
        data: notificationData,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to queue refund notification for ${payment.id}: ${error.message}`,
      );
    }
  }

  private async queuePaymentFraudNotification(payment: any): Promise<void> {
    try {
      const supportUrl = process.env.SUPPORT_URL || 'https://t.me/Mops_Support';

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

  private async queueSalesChannelNotification(payment: any): Promise<void> {
    setImmediate(() => {
      this.notifySalesChannels(payment).catch((error) => {
        this.logger.error(
          `Error notifying sales channels for ${payment.id}: ${error.message}`,
        );
      });
    });
  }

  private async sendPaymentSuccessNotificationDirect(
    payment: any,
  ): Promise<void> {
    try {
      const lang = await this.userService.getUserLanguage(
        payment.user_telegram_id,
      );
      const caption = await buildMopsPurchaseRewardCaption(
        this.prisma,
        this.i18n,
        lang,
        {
          product_type: payment.product_type,
          product_quantity: payment.product_quantity,
        },
        payment.user_telegram_id,
      );
      const replyMarkup = MainKeyboard.getMopsPurchaseSuccessKeyboard(
        this.i18n,
        lang,
      ).reply_markup;
      await sendOrEditPaymentSuccessPhoto(this.bot, {
        userTelegramId: payment.user_telegram_id,
        paymentMessageId: payment.payment_message_id,
        detailsMessageId: payment.details_message_id,
        caption,
        imagePath: MOPS_PURCHASE_SUCCESS_IMAGE,
        replyMarkup,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to send direct payment success notification: ${error.message}`,
      );
    }
  }

  private async notifySalesChannels(payment: any): Promise<void> {
    try {
      if (!(await this.settingsService.shouldNotifySalesChannelsForPayment(payment))) {
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
        PLATEGA: '🏦 СБП РФ',
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
        paymentMethods[payment.payment_method] || payment.payment_method;
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
      } else if (payment.payment_method === 'HELEKET' && amountUsd > 0) {
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

  private async checkPlategaPhoneFraud(
    transactionId: string,
    paymentId: string,
    userTelegramId: string,
    amountRub: number,
  ): Promise<void> {
    const phone = await this.plategaService.getTransactionPhone(transactionId);

    if (!phone) {
      return;
    }

    await this.fraudService.savePaymentPhone(paymentId, userTelegramId, phone);

    const { isFraud, uniquePhones } = await this.fraudService.checkPhoneFraud(
      userTelegramId,
      amountRub,
    );

    if (isFraud) {
      this.logger.warn(
        `Phone fraud detected for user ${userTelegramId}: ${uniquePhones.length} unique phones`,
      );
      await this.fraudService.handlePhoneFraudDetected(
        userTelegramId,
        uniquePhones,
      );
    }
  }

}
