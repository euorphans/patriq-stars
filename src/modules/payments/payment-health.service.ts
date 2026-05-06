import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { SettingsService } from '@/modules/settings/settings.service';

export interface MethodHealthStatus {
  method: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
  failoverActive: boolean;
  failoverTriggeredAt: Date | null;
  recoveryInProgress: boolean;
}

@Injectable()
export class PaymentHealthService implements OnModuleInit {
  private readonly logger = new Logger(PaymentHealthService.name);

  private readonly R = 'payment_health:';
  private readonly FAILURE_TTL = 3600;
  private readonly FAILOVER_TTL = 86400;
  private readonly TIMESTAMP_TTL = 7200;
  private readonly LOCK_TTL = 30;
  private readonly CRON_LOCK_TTL = 130;

  private cache = {
    failures: new Map<string, number>(),
    lastFailureAt: new Map<string, number>(),
    lastSuccessAt: new Map<string, number>(),
    failoverActive: new Map<string, boolean>(),
    failoverTriggeredAt: new Map<string, number>(),
    recoveryInProgress: new Map<string, boolean>(),
  };

  private readonly FAILOVER_PAIRS: Record<string, string> = {
    PLATEGA: 'AURAPAY_SBP',
    AURAPAY_SBP: 'PLATEGA',
  };

  private loggedFailoverStates = new Set<string>();

  constructor(
    private readonly redisLock: RedisLockService,
    private readonly settingsService: SettingsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncCacheFromRedis();
  }

  private async syncCacheFromRedis(): Promise<void> {
    if (!this.redisLock.isAvailable()) return;

    for (const method of Object.keys(this.FAILOVER_PAIRS)) {
      try {
        const failures = await this.redisLock.get(
          `${this.R}failures:${method}`,
        );
        if (failures !== null) {
          this.cache.failures.set(method, parseInt(failures, 10));
        }

        const failover = await this.redisLock.get(
          `${this.R}failover:${method}`,
        );
        if (failover) {
          this.cache.failoverActive.set(method, true);
          this.cache.failoverTriggeredAt.set(method, parseInt(failover, 10));
        } else {
          this.cache.failoverActive.set(method, false);
          this.cache.failoverTriggeredAt.delete(method);
        }

        const recovery = await this.redisLock.get(
          `${this.R}recovery:${method}`,
        );
        this.cache.recoveryInProgress.set(method, recovery === '1');

        const lastFail = await this.redisLock.get(
          `${this.R}last_failure:${method}`,
        );
        if (lastFail) {
          this.cache.lastFailureAt.set(method, parseInt(lastFail, 10));
        }

        const lastSuccess = await this.redisLock.get(
          `${this.R}last_success:${method}`,
        );
        if (lastSuccess) {
          this.cache.lastSuccessAt.set(method, parseInt(lastSuccess, 10));
        }

        if (failover && !this.loggedFailoverStates.has(method)) {
          this.logger.warn(
            `Restored failover state for ${method} (triggered at ${new Date(parseInt(failover, 10)).toISOString()})`,
          );
          this.loggedFailoverStates.add(method);
        } else if (!failover) {
          this.loggedFailoverStates.delete(method);
        }
      } catch (err: any) {
        this.logger.error(
          `Error syncing health state for ${method}: ${err.message}`,
        );
      }
    }
  }

