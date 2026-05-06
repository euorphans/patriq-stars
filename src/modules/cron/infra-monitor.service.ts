import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { FragmentService } from '@/shared/services/fragment/fragment.service';
import { FragmentAccountService } from '@/shared/services/fragment/fragment-account.service';
import { TonWalletService } from '@/shared/services/ton-wallet/ton-wallet.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

const FRAGMENT_FAIL_THRESHOLD = 2;

const ALERT_COOLDOWN_MINUTES = 30;

const EXPIRY_WARN_DAYS = [14, 7, 3, 1];

@Injectable()
export class InfraMonitorService {
  private readonly logger = new Logger(InfraMonitorService.name);

  private fragmentFailCounts = new Map<string, number>();

  private lastAlertAt = new Map<string, number>();

  private toncenterFailCount = 0;

  constructor(
    private readonly fragmentService: FragmentService,
    private readonly fragmentAccountService: FragmentAccountService,
    private readonly tonWalletService: TonWalletService,
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  @Cron('0 */5 * * * *')
  async checkFragmentAccounts(): Promise<void> {
    const lockKey = 'infra-monitor:fragment';
    if (!(await this.tryLock(lockKey, 240))) return;

    try {
      const accounts = await this.fragmentAccountService.getAllActiveAccounts();

      if (accounts.length === 0) {
        await this.sendAlert(
          'fragment:no-accounts',
          '⚠️ <b>Fragment: нет активных аккаунтов!</b>\n\nВсе Fragment аккаунты отключены или удалены. Доставка звёзд/премиума невозможна.',
        );
        return;
      }

      for (const account of accounts) {
        const health = await this.fragmentService.checkAccountHealth(account);

        if (!health.alive) {
          const count = (this.fragmentFailCounts.get(account.id) ?? 0) + 1;
          this.fragmentFailCounts.set(account.id, count);

          this.logger.warn(
            `Fragment account "${account.name}" health check failed (${count}/${FRAGMENT_FAIL_THRESHOLD}): ${health.error}`,
          );

          if (count >= FRAGMENT_FAIL_THRESHOLD) {
            const isAuth = (health.error ?? '')
              .toLowerCase()
              .match(/auth|session|login|unauthorized|not authorized/);

            const reason = isAuth
              ? '🔐 Сессия истекла / авторизация недействительна'
              : `❌ ${health.error ?? 'Нет ответа'}`;

            await this.sendAlert(
              `fragment:${account.id}`,
              `🚨 <b>Fragment аккаунт отлетел!</b>\n\n` +
                `👤 Аккаунт: <b>${account.name}</b>\n` +
                `🆔 ID: <code>${account.id}</code>\n` +
                `📋 Причина: ${reason}\n\n` +
                `⚠️ Доставка через этот аккаунт недоступна. Обновите куки в /fragment_accounts`,
            );
          }
        } else {
          if (this.fragmentFailCounts.get(account.id)) {
            this.logger.log(`Fragment account "${account.name}" recovered`);

            if (this.lastAlertAt.has(`fragment:${account.id}`)) {
              await this.sendAlert(
                `fragment:${account.id}:recovery`,
                `✅ <b>Fragment аккаунт восстановлен</b>\n\n` +
                  `👤 Аккаунт: <b>${account.name}</b> снова доступен.`,
                true,
              );
              this.lastAlertAt.delete(`fragment:${account.id}`);
            }
          }
          this.fragmentFailCounts.set(account.id, 0);
        }
      }
    } catch (err: any) {
      this.logger.error(`Fragment monitor error: ${err.message}`);
    } finally {
      await this.unlock(lockKey);
    }
  }

  @Cron('0 */10 * * * *')
  async checkToncenter(): Promise<void> {
    const lockKey = 'infra-monitor:toncenter';
    if (!(await this.tryLock(lockKey, 540))) return;

    try {
      if (!this.tonWalletService.isToncenterConfigured()) {
        return;
      }

      const { total, ok, failures } =
        await this.tonWalletService.checkAllToncenterKeys();

      if (total === 0) return;

      const allDown = ok === 0;
      const someDown = failures.length > 0 && !allDown;

      if (allDown) {
        this.toncenterFailCount++;
        const errorMsg =
          failures.map((f) => `Ключ ${f.index}: ${f.error}`).join('\n') ||
          'Unknown error';
        this.logger.warn(
          `TonCenter health check failed — all ${total} key(s) down (${this.toncenterFailCount}): ${errorMsg}`,
        );
        if (this.toncenterFailCount >= 2) {
          await this.sendAlert(
            'toncenter:down',
            `🚨 <b>TonCenter недоступен!</b>\n\n` +
              `Все <b>${total}</b> ключ(ей) не отвечают.\n\n` +
              `📋 Ошибки:\n<code>${errorMsg.replace(/</g, '&lt;')}</code>\n\n` +
              `⚠️ TON транзакции не проходят. Проверьте API ключи и лимиты на toncenter.com`,
          );
        }
        return;
      }

      if (someDown) {
        const lines = failures.map(
          (f) =>
            `• Ключ ${f.index}/${total}: <code>${(f.error || '').replace(/</g, '&lt;')}</code>`,
        );
        await this.sendAlert(
          'toncenter:partial',
          `⚠️ <b>Часть TonCenter ключей не работает</b>\n\n` +
            `Работают: <b>${ok} из ${total}</b>. Транзакции идут, но запас по RPS снижен.\n\n` +
            `Не отвечают:\n${lines.join('\n')}\n\n` +
            `Проверьте ключи на toncenter.com`,
          true,
        );
      }

      if (ok === total) {
        if (
          this.toncenterFailCount > 0 ||
          this.lastAlertAt.has('toncenter:down')
        ) {
          this.logger.log('TonCenter recovered (all keys ok)');
          await this.sendAlert(
            'toncenter:recovery',
            `✅ <b>TonCenter восстановлен</b>\n\nВсе ${total} ключ(ей) отвечают. TON транзакции в штатном режиме.`,
            true,
          );
          this.lastAlertAt.delete('toncenter:down');
        }
        this.toncenterFailCount = 0;
      }
    } catch (err: any) {
      this.logger.error(`TonCenter monitor error: ${err.message}`);
    } finally {
      await this.unlock(lockKey);
    }
  }

  @Cron('0 0 6 * * *')
  async checkExpiryAlerts(): Promise<void> {
    const lockKey = 'infra-monitor:expiry';
    if (!(await this.tryLock(lockKey, 3500))) return;

    try {
      await this.checkToncenterSubscriptions();
      await this.checkServerExpiry();
    } catch (err: any) {
      this.logger.error(`Expiry monitor error: ${err.message}`);
    } finally {
      await this.unlock(lockKey);
    }
  }

  private async checkToncenterSubscriptions(): Promise<void> {
    const expiryStr = await this.getSettingValue(
      'toncenter_subscription_expires_at',
    );
    if (!expiryStr) return;

    const expiryDate = new Date(expiryStr);
    if (isNaN(expiryDate.getTime())) {
      this.logger.warn(
        `Invalid toncenter_subscription_expires_at value: ${expiryStr}`,
      );
      return;
    }

    const effectiveExpiry = this.getEffectiveExpiryDate(expiryDate);
    const daysLeft = Math.ceil(
      (effectiveExpiry.getTime() - Date.now()) / 86400000,
    );

    if (EXPIRY_WARN_DAYS.includes(daysLeft)) {
      const emoji = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
      await this.sendAlert(
        `toncenter-expiry:${daysLeft}d`,
        `${emoji} <b>TonCenter подписка истекает через ${daysLeft} ${this.dayWord(daysLeft)}!</b>\n\n` +
          `📅 Дата истечения: <b>${this.formatDate(effectiveExpiry)}</b>\n\n` +
          `💳 Продлите подписку на <a href="https://toncenter.com">toncenter.com</a> чтобы не прервать работу TON транзакций.`,
        true,
      );
    }

    if (daysLeft <= 0) {
      await this.sendAlert(
        'toncenter-expiry:expired',
        `🔴 <b>TonCenter подписка ИСТЕКЛА!</b>\n\n` +
          `📅 Истекла: <b>${this.formatDate(effectiveExpiry)}</b>\n\n` +
          `❌ TON транзакции не работают! Немедленно продлите подписку на toncenter.com`,
      );
    }
  }

  private async checkServerExpiry(): Promise<void> {
    const expiryStr = await this.getSettingValue('server_expires_at');
    if (!expiryStr) return;

    const expiryDate = new Date(expiryStr);
    if (isNaN(expiryDate.getTime())) {
      this.logger.warn(`Invalid server_expires_at value: ${expiryStr}`);
      return;
    }

    const effectiveExpiry = this.getEffectiveExpiryDate(expiryDate);
    const daysLeft = Math.ceil(
      (effectiveExpiry.getTime() - Date.now()) / 86400000,
    );

    if (EXPIRY_WARN_DAYS.includes(daysLeft)) {
      const emoji = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
      await this.sendAlert(
        `server-expiry:${daysLeft}d`,
        `${emoji} <b>Сервер требует оплаты через ${daysLeft} ${this.dayWord(daysLeft)}!</b>\n\n` +
          `📅 Дата истечения: <b>${this.formatDate(effectiveExpiry)}</b>\n\n` +
          `🖥️ Оплатите сервер чтобы не допустить остановки бота.`,
        true,
      );
    }

    if (daysLeft <= 0) {
      await this.sendAlert(
        'server-expiry:expired',
        `🔴 <b>Срок оплаты сервера ИСТЁК!</b>\n\n` +
          `📅 Истёк: <b>${this.formatDate(effectiveExpiry)}</b>\n\n` +
          `❌ Сервер может быть отключён в любой момент!`,
      );
    }
  }

  private getEffectiveExpiryDate(expiryDate: Date): Date {
    const now = new Date();
    if (expiryDate.getTime() > now.getTime()) {
      return expiryDate;
    }
    const day = expiryDate.getDate();
    let next = new Date(now.getFullYear(), now.getMonth(), day);
    if (next.getTime() <= now.getTime()) {
      next = new Date(now.getFullYear(), now.getMonth() + 1, day);
    }
    return next;
  }

  private async sendAlert(
    alertKey: string,
    message: string,
    forceNoDedup = false,
  ): Promise<void> {
    const now = Date.now();
    const cooldownMs = ALERT_COOLDOWN_MINUTES * 60 * 1000;

    if (!forceNoDedup) {
      const lastSent = this.lastAlertAt.get(alertKey);
      if (lastSent && now - lastSent < cooldownMs) {
        this.logger.debug(`Alert "${alertKey}" suppressed (cooldown)`);
        return;
      }
    }

    this.lastAlertAt.set(alertKey, now);

    let channels: { channel_id: string }[] = [];
    try {
      channels = await this.settingsService.getInsufficientFundsChannels();
    } catch {}

    if (channels.length === 0) {
      const envChannel = process.env.ADMIN_ALERT_CHANNEL_ID;
      if (envChannel) channels = [{ channel_id: envChannel }];
    }

    if (channels.length === 0) {
      this.logger.warn(
        `No insufficient-funds (alert) channels configured. Message: ${message}`,
      );
      return;
    }

    for (const ch of channels) {
      try {
        await this.adminBot.telegram.sendMessage(ch.channel_id, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        } as any);
      } catch (err: any) {
        this.logger.error(
          `Failed to send alert to channel ${ch.channel_id}: ${err.message}`,
        );
      }
    }
  }

  private async getSettingValue(key: string): Promise<string | null> {
    try {
      const setting = await this.prisma.botSettings.findUnique({
        where: { setting_key: key },
      });
      return setting?.setting_value ?? null;
    } catch {
      return null;
    }
  }

  private async tryLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.redisLock.isAvailable()) {
      return this.redisLock.acquireLock(key, ttlSeconds);
    }
    return true;
  }

  private async unlock(key: string): Promise<void> {
    if (this.redisLock.isAvailable()) {
      await this.redisLock.releaseLock(key);
    }
  }

  private dayWord(n: number): string {
    const abs = Math.abs(n);
    if (abs % 100 >= 11 && abs % 100 <= 14) return 'дней';
    const rem = abs % 10;
    if (rem === 1) return 'день';
    if (rem >= 2 && rem <= 4) return 'дня';
    return 'дней';
  }

  private formatDate(d: Date): string {
    return d.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Europe/Moscow',
    });
  }
}
