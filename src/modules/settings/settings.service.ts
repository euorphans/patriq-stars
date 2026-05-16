import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private settingsCache = new Map<
    string,
    { value: string | null; expires: number }
  >();
  private channelsCache: { data: any[] | null; expires: number } = {
    data: null,
    expires: 0,
  };
  private purchaseLimitsCache: {
    data: {
      minStars: number;
      maxStars: number;
      minTon: number;
      maxTon: number;
      sbpLimitRub: number;
      sbpLimitStars: number;
    } | null;
    expires: number;
  } = { data: null, expires: 0 };
  private readonly SETTINGS_CACHE_TTL = 60000;
  private readonly CHANNELS_CACHE_TTL = 120000;

  private static readonly REDIS_BOT_ENABLED_KEY = 'settings:bot_enabled';
  private static readonly REDIS_BOT_ENABLED_TTL = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
  ) {}

  async onModuleInit() {
    try {
      this.logger.log('Initializing default settings...');
      await this.initializeDefaultSettings();
      this.logger.log('✅ Default settings initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize default settings: ${error.message}`,
        error.stack,
      );
    }
  }

  async getSetting(key: string): Promise<string | null> {
    const cached = this.settingsCache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.value;
    }

    const setting = await this.prisma.botSettings.findUnique({
      where: { setting_key: key },
    });

    const value = setting?.setting_value || null;
    this.settingsCache.set(key, {
      value,
      expires: Date.now() + this.SETTINGS_CACHE_TTL,
    });

    return value;
  }

  clearSettingsCache(): void {
    this.settingsCache.clear();
    this.channelsCache = { data: null, expires: 0 };
    this.purchaseLimitsCache = { data: null, expires: 0 };
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settingsCache.delete(key);

    await this.prisma.botSettings.upsert({
      where: { setting_key: key },
      update: { setting_value: value },
      create: {
        setting_key: key,
        setting_value: value,
      },
    });
  }

  async isBotEnabled(): Promise<boolean> {
    const cached = await this.redisLock.get(
      SettingsService.REDIS_BOT_ENABLED_KEY,
    );
    if (cached !== null) {
      return cached === 'true';
    }

    const value = await this.getSetting('bot_enabled');
    const enabled = value === 'true';

    await this.redisLock.setWithTTL(
      SettingsService.REDIS_BOT_ENABLED_KEY,
      String(enabled),
      SettingsService.REDIS_BOT_ENABLED_TTL,
    );

    return enabled;
  }

  async setBotEnabled(enabled: boolean): Promise<void> {
    await this.setSetting('bot_enabled', enabled ? 'true' : 'false');

    await this.redisLock.setWithTTL(
      SettingsService.REDIS_BOT_ENABLED_KEY,
      String(enabled),
      SettingsService.REDIS_BOT_ENABLED_TTL,
    );
  }

  async getRequiredChannels() {
    if (this.channelsCache.data && Date.now() < this.channelsCache.expires) {
      return this.channelsCache.data;
    }

    const channels = await this.prisma.requiredChannel.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'desc' },
    });

    this.channelsCache = {
      data: channels,
      expires: Date.now() + this.CHANNELS_CACHE_TTL,
    };
    return channels;
  }

  async addRequiredChannel(
    channelId: string,
    channelName?: string,
    channelLink?: string,
  ) {
    this.channelsCache = { data: null, expires: 0 };
    return this.prisma.requiredChannel.create({
      data: {
        channel_id: channelId,
        channel_name: channelName,
        channel_link: channelLink,
      },
    });
  }

  async removeRequiredChannel(channelId: string) {
    this.channelsCache = { data: null, expires: 0 };
    return this.prisma.requiredChannel.delete({
      where: { channel_id: channelId },
    });
  }

  async getSalesChannels() {
    return this.prisma.salesNotificationChannel.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async addSalesChannel(channelId: string, channelName?: string) {
    return this.prisma.salesNotificationChannel.upsert({
      where: { channel_id: channelId },
      update: {
        channel_name: channelName,
        is_active: true,
      },
      create: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });
  }

  async removeSalesChannel(channelId: string) {
    return this.prisma.salesNotificationChannel.delete({
      where: { channel_id: channelId },
    });
  }

  /** Минимальная сумма заказа в ₽ (поле amount_rub) для уведомления в каналы продаж. 0 — без порога. */
  async getSalesNotificationMinAmountRub(): Promise<number> {
    const value = await this.getSetting('sales_notification_min_amount_rub');
    if (value === null || value === '') {
      return 2500;
    }
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) {
      return 2500;
    }
    return Math.floor(n);
  }

  async setSalesNotificationMinAmountRub(amount: number): Promise<void> {
    const v = Math.max(0, Math.floor(Number(amount)));
    this.settingsCache.delete('sales_notification_min_amount_rub');
    await this.setSetting('sales_notification_min_amount_rub', String(v));
  }

  /** Уведомление в каналы продаж: порог по сумме заказа в ₽ (amount_rub). */
  async shouldNotifySalesChannelsForPayment(payment: {
    amount_rub?: unknown;
  }): Promise<boolean> {
    const minRub = await this.getSalesNotificationMinAmountRub();
    if (minRub <= 0) {
      return true;
    }
    const amountRub = parseFloat(String(payment.amount_rub ?? '0'));
    return Number.isFinite(amountRub) && amountRub >= minRub;
  }

  async getInsufficientFundsChannels() {
    return this.prisma.insufficientFundsNotificationChannel.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async addInsufficientFundsChannel(channelId: string, channelName?: string) {
    return this.prisma.insufficientFundsNotificationChannel.upsert({
      where: { channel_id: channelId },
      update: {
        channel_name: channelName,
        is_active: true,
      },
      create: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });
  }

  async removeInsufficientFundsChannel(channelId: string) {
    return this.prisma.insufficientFundsNotificationChannel.delete({
      where: { channel_id: channelId },
    });
  }

  async getFraudChannels() {
    return this.prisma.fraudNotificationChannel.findMany({
      where: { is_active: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async addFraudChannel(channelId: string, channelName?: string) {
    return this.prisma.fraudNotificationChannel.upsert({
      where: { channel_id: channelId },
      update: {
        channel_name: channelName,
        is_active: true,
      },
      create: {
        channel_id: channelId,
        channel_name: channelName,
      },
    });
  }

  async removeFraudChannel(channelId: string) {
    return this.prisma.fraudNotificationChannel.delete({
      where: { channel_id: channelId },
    });
  }

  async isPaymentCaptchaEnabled(): Promise<boolean> {
    const value = await this.getSetting('payment_captcha_enabled');
    return value !== 'false';
  }

  async setPaymentCaptchaEnabled(enabled: boolean): Promise<void> {
    this.settingsCache.delete('payment_captcha_enabled');
    await this.setSetting(
      'payment_captcha_enabled',
      enabled ? 'true' : 'false',
    );
  }

  async initializeDefaultSettings(): Promise<void> {
    const defaultSettings = [
      { key: 'bot_enabled', value: 'true' },
      { key: 'payment_captcha_enabled', value: 'true' },
      {
        key: 'sales_notification_min_amount_rub',
        value: '2500',
      },
      { key: 'min_ton_rate_usd', value: '0' },
      { key: 'min_usdt_rate_rub', value: '0' },
      { key: 'failover_enabled', value: 'true' },
      { key: 'failover_threshold', value: '3' },
      { key: 'failover_cooldown_minutes', value: '5' },
      { key: 'failover_auto_recovery', value: 'true' },
    ];

    for (const { key, value } of defaultSettings) {
      const existing = await this.prisma.botSettings.findUnique({
        where: { setting_key: key },
      });

      if (!existing) {
        await this.prisma.botSettings.create({
          data: {
            setting_key: key,
            setting_value: value,
          },
        });
      }
    }

    const methods = ['FREEKASSA', 'FREEKASSA_CARD', 'FREEKASSA_CRYPTO', 'TON'];
    for (const method of methods) {
      const key = `payment_method_enabled_${method}`;
      const existing = await this.getSetting(key);
      if (existing === null) {
        await this.setSetting(key, 'true');
      }
    }

    const orderKey = 'payment_methods_order';
    const existingOrder = await this.getSetting(orderKey);
    if (!existingOrder) {
      await this.setSetting(orderKey, JSON.stringify(methods));
    } else {
      try {
        const parsed: string[] = JSON.parse(existingOrder);
        let order = parsed.filter((m) => m !== 'HELEKET' && m !== 'PLATEGA');
        await this.prisma.botSettings
          .deleteMany({ where: { setting_key: 'payment_method_enabled_PLATEGA' } })
          .catch(() => {});
        if (!order.includes('FREEKASSA_CARD')) {
          const fkIdx = order.indexOf('FREEKASSA');
          if (fkIdx >= 0) {
            order.splice(fkIdx + 1, 0, 'FREEKASSA_CARD');
          } else {
            order.push('FREEKASSA_CARD');
          }
        }
        if (!order.includes('FREEKASSA_CRYPTO')) {
          const cardIdx = order.indexOf('FREEKASSA_CARD');
          const fkIdx = order.indexOf('FREEKASSA');
          const insertAfter = cardIdx >= 0 ? cardIdx : fkIdx;
          if (insertAfter >= 0) {
            order.splice(insertAfter + 1, 0, 'FREEKASSA_CRYPTO');
          } else {
            order.push('FREEKASSA_CRYPTO');
          }
        }
        const newMethods = methods.filter((m) => !order.includes(m));
        if (
          newMethods.length > 0 ||
          order.length !==
            parsed.filter((m) => m !== 'HELEKET' && m !== 'PLATEGA').length ||
          parsed.some((m) => m === 'HELEKET' || m === 'PLATEGA')
        ) {
          await this.setSetting(
            orderKey,
            JSON.stringify([...order, ...newMethods]),
          );
          this.settingsCache.delete(orderKey);
        }
      } catch {}
    }

    await this.setPaymentMethodEnabled('HELEKET', false);
  }

  async isPaymentMethodEnabled(method: string): Promise<boolean> {
    const key = `payment_method_enabled_${method.toUpperCase()}`;
    const value = await this.getSetting(key);

    if (value === null) {
      return true;
    }
    return value === 'true';
  }

  async setPaymentMethodEnabled(
    method: string,
    enabled: boolean,
  ): Promise<void> {
    const key = `payment_method_enabled_${method.toUpperCase()}`;
    this.settingsCache.delete(key);
    await this.setSetting(key, enabled ? 'true' : 'false');
  }

  async getAllPaymentMethodStatuses(): Promise<
    Array<{ method: string; enabled: boolean }>
  > {
    const order = await this.getPaymentMethodsOrder();
    const results: Array<{ method: string; enabled: boolean }> = [];

    for (const method of order) {
      const enabled = await this.isPaymentMethodEnabled(method);
      results.push({ method, enabled });
    }

    return results;
  }

  async getPaymentMethodsOrder(): Promise<string[]> {
    const validMethods = ['FREEKASSA', 'FREEKASSA_CARD', 'FREEKASSA_CRYPTO', 'TON'];
    const value = await this.getSetting('payment_methods_order');
    if (!value) {
      return validMethods;
    }
    try {
      const parsed: string[] = JSON.parse(value);
      const filtered = parsed
        .filter((m) => validMethods.includes(m))
        .filter((m) => m !== 'HELEKET');
      return [
        ...filtered,
        ...validMethods.filter((m) => !filtered.includes(m)),
      ];
    } catch {
      return validMethods;
    }
  }

  async setPaymentMethodsOrder(order: string[]): Promise<void> {
    this.settingsCache.delete('payment_methods_order');
    await this.setSetting('payment_methods_order', JSON.stringify(order));
  }

  async movePaymentMethodUp(method: string): Promise<string[]> {
    const order = await this.getPaymentMethodsOrder();
    const index = order.indexOf(method.toUpperCase());
    if (index > 0) {
      [order[index - 1], order[index]] = [order[index], order[index - 1]];
      await this.setPaymentMethodsOrder(order);
    }
    return order;
  }

  async movePaymentMethodDown(method: string): Promise<string[]> {
    const order = await this.getPaymentMethodsOrder();
    const index = order.indexOf(method.toUpperCase());
    if (index >= 0 && index < order.length - 1) {
      [order[index], order[index + 1]] = [order[index + 1], order[index]];
      await this.setPaymentMethodsOrder(order);
    }
    return order;
  }

  async getEnabledPaymentMethods(): Promise<string[]> {
    const order = await this.getPaymentMethodsOrder();
    const enabled: string[] = [];
    for (const method of order) {
      if (await this.isPaymentMethodEnabled(method)) {
        enabled.push(method);
      }
    }
    return enabled;
  }

  async getMinTonRateUsd(): Promise<number> {
    const value = await this.getSetting('min_ton_rate_usd');
    return parseFloat(value || '0');
  }

  async setMinTonRateUsd(rate: number): Promise<void> {
    await this.setSetting('min_ton_rate_usd', rate.toString());
  }

  async getMinUsdtRateRub(): Promise<number> {
    const value = await this.getSetting('min_usdt_rate_rub');
    return parseFloat(value || '0');
  }

  async setMinUsdtRateRub(rate: number): Promise<void> {
    await this.setSetting('min_usdt_rate_rub', rate.toString());
  }

  async isPhoneFraudEnabled(): Promise<boolean> {
    const value = await this.getSetting('phone_fraud_enabled');
    return value === null ? true : value === 'true';
  }

  async setPhoneFraudEnabled(enabled: boolean): Promise<void> {
    await this.setSetting('phone_fraud_enabled', enabled ? 'true' : 'false');
    this.settingsCache.delete('phone_fraud_enabled');
  }

  async getPhoneFraudMinAmount(): Promise<number> {
    const value = await this.getSetting('phone_fraud_min_amount');
    return value ? parseInt(value, 10) : 300;
  }

  async setPhoneFraudMinAmount(amount: number): Promise<void> {
    await this.setSetting('phone_fraud_min_amount', amount.toString());
    this.settingsCache.delete('phone_fraud_min_amount');
  }

  async isCardFraudEnabled(): Promise<boolean> {
    const value = await this.getSetting('card_fraud_enabled');
    return value === null ? true : value === 'true';
  }

  async setCardFraudEnabled(enabled: boolean): Promise<void> {
    await this.setSetting('card_fraud_enabled', enabled ? 'true' : 'false');
    this.settingsCache.delete('card_fraud_enabled');
  }

  async getCardFraudMinAmount(): Promise<number> {
    const value = await this.getSetting('card_fraud_min_amount');
    return value ? parseInt(value, 10) : 300;
  }

  async setCardFraudMinAmount(amount: number): Promise<void> {
    await this.setSetting('card_fraud_min_amount', amount.toString());
    this.settingsCache.delete('card_fraud_min_amount');
  }

  async isCancellationFraudEnabled(): Promise<boolean> {
    const value = await this.getSetting('cancellation_fraud_enabled');
    return value === null ? true : value === 'true';
  }

  async setCancellationFraudEnabled(enabled: boolean): Promise<void> {
    await this.setSetting(
      'cancellation_fraud_enabled',
      enabled ? 'true' : 'false',
    );
    this.settingsCache.delete('cancellation_fraud_enabled');
  }

  async getCancellationFraudMinAmount(): Promise<number> {
    const value = await this.getSetting('cancellation_fraud_min_amount');
    return value ? parseInt(value, 10) : 300;
  }

  async setCancellationFraudMinAmount(amount: number): Promise<void> {
    await this.setSetting('cancellation_fraud_min_amount', amount.toString());
    this.settingsCache.delete('cancellation_fraud_min_amount');
  }

  async checkRateProtection(
    tonRateUsd: number,
    usdtRateRub: number,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const [minTonRate, minUsdtRate] = await Promise.all([
      this.getMinTonRateUsd(),
      this.getMinUsdtRateRub(),
    ]);

    if (minTonRate > 0 && tonRateUsd < minTonRate) {
      return {
        allowed: false,
        reason: `TON rate too low: ${tonRateUsd.toFixed(4)} USD (minimum: ${minTonRate.toFixed(4)} USD)`,
      };
    }

    if (minUsdtRate > 0 && usdtRateRub < minUsdtRate) {
      return {
        allowed: false,
        reason: `USDT rate too low: ${usdtRateRub.toFixed(2)} RUB (minimum: ${minUsdtRate.toFixed(2)} RUB)`,
      };
    }

    return { allowed: true };
  }

  async getPurchaseLimits(): Promise<{
    minStars: number;
    maxStars: number;
    minTon: number;
    maxTon: number;
    sbpLimitRub: number;
    sbpLimitStars: number;
  }> {
    if (
      this.purchaseLimitsCache.data &&
      Date.now() < this.purchaseLimitsCache.expires
    ) {
      return this.purchaseLimitsCache.data;
    }

    const [minStars, maxStars, minTon, maxTon, sbpLimitRub, sbpLimitStars] =
      await Promise.all([
        this.getSetting('min_stars_purchase'),
        this.getSetting('max_stars_purchase'),
        this.getSetting('min_ton_purchase'),
        this.getSetting('max_ton_purchase'),
        this.getSetting('sbp_limit_rub'),
        this.getSetting('sbp_limit_stars'),
      ]);

    const data = {
      minStars: minStars
        ? parseInt(minStars, 10)
        : parseInt(process.env.MIN_STARS_PURCHASE || '50', 10),
      maxStars: maxStars
        ? parseInt(maxStars, 10)
        : parseInt(process.env.MAX_STARS_PURCHASE || '100000', 10),
      minTon: minTon
        ? parseInt(minTon, 10)
        : parseInt(process.env.MIN_TON_PURCHASE || '1', 10),
      maxTon: maxTon
        ? parseInt(maxTon, 10)
        : parseInt(process.env.MAX_TON_PURCHASE || '10000', 10),
      sbpLimitRub: sbpLimitRub ? parseInt(sbpLimitRub, 10) : 300000,
      sbpLimitStars: sbpLimitStars ? parseInt(sbpLimitStars, 10) : 20000,
    };

    this.purchaseLimitsCache = {
      data,
      expires: Date.now() + this.SETTINGS_CACHE_TTL,
    };
    return data;
  }

  async setPurchaseLimits(limits: {
    minStars?: number;
    maxStars?: number;
    minTon?: number;
    maxTon?: number;
    sbpLimitRub?: number;
    sbpLimitStars?: number;
  }): Promise<void> {
    this.purchaseLimitsCache = { data: null, expires: 0 };

    const updates: Promise<void>[] = [];

    if (limits.minStars !== undefined) {
      this.settingsCache.delete('min_stars_purchase');
      updates.push(
        this.setSetting('min_stars_purchase', String(limits.minStars)),
      );
    }
    if (limits.maxStars !== undefined) {
      this.settingsCache.delete('max_stars_purchase');
      updates.push(
        this.setSetting('max_stars_purchase', String(limits.maxStars)),
      );
    }
    if (limits.minTon !== undefined) {
      this.settingsCache.delete('min_ton_purchase');
      updates.push(this.setSetting('min_ton_purchase', String(limits.minTon)));
    }
    if (limits.maxTon !== undefined) {
      this.settingsCache.delete('max_ton_purchase');
      updates.push(this.setSetting('max_ton_purchase', String(limits.maxTon)));
    }
    if (limits.sbpLimitRub !== undefined) {
      this.settingsCache.delete('sbp_limit_rub');
      updates.push(
        this.setSetting('sbp_limit_rub', String(limits.sbpLimitRub)),
      );
    }
    if (limits.sbpLimitStars !== undefined) {
      this.settingsCache.delete('sbp_limit_stars');
      updates.push(
        this.setSetting('sbp_limit_stars', String(limits.sbpLimitStars)),
      );
    }

    await Promise.all(updates);
  }
}