  async recordSuccess(method: string): Promise<void> {
    const key = method.toUpperCase();
    if (!this.FAILOVER_PAIRS[key]) return;

    if (this.redisLock.isAvailable()) {
      await this.redisLock.setWithTTL(
        `${this.R}failures:${key}`,
        '0',
        this.FAILURE_TTL,
      );
      await this.redisLock.setWithTTL(
        `${this.R}last_success:${key}`,
        String(Date.now()),
        this.TIMESTAMP_TTL,
      );
    }

    this.cache.failures.set(key, 0);
    this.cache.lastSuccessAt.set(key, Date.now());

    const recoveryFlag = this.redisLock.isAvailable()
      ? await this.redisLock.get(`${this.R}recovery:${key}`)
      : null;

    if (recoveryFlag === '1') {
      const lockId = `${this.R}recovery_lock:${key}`;
      const locked = await this.redisLock.acquireLock(lockId, this.LOCK_TTL);
      if (locked) {
        try {
          const stillRecovering = await this.redisLock.get(
            `${this.R}recovery:${key}`,
          );
          if (stillRecovering === '1') {
            await this.handleRecoverySuccess(key);
          }
        } finally {
          await this.redisLock.releaseLock(lockId);
        }
      }
    }
  }

  async recordFailure(method: string): Promise<void> {
    const failoverEnabled = await this.isFailoverEnabled();
    if (!failoverEnabled) return;

    const key = method.toUpperCase();
    if (!this.FAILOVER_PAIRS[key]) return;

    let failures: number;
    if (this.redisLock.isAvailable()) {
      failures = await this.redisLock.increment(
        `${this.R}failures:${key}`,
        this.FAILURE_TTL,
      );
      await this.redisLock.setWithTTL(
        `${this.R}last_failure:${key}`,
        String(Date.now()),
        this.TIMESTAMP_TTL,
      );
    } else {
      failures = (this.cache.failures.get(key) || 0) + 1;
    }

    this.cache.failures.set(key, failures);
    this.cache.lastFailureAt.set(key, Date.now());

    const threshold = await this.getFailoverThreshold();
    this.logger.warn(
      `Payment method ${key}: failure #${failures}/${threshold}`,
    );

    const recoveryFlag = this.redisLock.isAvailable()
      ? await this.redisLock.get(`${this.R}recovery:${key}`)
      : null;

    if (recoveryFlag === '1') {
      const lockId = `${this.R}recovery_lock:${key}`;
      const locked = await this.redisLock.acquireLock(lockId, this.LOCK_TTL);
      if (locked) {
        try {
          const stillRecovering = await this.redisLock.get(
            `${this.R}recovery:${key}`,
          );
          if (stillRecovering === '1') {
            this.logger.warn(
              `Recovery for ${key} failed — method still failing`,
            );
            await this.redisLock.delete(`${this.R}recovery:${key}`);
            this.cache.recoveryInProgress.set(key, false);

            await this.settingsService.setPaymentMethodEnabled(key, false);
            this.settingsService.clearSettingsCache();

            this.eventEmitter.emit('payment.failover.recovery_failed', {
              method: key,
              backup: this.FAILOVER_PAIRS[key],
              failures,
            });
          }
        } finally {
          await this.redisLock.releaseLock(lockId);
        }
      }
      return;
    }

    if (failures >= threshold) {
      const lockId = `${this.R}failover_lock:${key}`;
      const locked = await this.redisLock.acquireLock(lockId, this.LOCK_TTL);
      if (locked) {
        try {
          const alreadyActive = await this.redisLock.get(
            `${this.R}failover:${key}`,
          );
          if (!alreadyActive) {
            await this.triggerFailover(key);
          }
        } finally {
          await this.redisLock.releaseLock(lockId);
        }
      }
    }
  }

  private async triggerFailover(method: string): Promise<void> {
    const backup = this.FAILOVER_PAIRS[method];
    if (!backup) return;

    const now = Date.now();
    this.logger.error(`🚨 FAILOVER TRIGGERED: ${method} → ${backup}`);

    if (this.redisLock.isAvailable()) {
      await this.redisLock.setWithTTL(
        `${this.R}failover:${method}`,
        String(now),
        this.FAILOVER_TTL,
      );
    }

    this.cache.failoverActive.set(method, true);
    this.cache.failoverTriggeredAt.set(method, now);

    await this.settingsService.setPaymentMethodEnabled(method, false);
    await this.settingsService.setPaymentMethodEnabled(backup, true);
    this.settingsService.clearSettingsCache();

    const failures = this.cache.failures.get(method) || 0;
    const cooldown = await this.getFailoverCooldownMinutes();

    this.eventEmitter.emit('payment.failover.triggered', {
      method,
      backup,
      failures,
      cooldownMinutes: cooldown,
    });
  }

