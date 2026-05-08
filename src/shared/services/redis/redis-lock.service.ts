import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private client: RedisClientType | null = null;
  private isConnected = false;

  private readonly instanceId = `instance-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  private readonly LOCK_PREFIX = 'lock:';
  private readonly TX_HASH_PREFIX = 'txhash:';
  private readonly TX_HASH_TTL = 86400;
  private readonly SALES_NOTIFICATION_PREFIX = 'sales_notification:';
  private readonly SALES_NOTIFICATION_TTL = 3600;
  private readonly INSUFFICIENT_FUNDS_PREFIX = 'insufficient_funds:';
  private readonly INSUFFICIENT_FUNDS_TTL = 300;

  private readonly QUEUE_PROCESSING_PREFIX = 'queue_processing:';

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    const redisPassword = process.env.REDIS_PASSWORD;
    const redisDb = process.env.REDIS_DB
      ? parseInt(process.env.REDIS_DB, 10)
      : 0;

    if (!redisUrl) {
      this.logger.warn(
        'REDIS_URL not configured, distributed locks will be disabled',
      );
      return;
    }

    try {
      let fullRedisUrl = redisUrl;
      if (redisPassword) {
        try {
          const url = new URL(redisUrl);
          url.password = redisPassword;
          url.pathname = `/${redisDb}`;
          fullRedisUrl = url.toString();
        } catch {
          const stripped = redisUrl.replace('redis://', '');
          const [host, port] = stripped.split(':');
          fullRedisUrl = `redis://:${redisPassword}@${host || 'localhost'}:${port || '6379'}/${redisDb}`;
        }
      }

      this.client = createClient({ url: fullRedisUrl });

      this.client.on('error', (err) => {
        this.logger.error(`Redis client error: ${err.message}`);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        this.logger.log('Redis connected for distributed locks');
        this.isConnected = true;
      });

      this.client.on('reconnecting', () => {
        this.logger.warn('Redis reconnecting...');
      });

      await this.client.connect();
      this.isConnected = true;
      this.logger.log(
        `Redis lock service initialized (instance: ${this.instanceId.slice(0, 20)}...)`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to connect to Redis: ${error.message}`);
      this.client = null;
      this.isConnected = false;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      this.isConnected = false;
      const clientToClose = this.client;
      this.client = null;
      try {
        await clientToClose.quit();
        this.logger.log('Redis disconnected');
      } catch (error: any) {
        this.logger.error(`Error disconnecting Redis: ${error.message}`);
      }
    }
  }

  isAvailable(): boolean {
    return this.isConnected && this.client !== null;
  }

  async acquireLock(lockId: string, ttlSeconds: number = 60): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.LOCK_PREFIX + lockId;

      const result = await this.client.set(key, this.instanceId, {
        NX: true,
        EX: ttlSeconds,
      });

      if (result === 'OK') {
        return true;
      }

      const currentOwner = await this.client.get(key);
      if (currentOwner === this.instanceId) {
        await this.client.expire(key, ttlSeconds);
        return true;
      }

      return false;
    } catch (error: any) {
      this.logger.error(`Error acquiring lock ${lockId}: ${error.message}`);
      return false;
    }
  }

  async releaseLock(lockId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.LOCK_PREFIX + lockId;

      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.client.eval(script, {
        keys: [key],
        arguments: [this.instanceId],
      });

      return result === 1;
    } catch (error: any) {
      this.logger.error(`Error releasing lock ${lockId}: ${error.message}`);
      return false;
    }
  }

  async forceReleaseLock(lockId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.LOCK_PREFIX + lockId;
      const result = await this.client.del(key);
      if (result > 0) {
        this.logger.log(`Force released lock ${lockId}`);
      }
      return result > 0;
    } catch (error: any) {
      this.logger.error(
        `Error force releasing lock ${lockId}: ${error.message}`,
      );
      return false;
    }
  }

  async extendLock(lockId: string, ttlSeconds: number = 60): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.LOCK_PREFIX + lockId;

      const currentOwner = await this.client.get(key);
      if (currentOwner !== this.instanceId) {
        return false;
      }

      await this.client.expire(key, ttlSeconds);
      return true;
    } catch (error: any) {
      this.logger.error(`Error extending lock ${lockId}: ${error.message}`);
      return false;
    }
  }

  async withLock<T>(
    lockId: string,
    fn: () => Promise<T>,
    options: {
      ttlSeconds?: number;
      waitMs?: number;
      maxAttempts?: number;
    } = {},
  ): Promise<T | null> {
    const { ttlSeconds = 60, waitMs = 100, maxAttempts = 1 } = options;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acquired = await this.acquireLock(lockId, ttlSeconds);

      if (acquired) {
        try {
          return await fn();
        } finally {
          await this.releaseLock(lockId);
        }
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    return null;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  async markTxHashAsUsed(txHash: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.TX_HASH_PREFIX + txHash;
      await this.client.set(key, '1', { EX: this.TX_HASH_TTL });
      return true;
    } catch (error: any) {
      this.logger.error(`Error marking txHash as used: ${error.message}`);
      return false;
    }
  }

  async isTxHashUsed(txHash: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.TX_HASH_PREFIX + txHash;
      const result = await this.client.get(key);
      return result !== null;
    } catch (error: any) {
      this.logger.error(`Error checking txHash: ${error.message}`);
      return false;
    }
  }

  async markTxHashAsUsedWithNX(txHash: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.TX_HASH_PREFIX + txHash;
      const result = await this.client.set(key, '1', {
        NX: true,
        EX: this.TX_HASH_TTL,
      });
      return result === 'OK';
    } catch (error: any) {
      this.logger.error(`Error marking txHash with NX: ${error.message}`);
      return false;
    }
  }

  async setWithTTL(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      await this.client.set(key, value, { EX: ttlSeconds });
      return true;
    } catch (error: any) {
      this.logger.error(`Error setting key ${key}: ${error.message}`);
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const result = await this.client.get(key);
      if (typeof result === 'string') {
        return result;
      }
      return null;
    } catch (error: any) {
      this.logger.error(`Error getting key ${key}: ${error.message}`);
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error: any) {
      this.logger.error(`Error deleting key ${key}: ${error.message}`);
      return false;
    }
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    if (!this.client || !this.isConnected) {
      return 0;
    }

    try {
      const result = await this.client.incr(key);
      if (ttlSeconds && result === 1) {
        await this.client.expire(key, ttlSeconds);
      }
      return result;
    } catch (error: any) {
      this.logger.error(`Error incrementing key ${key}: ${error.message}`);
      return 0;
    }
  }

  async markSalesNotificationSent(paymentId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.SALES_NOTIFICATION_PREFIX + paymentId;
      const result = await this.client.set(key, '1', {
        NX: true,
        EX: this.SALES_NOTIFICATION_TTL,
      });
      return result === 'OK';
    } catch (error: any) {
      this.logger.error(
        `Error marking sales notification as sent: ${error.message}`,
      );
      return false;
    }
  }

  async tryClaimSalesNotification(paymentId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return true;
    }

    return this.markSalesNotificationSent(paymentId);
  }

  async isSalesNotificationSent(paymentId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.SALES_NOTIFICATION_PREFIX + paymentId;
      const result = await this.client.get(key);
      return result !== null;
    } catch (error: any) {
      this.logger.error(`Error checking sales notification: ${error.message}`);
      return false;
    }
  }

  async markInsufficientFundsNotificationSent(
    orderIds: string[],
  ): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const sortedIds = [...orderIds].sort().join(',');
      const key = this.INSUFFICIENT_FUNDS_PREFIX + sortedIds;
      const result = await this.client.set(key, '1', {
        NX: true,
        EX: this.INSUFFICIENT_FUNDS_TTL,
      });
      return result === 'OK';
    } catch (error: any) {
      this.logger.error(
        `Error marking insufficient funds notification as sent: ${error.message}`,
      );
      return false;
    }
  }

  async isInsufficientFundsNotificationSent(
    orderIds: string[],
  ): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const sortedIds = [...orderIds].sort().join(',');
      const key = this.INSUFFICIENT_FUNDS_PREFIX + sortedIds;
      const result = await this.client.get(key);
      return result !== null;
    } catch (error: any) {
      this.logger.error(
        `Error checking insufficient funds notification: ${error.message}`,
      );
      return false;
    }
  }

  async setNX(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.set(key, value, {
        NX: true,
        EX: ttlSeconds,
      });
      return result === 'OK';
    } catch (error: any) {
      this.logger.error(`Error in setNX for key ${key}: ${error.message}`);
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error: any) {
      this.logger.error(
        `Error checking key existence ${key}: ${error.message}`,
      );
      return false;
    }
  }

  async markQueueItemCompleted(
    queueItemId: string,
    txHash: string,
  ): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.QUEUE_PROCESSING_PREFIX + 'completed:' + queueItemId;
      await this.client.set(key, txHash, { EX: 86400 });
      return true;
    } catch (error: any) {
      this.logger.error(
        `Error marking queue item completed ${queueItemId}: ${error.message}`,
      );
      return false;
    }
  }

  async isQueueItemCompleted(queueItemId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.QUEUE_PROCESSING_PREFIX + 'completed:' + queueItemId;
      const result = await this.client.get(key);
      return result !== null;
    } catch (error: any) {
      this.logger.error(
        `Error checking queue item completed ${queueItemId}: ${error.message}`,
      );
      return false;
    }
  }

  async getQueueItemCompletedTxHash(
    queueItemId: string,
  ): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const key = this.QUEUE_PROCESSING_PREFIX + 'completed:' + queueItemId;
      const result = await this.client.get(key);
      return typeof result === 'string' ? result : null;
    } catch (error: any) {
      this.logger.error(
        `Error getting queue item tx_hash ${queueItemId}: ${error.message}`,
      );
      return null;
    }
  }

  private readonly SENT_COMMENT_PREFIX = 'sent_ton_comment:';
  private readonly SENT_COMMENT_TTL = 86400 * 3;

  async markTonCommentSent(comment: string, orderId: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = this.SENT_COMMENT_PREFIX + comment;
      await this.client.set(key, orderId, { EX: this.SENT_COMMENT_TTL });
      return true;
    } catch (error: any) {
      this.logger.error(`Error marking ton comment as sent: ${error.message}`);
      return false;
    }
  }

  async getTonCommentSentBy(comment: string): Promise<string | null> {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const key = this.SENT_COMMENT_PREFIX + comment;
      const result = await this.client.get(key);
      return typeof result === 'string' ? result : null;
    } catch (error: any) {
      this.logger.error(`Error checking ton comment sent: ${error.message}`);
      return null;
    }
  }

  private readonly IMAGE_FILE_ID_PREFIX = 'img_fid:';
  private readonly IMAGE_FILE_ID_TTL = 86400 * 30;

  /**
   * Ключ кеша включает mtime/size файла: после замены картинки на том же пути Redis не отдаёт старый Telegram file_id.
   */
  private buildImageFileIdStorageKey(imagePath: string): string {
    const relative = imagePath.startsWith('./')
      ? imagePath.slice(2)
      : imagePath;
    const resolved = path.join(process.cwd(), relative);
    try {
      const st = fs.statSync(resolved);
      return `${imagePath}#${st.mtimeMs}#${st.size}`;
    } catch {
      return imagePath;
    }
  }

  async getImageFileId(imagePath: string): Promise<string | null> {
    return this.get(
      this.IMAGE_FILE_ID_PREFIX + this.buildImageFileIdStorageKey(imagePath),
    );
  }

  async setImageFileId(imagePath: string, fileId: string): Promise<boolean> {
    return this.setWithTTL(
      this.IMAGE_FILE_ID_PREFIX + this.buildImageFileIdStorageKey(imagePath),
      fileId,
      this.IMAGE_FILE_ID_TTL,
    );
  }

  /** Сбросить закешированный Telegram file_id (например после ошибки «wrong file»). */
  async deleteImageFileId(imagePath: string): Promise<void> {
    await this.delete(
      this.IMAGE_FILE_ID_PREFIX + this.buildImageFileIdStorageKey(imagePath),
    );
  }
}
