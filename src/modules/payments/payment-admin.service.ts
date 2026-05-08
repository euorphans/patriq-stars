import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { PaymentsService } from './payments.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { FraudService } from '@/modules/fraud/fraud.service';
import { PaymentStatus } from '@prisma/client';
import { getProductName } from '@/shared/utils';
import { MainKeyboard } from '@/shared/keyboards/main.keyboard';
import { UserService } from '@/modules/user/user.service';
import { I18nService } from '@/shared/services/i18n/i18n.service';
import {
  buildMopsPurchaseRewardCaption,
  MOPS_PURCHASE_SUCCESS_IMAGE,
  sendOrEditPaymentSuccessPhoto,
} from '@/shared/utils/payment-success-notification';

@Injectable()
export class PaymentAdminService {
  private readonly logger = new Logger(PaymentAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly settingsService: SettingsService,
    private readonly fraudService: FraudService,
    private readonly redisLock: RedisLockService,
    private readonly userService: UserService,
    private readonly i18n: I18nService,
    @InjectBot() private readonly bot: Telegraf,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

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

      const completedResult =
        await this.paymentsService.completePaymentWithQueue(paymentId);

      if (!completedResult) {
        return {
          success: false,
          message: 'Не удалось обновить статус платежа',
        };
      }

      const updatedPayment = completedResult.payment;

      if (updatedPayment.status === PaymentStatus.FRAUD) {
        const explain = await this.fraudService.getFraudBlockExplanation(
          payment.user_telegram_id,
          payment.recipient_username,
        );
        this.logger.warn(
          `forceCompletePayment ${paymentId}: still FRAUD after completePaymentWithQueue — ${explain}`,
        );
        return { success: false, message: explain };
      }

      await this.paymentsService.handleCompletedPayment(updatedPayment);
      await this.queuePaymentSuccessNotification(updatedPayment);
      if (completedResult.queueCreated) {
        await this.notifySalesChannels(updatedPayment);
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
        `Failed to send payment success notification: ${error.message}`,
      );
    }
  }

  @OnEvent('payment.failover.triggered')
  async onFailoverTriggered(data: {
    method: string;
    backup: string;
    failures: number;
    cooldownMinutes: number;
  }): Promise<void> {
    const message =
      `🚨 <b>АВТО-FAILOVER</b>\n\n` +
      `Метод <b>${data.method}</b> отключён после ${data.failures} ошибок подряд.\n` +
      `Метод <b>${data.backup}</b> автоматически включён.\n\n` +
      `⏱ Попытка восстановления через ${data.cooldownMinutes} мин.`;
    await this.sendFailoverNotification(message);
  }

  @OnEvent('payment.failover.recovery_attempt')
  async onRecoveryAttempt(data: {
    method: string;
    backup: string;
  }): Promise<void> {
    const message =
      `🔄 <b>Попытка восстановления</b>\n\n` +
      `Метод <b>${data.method}</b> повторно включён для проверки.\n` +
      `<b>${data.backup}</b> также остаётся активным.\n\n` +
      `Если ${data.method} снова упадёт — failover сработает повторно.`;
    await this.sendFailoverNotification(message);
  }

  @OnEvent('payment.failover.recovered')
  async onRecovered(data: { method: string; backup: string }): Promise<void> {
    const message =
      `✅ <b>Восстановление успешно!</b>\n\n` +
      `Метод <b>${data.method}</b> снова работает.\n` +
      `Метод <b>${data.backup}</b> отключён.\n\n` +
      `Работа продолжается в штатном режиме.`;
    await this.sendFailoverNotification(message);
  }

  @OnEvent('payment.failover.recovery_failed')
  async onRecoveryFailed(data: {
    method: string;
    backup: string;
    failures: number;
  }): Promise<void> {
    const message =
      `🔴 <b>Восстановление не удалось</b>\n\n` +
      `Метод <b>${data.method}</b> снова отключён (${data.failures} ошибок).\n` +
      `<b>${data.backup}</b> остаётся активным.`;
    await this.sendFailoverNotification(message);
  }

  @OnEvent('payment.failover.manual_recovery')
  async onManualRecovery(data: {
    method: string;
    backup: string;
  }): Promise<void> {
    const message =
      `🔧 <b>Ручное восстановление</b>\n\n` +
      `Метод <b>${data.method}</b> включён вручную.\n` +
      `Метод <b>${data.backup}</b> отключён.`;
    await this.sendFailoverNotification(message);
  }

  private async sendFailoverNotification(message: string): Promise<void> {
    try {
      const channels =
        await this.settingsService.getInsufficientFundsChannels();
      for (const channel of channels) {
        try {
          await this.adminBot.telegram.sendMessage(
            channel.channel_id,
            message,
            { parse_mode: 'HTML' },
          );
        } catch (err: any) {
          this.logger.warn(
            `Failed to send failover notification to ${channel.channel_id}: ${err.message}`,
          );
        }
      }
      if (channels.length === 0) {
        this.logger.warn(
          `No notification channels configured. Failover message: ${message.replace(/<[^>]+>/g, '')}`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Error sending failover notifications: ${err.message}`);
    }
  }

  @OnEvent('rate.protection.triggered')
  async handleRateProtectionTriggered(data: {
    reason: string;
    userTelegramId: string;
    tonRate?: number;
    usdtRate?: number;
  }): Promise<void> {
    try {
      const dedupeKey = `rate_protection_${Math.floor(Date.now() / 300000)}`;
      if (this.redisLock.isAvailable()) {
        const alreadySent =
          await this.redisLock.isSalesNotificationSent(dedupeKey);
        if (alreadySent) return;
      }

      const channels =
        await this.settingsService.getInsufficientFundsChannels();
      if (!channels || channels.length === 0) return;

      const timeStr =
        new Date()
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

      let ratesText = '';
      if (data.tonRate !== undefined) {
        ratesText += `\n💎 <b>TON/USD:</b> ${data.tonRate.toFixed(4)}`;
      }
      if (data.usdtRate !== undefined) {
        ratesText += `\n💵 <b>USDT/RUB:</b> ${data.usdtRate.toFixed(2)}`;
      }

      const message =
        `⚠️ <b>Курс слишком низкий!</b>\n\n` +
        `🕐 <b>Время:</b> ${timeStr}\n` +
        `📉 <b>Причина:</b> ${data.reason}` +
        `${ratesText}\n\n` +
        `👤 <b>Пользователь:</b> ${data.userTelegramId}\n` +
        `🚫 <b>Покупка заблокирована</b>`;

      for (const channel of channels) {
        if (!channel.is_active) continue;
        try {
          await this.adminBot.telegram.sendMessage(
            channel.channel_id,
            message,
            { parse_mode: 'HTML' },
          );
        } catch (error: any) {
          this.logger.error(
            `Failed to send rate protection notification to ${channel.channel_id}: ${error.message}`,
          );
        }
      }

      if (this.redisLock.isAvailable()) {
        await this.redisLock.markSalesNotificationSent(dedupeKey);
      }
    } catch (error: any) {
      this.logger.error(
        `Error sending rate protection notification: ${error.message}`,
      );
    }
  }

  @OnEvent('fraud.detected')
  async handleFraudDetected(payment: any): Promise<void> {
    try {
      if (this.redisLock.isAvailable()) {
        const alreadySent = await this.redisLock.isSalesNotificationSent(
          `fraud_${payment.id}`,
        );
        if (alreadySent) return;
      }

      const channels = await this.settingsService.getFraudChannels();
      if (!channels || channels.length === 0) return;

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

      const buyerInfo = payment.user_telegram_id
        ? `ID: ${payment.user_telegram_id}`
        : 'Не указан';
      const recipient = payment.recipient_username || payment.recipient_name;
      const recipientInfo = recipient ? `@${recipient}` : 'Не указан';

      const amountRub = parseFloat(payment.amount_rub?.toString() || '0');
      const amountUsd = parseFloat(payment.amount_usd?.toString() || '0');
      const amountTon = parseFloat(payment.amount_ton?.toString() || '0');

      let amountText = '';
      if (payment.payment_method === 'TON' && amountTon > 0) {
        amountText = `${amountTon.toFixed(9)} TON`;
      } else if (payment.payment_method === 'HELEKET' && amountUsd > 0) {
        amountText = `$${amountUsd.toFixed(2)}`;
      } else {
        amountText = `${amountRub.toFixed(2)} ₽`;
      }

      let plategaLine = '';
      if (payment.payment_method === 'PLATEGA' && payment.external_payment_id) {
        plategaLine = `\n🔗 <b>Операция Platega:</b> <code>${payment.external_payment_id}</code>`;
      }

      const text = `
🚨 <b>ПОЙМАН МОШЕННИК!</b>

🕐 <b>Время:</b> ${timeStr}
🆔 <b>Номер заказа:</b> <code>#${payment.order_number}</code>${plategaLine}

👤 <b>Покупатель:</b> ${buyerInfo}
🎁 <b>Получатель:</b> ${recipientInfo}

📦 <b>Товар:</b> ${productNames[payment.product_type] || payment.product_type} x${payment.product_quantity}
💵 <b>Сумма оплаты:</b> ${amountText}

⚠️ <b>Товар НЕ доставлен (пользователь в fraud list)</b>
      `;

      for (const channel of channels) {
        if (!channel.is_active) continue;
        try {
          await this.adminBot.telegram.sendMessage(channel.channel_id, text, {
            parse_mode: 'HTML',
          });
        } catch (error: any) {
          this.logger.error(
            `Failed to send fraud notification to channel ${channel.channel_id}: ${error.message}`,
          );
        }
      }

      if (this.redisLock.isAvailable()) {
        await this.redisLock.markSalesNotificationSent(`fraud_${payment.id}`);
      }
    } catch (error: any) {
      this.logger.error(`Error sending fraud notification: ${error.message}`);
    }
  }

  private async notifySalesChannels(payment: any): Promise<void> {
    try {
      if (!(await this.settingsService.shouldNotifySalesChannelsForPayment(payment))) {
        return;
      }

      const channels = await this.settingsService.getSalesChannels();
      if (!channels || channels.length === 0) return;

      if (this.redisLock.isAvailable()) {
        const claimed = await this.redisLock.tryClaimSalesNotification(
          payment.id,
        );
        if (!claimed) return;
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

      const buyerInfo = payment.user_telegram_id
        ? `ID: ${payment.user_telegram_id}`
        : 'Не указан';
      const recipient = payment.recipient_username || payment.recipient_name;
      const recipientInfo = recipient ? `@${recipient}` : 'Не указан';

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

      const text = `
💰 <b>Новая продажа!</b>

🕐 <b>Время:</b> ${timeStr}
🆔 <b>Номер заказа:</b> <code>#${payment.order_number}</code>

👤 <b>Покупатель:</b> ${buyerInfo}
🎁 <b>Получатель:</b> ${recipientInfo}

📦 <b>Товар:</b> ${productLine}
💳 <b>Способ оплаты:</b> ${paymentMethods[payment.payment_method] || payment.payment_method}

💵 <b>Сумма оплаты:</b> ${amountText}
💸 <b>Наш доход:</b> ${netProfit.toFixed(2)} ₽
      `;

      for (const channel of channels) {
        if (!channel.is_active) continue;
        try {
          await this.adminBot.telegram.sendMessage(channel.channel_id, text, {
            parse_mode: 'HTML',
          });
        } catch (error: any) {
          this.logger.error(
            `Failed to send to channel ${channel.channel_id}: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error sending sales notifications: ${error.message}`);
    }
  }
}