  private async attemptRecovery(method: string): Promise<void> {
    const autoRecovery = await this.isAutoRecoveryEnabled();
    if (!autoRecovery) return;

    const backup = this.FAILOVER_PAIRS[method];
    if (!backup) return;

    this.logger.log(`Attempting recovery for ${method}...`);

    if (this.redisLock.isAvailable()) {
      await this.redisLock.setWithTTL(`${this.R}recovery:${method}`, '1', 300);

      await this.redisLock.setWithTTL(
        `${this.R}failures:${method}`,
        '0',
        this.FAILURE_TTL,
      );
    }

    this.cache.recoveryInProgress.set(method, true);
    this.cache.failures.set(method, 0);

    await this.settingsService.setPaymentMethodEnabled(method, true);
    this.settingsService.clearSettingsCache();

    this.eventEmitter.emit('payment.failover.recovery_attempt', {
      method,
      backup,
    });
  }

  private async handleRecoverySuccess(method: string): Promise<void> {
    const backup = this.FAILOVER_PAIRS[method];

    this.logger.log(`✅ Recovery successful for ${method}!`);

    if (this.redisLock.isAvailable()) {
      await this.redisLock.delete(`${this.R}failover:${method}`);
      await this.redisLock.delete(`${this.R}recovery:${method}`);
    }

    this.cache.failoverActive.set(method, false);
    this.cache.recoveryInProgress.set(method, false);
    this.cache.failoverTriggeredAt.delete(method);

    if (backup) {
      await this.settingsService.setPaymentMethodEnabled(backup, false);
    }
    this.settingsService.clearSettingsCache();

    this.eventEmitter.emit('payment.failover.recovered', {
      method,
      backup,
    });
  }

  @Cron('0 */2 * * * *')
  async checkRecovery(): Promise<void> {
    const failoverEnabled = await this.isFailoverEnabled();
    if (!failoverEnabled) return;

    if (!this.redisLock.isAvailable()) return;

    const cronLockId = `${this.R}cron_recovery`;
    const locked = await this.redisLock.acquireLock(
      cronLockId,
      this.CRON_LOCK_TTL,
    );
    if (!locked) return;

    try {
      await this.syncCacheFromRedis();

      for (const method of Object.keys(this.FAILOVER_PAIRS)) {
        const failoverTs = await this.redisLock.get(
          `${this.R}failover:${method}`,
        );
        if (!failoverTs) continue;

        const recovering = await this.redisLock.get(
          `${this.R}recovery:${method}`,
        );
        if (recovering === '1') continue;

        const triggeredAt = parseInt(failoverTs, 10);
        const cooldownMinutes = await this.getFailoverCooldownMinutes();
        const cooldownMs = cooldownMinutes * 60 * 1000;
        const elapsed = Date.now() - triggeredAt;

        if (elapsed >= cooldownMs) {
          await this.attemptRecovery(method);
        }
      }
    } finally {
    }
  }

  @Cron('*/30 * * * * *')
  async periodicCacheSync(): Promise<void> {
    await this.syncCacheFromRedis();
  }

  getHealthStatus(method: string): MethodHealthStatus {
    const key = method.toUpperCase();
    const failures = this.cache.failures.get(key) || 0;
    const isFailover = this.cache.failoverActive.get(key) || false;

    return {
      method: key,
      healthy: failures === 0 && !isFailover,
      consecutiveFailures: failures,
      lastFailureAt: this.cache.lastFailureAt.has(key)
        ? new Date(this.cache.lastFailureAt.get(key)!)
        : null,
      lastSuccessAt: this.cache.lastSuccessAt.has(key)
        ? new Date(this.cache.lastSuccessAt.get(key)!)
        : null,
      failoverActive: isFailover,
      failoverTriggeredAt: this.cache.failoverTriggeredAt.has(key)
        ? new Date(this.cache.failoverTriggeredAt.get(key)!)
        : null,
      recoveryInProgress: this.cache.recoveryInProgress.get(key) || false,
    };
  }

  async manualFailover(method: string): Promise<boolean> {
    const key = method.toUpperCase();

    if (this.redisLock.isAvailable()) {
      const already = await this.redisLock.get(`${this.R}failover:${key}`);
      if (already) return false;
    }

    const lockId = `${this.R}failover_lock:${key}`;
    const locked = await this.redisLock.acquireLock(lockId, this.LOCK_TTL);
    if (!locked) return false;

    try {
      await this.triggerFailover(key);
      return true;
    } finally {
      await this.redisLock.releaseLock(lockId);
    }
  }

  async manualRecovery(method: string): Promise<boolean> {
    const key = method.toUpperCase();
    const backup = this.FAILOVER_PAIRS[key];

    if (this.redisLock.isAvailable()) {
      const active = await this.redisLock.get(`${this.R}failover:${key}`);
      if (!active) return false;
    }

    const lockId = `${this.R}recovery_lock:${key}`;
    const locked = await this.redisLock.acquireLock(lockId, this.LOCK_TTL);
    if (!locked) return false;

    try {
      if (this.redisLock.isAvailable()) {
        await this.redisLock.delete(`${this.R}failover:${key}`);
        await this.redisLock.delete(`${this.R}recovery:${key}`);
        await this.redisLock.setWithTTL(
          `${this.R}failures:${key}`,
          '0',
          this.FAILURE_TTL,
        );
      }

      this.cache.failoverActive.set(key, false);
      this.cache.recoveryInProgress.set(key, false);
      this.cache.failoverTriggeredAt.delete(key);
      this.cache.failures.set(key, 0);

      await this.settingsService.setPaymentMethodEnabled(key, true);
      if (backup) {
        await this.settingsService.setPaymentMethodEnabled(backup, false);
      }
      this.settingsService.clearSettingsCache();

      this.eventEmitter.emit('payment.failover.manual_recovery', {
        method: key,
        backup,
      });

      return true;
    } finally {
      await this.redisLock.releaseLock(lockId);
    }
  }

  async isFailoverEnabled(): Promise<boolean> {
    const value = await this.settingsService.getSetting('failover_enabled');
    return value !== 'false';
  }

  async getFailoverThreshold(): Promise<number> {
    const value = await this.settingsService.getSetting('failover_threshold');
    return parseInt(value || '3', 10);
  }

  async getFailoverCooldownMinutes(): Promise<number> {
    const value = await this.settingsService.getSetting(
      'failover_cooldown_minutes',
    );
    return parseInt(value || '5', 10);
  }

  async isAutoRecoveryEnabled(): Promise<boolean> {
    const value = await this.settingsService.getSetting(
      'failover_auto_recovery',
    );
    return value !== 'false';
  }

  async setFailoverEnabled(enabled: boolean): Promise<void> {
    await this.settingsService.setSetting('failover_enabled', String(enabled));
  }

  async setFailoverThreshold(threshold: number): Promise<void> {
    await this.settingsService.setSetting(
      'failover_threshold',
      String(threshold),
    );
  }

  async setFailoverCooldownMinutes(minutes: number): Promise<void> {
    await this.settingsService.setSetting(
      'failover_cooldown_minutes',
      String(minutes),
    );
  }

  async setAutoRecoveryEnabled(enabled: boolean): Promise<void> {
    await this.settingsService.setSetting(
      'failover_auto_recovery',
      String(enabled),
    );
  }
}
