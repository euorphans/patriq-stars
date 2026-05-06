import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { FragmentService } from '@/shared/services/fragment/fragment.service';
import { FragmentAccountService } from '@/shared/services/fragment/fragment-account.service';
import { TonWalletService } from '@/shared/services/ton-wallet/ton-wallet.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { SettingsService } from '@/modules/settings/settings.service';
import { EventLoopMonitorService } from '@/modules/health/event-loop-monitor.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { MainKeyboard } from '@/shared/keyboards/main.keyboard';

interface FragmentQueueItem {
  id: string;
  user_id: string;
  user_telegram_id: string;
  payment_id: string | null;
  username: string;
  stars: number | null;
  ton: number | null;
  premium: number | null;
  is_anon: boolean;
  order_number?: number;
  payment_message_id?: string;
  preCheckPassed?: boolean;
}

interface TransactionToSend {
  destination: string;
  amount: number;
  comment: string;
  order_id: string;
  type: string;
  user_id: string;
  amount_value: number;
  validUntil?: number;
}

@Injectable()
export class FragmentQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FragmentQueueService.name);
  private processingTimeout: NodeJS.Timeout | null = null;

  /** Timeouts for on-chain re-check after batch send when Toncenter v3 lags */
  private postSendChainVerifyTimeouts: NodeJS.Timeout[] = [];

  private isProcessingQueue = false;
  private isRecovering = false;
  private isRetryingFailed = false;

  private isWalletLeader = false;
  private walletLeaderInterval: NodeJS.Timeout | null = null;
  private readonly WALLET_LEADER_LOCK_ID = 'wallet-leader';
  private readonly WALLET_LEADER_TTL_SECONDS = 30;
  private readonly WALLET_LEADER_RENEW_INTERVAL_MS = 10_000;

  private readonly STUCK_PROCESSING_TIMEOUT_MS = 90 * 1000;
  private readonly INDEXING_BUFFER_SECONDS = 600;
  /** When lite server never accepted a send (`outbound_submitted_at` null), do not wait full indexer tail. */
  private readonly INDEXING_BUFFER_SHORT_SECONDS = 150;
  private readonly REQUIRED_BLOCKCHAIN_MISSES = 3;
  private readonly FAILED_RETRY_DELAY_MS = 10 * 1000;
  private readonly FAILED_MAX_AGE_MS = 60 * 60 * 1000;
  private readonly BATCH_SIZE = 80;
  private readonly LOCK_TTL_SECONDS = 60;
  private readonly MAX_CONCURRENT_PREPARATIONS = 40;
  private readonly MAX_CYCLE_ITEMS = 5000;
  private readonly MAX_CYCLE_TIME_MS = 4 * 60 * 1000;

  private readonly ACCUMULATION_DELAY_MS = 120;
  private readonly MIN_BATCH_SIZE = 1;
  private readonly MAX_ACCUMULATION_WAIT_MS = 2_000;
  private triggeredByEvent = false;
  private readonly MIN_WALLET_BALANCE_TON = 0.1;

  private lastKnownInsufficientBalance = 0;
  private insufficientBalanceUntil = 0;
  private readonly INSUFFICIENT_BALANCE_COOLDOWN_MS = 45_000;

  private lastInsufficientFundsNotifyTime = 0;
  private readonly INSUFFICIENT_FUNDS_NOTIFY_COOLDOWN_MS = 60_000;

  private readonly RECOVERY_LOCK_ID = 'fragment-queue-recovery';
  private readonly FAILED_RETRY_LOCK_ID = 'fragment-queue-failed-retry';

  private readonly FRAGMENT_WALLET_ADDRESS =
    'UQCFJEP4WZ_mpdo0_kMEmsTgvrMHG7K_tWY16pQhKHwoOtFz';

  constructor(
    private readonly prisma: PrismaService,
    private readonly fragmentService: FragmentService,
    private readonly fragmentAccountService: FragmentAccountService,
    private readonly tonWalletService: TonWalletService,
    private readonly redisLock: RedisLockService,
    private readonly settingsService: SettingsService,
    private readonly eventLoopMonitor: EventLoopMonitorService,
    @InjectBot() private readonly bot: Telegraf,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  async onModuleInit() {
    await this.tryBecomeWalletLeader();

    if (!this.isWalletLeader) {
      const RETRY_INTERVAL_MS = 2000;
      const MAX_RETRIES = 20;
      for (let i = 0; i < MAX_RETRIES && !this.isWalletLeader; i++) {
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
        await this.tryBecomeWalletLeader();
      }
      if (this.isWalletLeader) {
        this.logger.log('Acquired wallet leadership during startup retry loop');
      } else {
        this.logger.warn(
          'Could not acquire wallet leadership during startup, will keep trying via heartbeat',
        );
      }
    }

    this.walletLeaderInterval = setInterval(
      () => this.walletLeaderHeartbeat(),
      this.WALLET_LEADER_RENEW_INTERVAL_MS,
    );

    if (this.isWalletLeader) {
      setTimeout(() => {
        this.logger.log(
          '[FragmentQueueService] Startup: scheduling initial queue processing',
        );
        this.scheduleImmediateProcessing();
      }, 5_000);
    }
  }

  private async tryBecomeWalletLeader(): Promise<void> {
    const acquired = await this.redisLock.acquireLock(
      this.WALLET_LEADER_LOCK_ID,
      this.WALLET_LEADER_TTL_SECONDS,
    );

    if (acquired) {
      if (!this.isWalletLeader) {
        this.isWalletLeader = true;
        this.logger.log(
          `This instance is now the WALLET LEADER (${this.redisLock.getInstanceId()})`,
        );
      }
    } else if (this.isWalletLeader) {
      this.isWalletLeader = false;
      this.logger.warn('Lost wallet leadership');
    }
  }

  private async walletLeaderHeartbeat(): Promise<void> {
    if (this.isWalletLeader) {
      const renewed = await this.redisLock.extendLock(
        this.WALLET_LEADER_LOCK_ID,
        this.WALLET_LEADER_TTL_SECONDS,
      );
      if (!renewed) {
        this.logger.warn(
          'Failed to renew wallet leader lock, trying to re-acquire',
        );
        this.isWalletLeader = false;
        await this.tryBecomeWalletLeader();
      }
    } else {
      await this.tryBecomeWalletLeader();
    }
  }

  async onModuleDestroy() {
    for (const t of this.postSendChainVerifyTimeouts) {
      clearTimeout(t);
    }
    this.postSendChainVerifyTimeouts = [];

    if (this.walletLeaderInterval) {
      clearInterval(this.walletLeaderInterval);
      this.walletLeaderInterval = null;
    }
    if (this.isWalletLeader) {
      await this.redisLock.releaseLock(this.WALLET_LEADER_LOCK_ID);
      this.isWalletLeader = false;
      this.logger.log('Released wallet leader lock on shutdown');
    }
  }

  async retryQueueItemForPaymentId(
    paymentId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const item = await this.prisma.fragmentQueue.findFirst({
        where: {
          payment_id: paymentId,
          status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
        include: {
          payment: {
            select: {
              order_number: true,
            },
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
        return {
          success: false,
          message: 'Заказ уже был обработан',
        };
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
    } catch (error: any) {
      this.logger.error(
        `Retry queue item for payment ${paymentId}: ${error.message}`,
      );
      return {
        success: false,
        message: `Ошибка: ${error.message}`,
      };
    }
  }

  @OnEvent('payment.completed')
  async handlePaymentCompleted(_payment: any): Promise<void> {
    this.scheduleImmediateProcessing();
  }

  async processQueueNow(): Promise<void> {
    await this.processQueue();
  }

  private scheduleImmediateProcessing(): void {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
    }

    this.triggeredByEvent = true;
    this.processingTimeout = setTimeout(() => {
      this.triggeredByEvent = true;
      this.processQueueNow();
    }, this.ACCUMULATION_DELAY_MS);
  }

  private async acquireLock(lockId: string): Promise<boolean> {
    if (this.redisLock.isAvailable()) {
      return await this.redisLock.acquireLock(lockId, this.LOCK_TTL_SECONDS);
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

  private async runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number,
  ): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= tasks.length) return;
        try {
          results[index] = {
            status: 'fulfilled',
            value: await tasks[index](),
          };
        } catch (reason: any) {
          results[index] = { status: 'rejected', reason };
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () =>
        worker(),
      ),
    );

    return results;
  }

  @Cron('*/15 * * * * *')
  async recoverStuckProcessingItems(): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }

    if (this.isRecovering) {
      return;
    }

    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }

    if (!(await this.acquireLock(this.RECOVERY_LOCK_ID))) {
      return;
    }

    this.isRecovering = true;

    try {
      const stuckThreshold = new Date(
        Date.now() - this.STUCK_PROCESSING_TIMEOUT_MS,
      );

      const processingCount = await this.prisma.fragmentQueue.count({
        where: { status: 'PROCESSING' },
      });
      if (processingCount > 0) {
        this.logger.log(
          `recoverStuck tick: ${processingCount} PROCESSING item(s) total`,
        );
      }

      const stuckItems = await this.prisma.fragmentQueue.findMany({
        where: {
          status: 'PROCESSING',
          updated_at: { lt: stuckThreshold },
          tx_hash: null,
        },
        take: 100,
        select: {
          id: true,
          user_id: true,
          payment_id: true,
          username: true,
          stars: true,
          ton: true,
          premium: true,
          is_anon: true,
          retry_count: true,
          ton_comment: true,
          user: {
            select: {
              telegram_id: true,
            },
          },
        },
      });

      if (stuckItems.length === 0) {
        return;
      }

      this.logger.log(
        `Recovery: found ${stuckItems.length} stuck PROCESSING items (without tx_hash), recovering...`,
      );

      const itemsNeedingBlockchainCheck: typeof stuckItems = [];
      const itemsWithoutComment: typeof stuckItems = [];

      for (const item of stuckItems) {
        const cachedTxHash = await this.redisLock.getQueueItemCompletedTxHash(
          item.id,
        );
        if (cachedTxHash) {
          this.logger.log(
            `Recovery: Item ${item.id} found completed in Redis (tx_hash ${cachedTxHash}), marking COMPLETED`,
          );

          await this.prisma.fragmentQueue.update({
            where: { id: item.id },
            data: {
              status: 'COMPLETED',
              tx_hash: cachedTxHash,
              outbound_submitted_at: null,
              external_out_msg_hash: null,
              updated_at: new Date(),
            },
          });
          continue;
        }

        if (item.ton_comment) {
          itemsNeedingBlockchainCheck.push(item);
        } else {
          itemsWithoutComment.push(item);
        }
      }

      if (itemsNeedingBlockchainCheck.length > 0) {
        let batchResults = new Map<
          string,
          { txHash: string; timestamp: number }
        >();
        let blockchainCheckSucceeded = false;
        let blockchainCheckExhaustive = false;

        try {
          const commentsToCheck = itemsNeedingBlockchainCheck.map((item) => ({
            orderId: item.id,
            comment: item.ton_comment!,
          }));

          const batchCheck =
            await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
          batchResults = batchCheck.results;
          blockchainCheckExhaustive = batchCheck.exhaustive;
          blockchainCheckSucceeded = true;

          this.logger.log(
            `Recovery batch blockchain check: ${batchResults.size}/${itemsNeedingBlockchainCheck.length} found on-chain` +
              ` (exhaustive: ${blockchainCheckExhaustive})`,
          );
        } catch (error: any) {
          this.logger.error(
            `Recovery batch blockchain check failed: ${error.message}. ` +
              `Will NOT reset items to prevent potential double-send.`,
          );
        }

        for (const item of itemsNeedingBlockchainCheck) {
          const found = batchResults.get(item.id);

          if (found) {
            this.logger.log(
              `Recovery: Item ${item.id} found in blockchain (tx_hash ${found.txHash}), marking COMPLETED`,
            );

            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: {
                status: 'COMPLETED',
                tx_hash: found.txHash,
                blockchain_miss_count: 0,
                updated_at: new Date(),
              },
            });

            await this.redisLock.markQueueItemCompleted(item.id, found.txHash);
            continue;
          }

          if (!blockchainCheckSucceeded || !blockchainCheckExhaustive) {
            this.logger.warn(
              `Item ${item.id}: Skipping reset — blockchain check ${!blockchainCheckSucceeded ? 'failed' : 'was INCOMPLETE (partial scan)'}, ` +
                `cannot confirm transaction absence. Will retry next cycle.`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: { updated_at: new Date() },
            });
            continue;
          }

          const fullItem = await this.prisma.fragmentQueue.findUnique({
            where: { id: item.id },
            select: {
              valid_until: true,
              updated_at: true,
              outbound_submitted_at: true,
              ton_comment: true,
              ton_amount: true,
              prev_ton_comments: true,
              blockchain_miss_count: true,
            },
          });

          const now = Math.floor(Date.now() / 1000);
          const indexingBufferSec = fullItem?.outbound_submitted_at
            ? this.INDEXING_BUFFER_SECONDS
            : this.INDEXING_BUFFER_SHORT_SECONDS;

          if (fullItem?.valid_until) {
            if (now < fullItem.valid_until + indexingBufferSec) {
              this.logger.warn(
                `Item ${item.id}: exhaustive check says not on chain, but valid_until still within indexing buffer ` +
                  `(${fullItem.valid_until - now + indexingBufferSec}s remaining, ` +
                  `buffer=${indexingBufferSec}s). Keeping PROCESSING.`,
              );
              continue;
            }
          } else {
            const updatedAtUnix = Math.floor(
              (fullItem?.updated_at?.getTime() ?? Date.now()) / 1000,
            );
            if (now - updatedAtUnix < indexingBufferSec) {
              this.logger.warn(
                `Item ${item.id}: exhaustive check says not on chain, but updated_at within indexing buffer ` +
                  `(${indexingBufferSec - (now - updatedAtUnix)}s remaining, ` +
                  `buffer=${indexingBufferSec}s). Keeping PROCESSING.`,
              );
              continue;
            }
          }

          const currentMissCount = (fullItem?.blockchain_miss_count ?? 0) + 1;

          if (currentMissCount < this.REQUIRED_BLOCKCHAIN_MISSES) {
            this.logger.warn(
              `Item ${item.id}: exhaustive check says not on chain, but only ${currentMissCount}/${this.REQUIRED_BLOCKCHAIN_MISSES} consecutive misses. ` +
                `Incrementing blockchain_miss_count and keeping PROCESSING.`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: {
                blockchain_miss_count: currentMissCount,
                updated_at: new Date(),
              },
            });
            continue;
          }

          const prevComments = fullItem?.prev_ton_comments || [];
          const updatedPrevComments = fullItem?.ton_comment
            ? [...prevComments, fullItem.ton_comment]
            : prevComments;

          this.logger.log(
            `Item ${item.id}: exhaustive blockchain check confirmed tx NOT on chain ` +
              `(${currentMissCount}/${this.REQUIRED_BLOCKCHAIN_MISSES} consecutive misses, indexing buffer passed). ` +
              `Recycling: ton_comment → prev_ton_comments (count: ${updatedPrevComments.length}), status → PENDING.`,
          );
          await this.prisma.fragmentQueue.update({
            where: { id: item.id },
            data: {
              status: 'PENDING',
              ton_comment: null,
              ton_amount: null,
              valid_until: null,
              prev_ton_comments: updatedPrevComments,
              blockchain_miss_count: 0,
              outbound_submitted_at: null,
              external_out_msg_hash: null,
              updated_at: new Date(),
            },
          });
        }
      }

      for (const item of itemsWithoutComment) {
        const itemLockId = `fragment-queue-item-${item.id}`;
        const lockAcquired = await this.acquireLock(itemLockId);

        if (!lockAcquired) {
          this.logger.warn(
            `Skip recovery for item ${item.id} - already locked by another process`,
          );
          continue;
        }

        try {
          const currentItem = await this.prisma.fragmentQueue.findUnique({
            where: { id: item.id },
            select: {
              status: true,
              tx_hash: true,
              ton_comment: true,
              ton_amount: true,
            },
          });

          if (
            !currentItem ||
            currentItem.status !== 'PROCESSING' ||
            currentItem.tx_hash
          ) {
            this.logger.warn(
              `Skip recovery for item ${item.id} - status=${currentItem?.status}, tx_hash=${currentItem?.tx_hash || 'null'}`,
            );
            if (currentItem?.tx_hash) {
              await this.redisLock.markQueueItemCompleted(
                item.id,
                currentItem.tx_hash,
              );
            }
            continue;
          }

          if (currentItem.ton_comment && currentItem.ton_amount) {
            this.logger.log(
              `Skip recovery for item ${item.id} - transaction data appeared since initial query (ton_comment set). Will be handled by ton_comment recovery path on next cycle.`,
            );
            continue;
          }

          const currentRetry = item.retry_count || 0;
          const MAX_RETRIES = 5;

          if (currentRetry >= MAX_RETRIES) {
            const failedUpdate = await this.prisma.fragmentQueue.updateMany({
              where: {
                id: item.id,
                status: 'PROCESSING',
                tx_hash: null,
                ton_comment: null,
              },
              data: { status: 'FAILED', updated_at: new Date() },
            });
            if (failedUpdate.count > 0) {
              this.logger.error(
                `Queue item ${item.id} marked as FAILED after max retries during recovery`,
              );
              await this.queueErrorNotification(item);
            } else {
              this.logger.warn(
                `Queue item ${item.id} was modified during recovery FAILED attempt, skipping`,
              );
            }
          } else {
            const resetUpdate = await this.prisma.fragmentQueue.updateMany({
              where: {
                id: item.id,
                status: 'PROCESSING',
                tx_hash: null,
                ton_comment: null,
              },
              data: {
                status: 'PENDING',
                retry_count: currentRetry + 1,
                outbound_submitted_at: null,
                external_out_msg_hash: null,
                updated_at: new Date(),
              },
            });

            if (resetUpdate.count > 0) {
              this.logger.log(
                `Recovered stuck item ${item.id}, retry ${currentRetry + 1}/${MAX_RETRIES}`,
              );
            } else {
              this.logger.warn(
                `Queue item ${item.id} was modified during recovery PENDING reset, skipping`,
              );
            }
          }
        } finally {
          await this.releaseLock(itemLockId);
        }
      }
    } catch (error: any) {
      this.logger.error(`Error recovering stuck items: ${error.message}`);
    } finally {
      this.isRecovering = false;
      await this.releaseLock(this.RECOVERY_LOCK_ID);

      this.scheduleImmediateProcessing();
    }
  }

  @Cron('*/30 * * * * *')
  async retryFailedItems(): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }

    if (this.isRetryingFailed) {
      return;
    }

    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }

    if (!(await this.acquireLock(this.FAILED_RETRY_LOCK_ID))) {
      return;
    }

    this.isRetryingFailed = true;

    try {
      const MAX_RETRIES = 5;
      const retryThreshold = new Date(Date.now() - this.FAILED_RETRY_DELAY_MS);
      const maxAgeThreshold = new Date(Date.now() - this.FAILED_MAX_AGE_MS);

      const failedItems = await this.prisma.fragmentQueue.findMany({
        where: {
          status: 'FAILED',
          updated_at: {
            lt: retryThreshold,
            gt: maxAgeThreshold,
          },
          retry_count: { lt: MAX_RETRIES },
        },
        take: 50,
        select: {
          id: true,
          user_id: true,
          payment_id: true,
          username: true,
          stars: true,
          ton: true,
          premium: true,
          is_anon: true,
          retry_count: true,
          ton_comment: true,
          prev_ton_comments: true,
          tx_hash: true,
          user: {
            select: {
              telegram_id: true,
            },
          },
          payment: {
            select: {
              order_number: true,
            },
          },
        },
      });

      if (failedItems.length === 0) {
        return;
      }

      this.logger.log(
        `Found ${failedItems.length} FAILED items eligible for retry`,
      );

      for (const item of failedItems) {
        if (!item.username || item.username.trim() === '') {
          this.logger.debug(
            `Skipping retry for item ${item.id} - empty username`,
          );
          continue;
        }

        if (item.tx_hash) {
          this.logger.warn(
            `FAILED item ${item.id} has tx_hash ${item.tx_hash}, marking as COMPLETED`,
          );
          await this.prisma.fragmentQueue.update({
            where: { id: item.id },
            data: { status: 'COMPLETED', updated_at: new Date() },
          });
          continue;
        }

        const allComments: string[] = [
          ...(item.ton_comment ? [item.ton_comment] : []),
          ...(item.prev_ton_comments || []),
        ];

        if (allComments.length > 0) {
          try {
            const commentsToCheck = allComments.map((c) => ({
              orderId: item.id,
              comment: c,
            }));
            const batchCheck =
              await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
            const found = batchCheck.results.get(item.id);
            if (found && found.txHash) {
              this.logger.warn(
                `DUPLICATE PREVENTED: FAILED item ${item.id} already in blockchain with tx_hash ${found.txHash} ` +
                  `(checked ${allComments.length} comments incl. prev_ton_comments), marking as COMPLETED`,
              );
              await this.prisma.fragmentQueue.update({
                where: { id: item.id },
                data: {
                  status: 'COMPLETED',
                  tx_hash: found.txHash,
                  updated_at: new Date(),
                },
              });
              await this.redisLock.markQueueItemCompleted(
                item.id,
                found.txHash,
              );
              continue;
            }
            if (!batchCheck.exhaustive) {
              this.logger.warn(
                `FAILED item ${item.id}: blockchain check INCOMPLETE — cannot confirm absence. Skipping retry to prevent double-send.`,
              );
              continue;
            }
          } catch (error: any) {
            this.logger.error(
              `Blockchain check failed for FAILED item ${item.id}: ${error.message}. ` +
                `Will NOT retry to prevent potential double-send.`,
            );

            continue;
          }
        }

        const currentRetry = item.retry_count || 0;

        const retryPrevComments = item.prev_ton_comments || [];
        if (item.ton_comment) {
          retryPrevComments.push(item.ton_comment);
        }

        await this.prisma.fragmentQueue.update({
          where: { id: item.id },
          data: {
            status: 'PENDING',
            retry_count: currentRetry + 1,
            ton_comment: null,
            ton_amount: null,
            valid_until: null,
            prev_ton_comments: retryPrevComments,
            outbound_submitted_at: null,
            external_out_msg_hash: null,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `Retrying FAILED item ${item.id} (order #${item.payment?.order_number || '?'}), attempt ${currentRetry + 1}/${MAX_RETRIES}` +
            `${item.ton_comment ? ` (archived ton_comment to prev, total: ${retryPrevComments.length})` : ''}`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Error retrying failed items: ${error.message}`);
    } finally {
      this.isRetryingFailed = false;
      await this.releaseLock(this.FAILED_RETRY_LOCK_ID);

      this.scheduleImmediateProcessing();
    }
  }

  @Cron('*/3 * * * * *')
  async processQueue(): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }

    if (this.isProcessingQueue) {
      this.logger.debug('processQueue skipped: already processing');
      return;
    }

    if (this.eventLoopMonitor.isOverloaded()) {
      this.logger.warn(
        `processQueue skipped: event loop overloaded (lag=${this.eventLoopMonitor.getLagMs()}ms, heap=${this.eventLoopMonitor.getMemoryPercent()}%)`,
      );
      return;
    }

    this.isProcessingQueue = true;

    try {
      const pendingCount = await this.prisma.fragmentQueue.count({
        where: { status: 'PENDING' },
      });

      this.logger.log(
        `processQueue tick: ${pendingCount} PENDING item(s), leader=${this.isWalletLeader}`,
      );

      const eventTriggered = this.triggeredByEvent;
      this.triggeredByEvent = false;

      if (
        pendingCount > 0 &&
        pendingCount < this.MIN_BATCH_SIZE &&
        !eventTriggered
      ) {
        const oldestPending = await this.prisma.fragmentQueue.findFirst({
          where: { status: 'PENDING' },
          orderBy: { created_at: 'asc' },
          select: { created_at: true },
        });

        if (oldestPending) {
          const waitingMs = Date.now() - oldestPending.created_at.getTime();
          if (waitingMs < this.MAX_ACCUMULATION_WAIT_MS) {
            this.logger.debug(
              `Accumulating: ${pendingCount} items pending (min ${this.MIN_BATCH_SIZE}), oldest waiting ${Math.round(waitingMs / 1000)}s (max ${this.MAX_ACCUMULATION_WAIT_MS / 1000}s)`,
            );
            this.isProcessingQueue = false;
            return;
          }
        }
      }

      if (eventTriggered && pendingCount > 0) {
        this.logger.log(
          `Processing ${pendingCount} item(s) immediately (triggered by payment event)`,
        );
      }

      if (pendingCount > 0) {
        if (Date.now() < this.insufficientBalanceUntil) {
          this.logger.debug(
            `Skipping queue processing: insufficient balance cooldown active ` +
              `(last known: ${this.lastKnownInsufficientBalance.toFixed(4)} TON). ` +
              `${pendingCount} items waiting. checkPendingOrdersOnWalletTopUp will resume when funded.`,
          );
          this.isProcessingQueue = false;
          return;
        }

        try {
          const walletBalance = parseFloat(
            await this.tonWalletService.getBalance(),
          );

          if (walletBalance < this.MIN_WALLET_BALANCE_TON) {
            this.lastKnownInsufficientBalance = walletBalance;
            this.insufficientBalanceUntil =
              Date.now() + this.INSUFFICIENT_BALANCE_COOLDOWN_MS;

            this.logger.warn(
              `Skipping queue processing: wallet balance ${walletBalance.toFixed(4)} TON < ${this.MIN_WALLET_BALANCE_TON} TON. ` +
                `${pendingCount} items waiting. Will retry in ${this.INSUFFICIENT_BALANCE_COOLDOWN_MS / 1000}s.`,
            );

            await this.notifyInsufficientFunds(walletBalance);

            this.isProcessingQueue = false;
            return;
          }
        } catch (error: any) {
          this.logger.warn(
            `Failed to check wallet balance, proceeding with processing: ${error.message}`,
          );
        }
      }

      let totalProcessed = 0;
      let batchNumber = 0;
      const cycleStartTime = Date.now();

      const accountCount = await this.fragmentAccountService.getActiveCount();
      const concurrency = Math.min(
        Math.max(accountCount * 2, 5),
        this.MAX_CONCURRENT_PREPARATIONS,
      );

      let previousSendPromise: Promise<void> | null = null;

      while (totalProcessed < this.MAX_CYCLE_ITEMS) {
        if (Date.now() - cycleStartTime > this.MAX_CYCLE_TIME_MS) {
          this.logger.warn(
            `Cycle time limit reached (${Math.round((Date.now() - cycleStartTime) / 1000)}s), processed ${totalProcessed} items in ${batchNumber} batches`,
          );
          break;
        }

        if (this.eventLoopMonitor.isOverloaded()) {
          this.logger.warn(
            `Pausing queue processing mid-cycle: event loop overloaded (lag=${this.eventLoopMonitor.getLagMs()}ms). Processed ${totalProcessed} items so far.`,
          );
          break;
        }

        const currentBatchSize =
          this.eventLoopMonitor.getLagMs() > 150
            ? Math.max(5, Math.floor(this.BATCH_SIZE / 2))
            : this.BATCH_SIZE;

        const pendingItems = await this.prisma.fragmentQueue.findMany({
          where: { status: 'PENDING' },
          orderBy: { created_at: 'asc' },
          take: currentBatchSize,
          include: {
            user: {
              select: {
                telegram_id: true,
                username: true,
                first_name: true,
              },
            },
            payment: {
              select: {
                id: true,
                order_number: true,
                payment_message_id: true,
              },
            },
          },
        });

        if (pendingItems.length === 0) {
          if (batchNumber > 0) {
            this.logger.log(
              `Queue empty. Processed ${totalProcessed} items in ${batchNumber} batches (${Math.round((Date.now() - cycleStartTime) / 1000)}s)`,
            );
          }
          break;
        }

        batchNumber++;
        const pipelineNote = previousSendPromise
          ? ' (pipelined: previous batch confirming in background)'
          : '';
        this.logger.log(
          `Batch #${batchNumber}: preparing ${pendingItems.length} items (concurrency: ${concurrency}, total so far: ${totalProcessed})${pipelineNote}`,
        );

        const preCheckedIds = new Set<string>();
        const skippedByPreCheck = new Set<string>();

        const itemsWithComments = await this.prisma.fragmentQueue.findMany({
          where: { id: { in: pendingItems.map((i) => i.id) } },
          select: { id: true, ton_comment: true, prev_ton_comments: true },
        });

        const allPreCheckComments: { orderId: string; comment: string }[] = [];
        for (const ic of itemsWithComments) {
          const comments: string[] = [];
          if (ic.ton_comment) comments.push(ic.ton_comment);
          if (ic.prev_ton_comments) comments.push(...ic.prev_ton_comments);
          for (const c of comments) {
            allPreCheckComments.push({ orderId: ic.id, comment: c });
          }
        }

        if (allPreCheckComments.length > 0) {
          this.logger.log(
            `Batch pre-scan: checking ${allPreCheckComments.length} existing comment(s) from ${itemsWithComments.filter((i) => i.ton_comment || (i.prev_ton_comments && i.prev_ton_comments.length > 0)).length} item(s) in ONE blockchain call`,
          );

          try {
            const preCheck =
              await this.tonWalletService.checkCommentsInBatch(
                allPreCheckComments,
              );

            for (const [orderId, dup] of preCheck.results) {
              this.logger.warn(
                `DUPLICATE PREVENTED (batch pre-scan): item ${orderId} found on blockchain, tx_hash ${dup.txHash}. Marking COMPLETED.`,
              );
              await this.prisma.fragmentQueue.update({
                where: { id: orderId },
                data: {
                  status: 'COMPLETED',
                  tx_hash: dup.txHash,
                  updated_at: new Date(),
                },
              });
              await this.redisLock.markQueueItemCompleted(orderId, dup.txHash);
              skippedByPreCheck.add(orderId);
            }

            if (!preCheck.exhaustive) {
              for (const ic of itemsWithComments) {
                const hasComments =
                  ic.ton_comment ||
                  (ic.prev_ton_comments && ic.prev_ton_comments.length > 0);
                if (hasComments && !skippedByPreCheck.has(ic.id)) {
                  this.logger.warn(
                    `SAFETY HOLD (batch pre-scan): item ${ic.id} has existing comments but scan not exhaustive. Skipping.`,
                  );
                  skippedByPreCheck.add(ic.id);
                }
              }
            } else {
              for (const ic of itemsWithComments) {
                if (!skippedByPreCheck.has(ic.id)) {
                  preCheckedIds.add(ic.id);
                }
              }
            }
          } catch (error: any) {
            this.logger.error(
              `Batch pre-scan FAILED: ${error.message}. Items with existing comments will be skipped.`,
            );
            for (const ic of itemsWithComments) {
              const hasComments =
                ic.ton_comment ||
                (ic.prev_ton_comments && ic.prev_ton_comments.length > 0);
              if (hasComments) {
                skippedByPreCheck.add(ic.id);
              }
            }
          }
        }

        const itemsToProcess = pendingItems.filter(
          (item) => !skippedByPreCheck.has(item.id),
        );

        if (skippedByPreCheck.size > 0) {
          this.logger.log(
            `Batch pre-scan result: ${skippedByPreCheck.size} skipped, ${itemsToProcess.length} proceeding to preparation`,
          );
        }

        const transactionsToSend: TransactionToSend[] = [];

        const tasks = itemsToProcess.map(
          (item) => () =>
            this.prepareQueueItemTransaction({
              id: item.id,
              user_id: item.user_id,
              user_telegram_id: item.user.telegram_id,
              payment_id: item.payment_id,
              username: item.username,
              stars: item.stars,
              ton: item.ton,
              premium: item.premium,
              is_anon: item.is_anon,
              order_number: item.payment?.order_number,
              payment_message_id: item.payment?.payment_message_id || undefined,
              preCheckPassed: preCheckedIds.has(item.id),
            }),
        );

        const preparationResults = await this.runWithConcurrency(
          tasks,
          concurrency,
        );

        for (let i = 0; i < preparationResults.length; i++) {
          const result = preparationResults[i];
          const item = pendingItems[i];

          if (result.status === 'fulfilled' && result.value) {
            transactionsToSend.push(result.value);
          } else {
            const errorReason =
              result.status === 'rejected' ? result.reason?.message : 'unknown';
            this.logger.error(
              `Failed to prepare transaction for ${item.id}: ${errorReason}`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: { status: 'FAILED', updated_at: new Date() },
            });
            await this.queueErrorNotification(item);
          }
        }

        if (previousSendPromise) {
          this.logger.log(
            `Batch #${batchNumber}: waiting for previous batch send+confirm to complete before sending...`,
          );
          await previousSendPromise;
          previousSendPromise = null;
        }

        if (transactionsToSend.length > 0) {
          const currentBatchNum = batchNumber;
          previousSendPromise = this.sendBatchTransactions(
            transactionsToSend,
          ).catch((error: any) => {
            this.logger.error(
              `Batch #${currentBatchNum} send failed: ${error.message}`,
            );
          });
        }

        totalProcessed += pendingItems.length;

        if (pendingItems.length < currentBatchSize) {
          break;
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      if (previousSendPromise) {
        this.logger.log('Waiting for last batch send+confirm to complete...');
        await previousSendPromise;
      }

      if (batchNumber > 0) {
        this.logger.log(
          `Queue drained. Processed ${totalProcessed} items in ${batchNumber} batches (${Math.round((Date.now() - cycleStartTime) / 1000)}s)`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Fragment queue processor error: ${error.message}`);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async prepareQueueItemTransaction(
    item: FragmentQueueItem,
  ): Promise<TransactionToSend | null> {
    const currentItem = await this.prisma.fragmentQueue.findUnique({
      where: { id: item.id },
      select: {
        status: true,
        tx_hash: true,
        ton_comment: true,
        ton_amount: true,
        valid_until: true,
      },
    });

    if (!currentItem) {
      this.logger.error(`Queue item ${item.id} not found in DB`);
      return null;
    }

    if (currentItem.status === 'COMPLETED') {
      this.logger.warn(
        `Queue item ${item.id} already COMPLETED (tx: ${currentItem.tx_hash}), skipping to prevent duplicate delivery`,
      );
      return null;
    }

    if (currentItem.tx_hash) {
      this.logger.warn(
        `Queue item ${item.id} already has tx_hash (${currentItem.tx_hash}), skipping to prevent duplicate delivery`,
      );
      return null;
    }

    if (currentItem.ton_comment && currentItem.ton_amount) {
      if (item.preCheckPassed) {
        this.logger.log(
          `Queue item ${item.id} has cached ton_comment — batch pre-scan already confirmed safe, skipping individual check`,
        );
      } else {
        this.logger.log(
          `Queue item ${item.id} has cached ton_comment — performing mandatory blockchain check before reuse`,
        );

        const allComments: string[] = [currentItem.ton_comment];
        const fullItem = await this.prisma.fragmentQueue.findUnique({
          where: { id: item.id },
          select: { prev_ton_comments: true },
        });
        if (fullItem?.prev_ton_comments) {
          allComments.push(...fullItem.prev_ton_comments);
        }

        try {
          const commentsToCheck = allComments.map((c) => ({
            orderId: item.id,
            comment: c,
          }));
          const batchCheck =
            await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
          const found = batchCheck.results.get(item.id);

          if (found && found.txHash) {
            this.logger.warn(
              `DUPLICATE PREVENTED in prepareTransaction: Queue item ${item.id} ` +
                `already on blockchain (tx_hash ${found.txHash}). Marking COMPLETED.`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: {
                status: 'COMPLETED',
                tx_hash: found.txHash,
                updated_at: new Date(),
              },
            });
            await this.redisLock.markQueueItemCompleted(item.id, found.txHash);
            return null;
          }

          if (!batchCheck.exhaustive) {
            this.logger.error(
              `Blockchain check INCOMPLETE for queue item ${item.id} — Toncenter lookup failed or unavailable. ` +
                `REFUSING to reuse cached ton_comment — keeping PROCESSING to prevent double-send.`,
            );
            await this.prisma.fragmentQueue.updateMany({
              where: { id: item.id, status: { notIn: ['COMPLETED'] } },
              data: { status: 'PROCESSING', updated_at: new Date() },
            });
            return null;
          }
        } catch (error: any) {
          this.logger.error(
            `Blockchain check FAILED for queue item ${item.id} with existing ton_comment. ` +
              `REFUSING to resend — keeping in PROCESSING until blockchain is verified. Error: ${error.message}`,
          );
          await this.prisma.fragmentQueue.updateMany({
            where: { id: item.id, status: { notIn: ['COMPLETED'] } },
            data: { status: 'PROCESSING', updated_at: new Date() },
          });
          return null;
        }

        this.logger.log(
          `Blockchain check confirmed (exhaustive): no existing tx for queue item ${item.id}. Safe to reuse cached transaction data.`,
        );
      }

      await this.prisma.fragmentQueue.updateMany({
        where: { id: item.id, status: { notIn: ['COMPLETED'] } },
        data: { status: 'PROCESSING', updated_at: new Date() },
      });

      let productType: 'stars' | 'premium' | 'ton';
      let quantity: number;

      if (item.stars) {
        productType = 'stars';
        quantity = item.stars;
      } else if (item.ton) {
        productType = 'ton';
        quantity = item.ton;
      } else if (item.premium) {
        productType = 'premium';
        quantity = item.premium;
      } else {
        throw new Error('Invalid queue item: no product specified');
      }

      return {
        destination: this.FRAGMENT_WALLET_ADDRESS,
        amount: currentItem.ton_amount,
        comment: currentItem.ton_comment,
        order_id: item.id,
        type: productType,
        user_id: item.user_telegram_id,
        amount_value: quantity,
        validUntil: currentItem.valid_until ?? undefined,
      };
    }

    let productType: 'stars' | 'premium' | 'ton';
    let quantity: number;

    if (item.stars) {
      productType = 'stars';
      quantity = item.stars;
    } else if (item.ton) {
      productType = 'ton';
      quantity = item.ton;
    } else if (item.premium) {
      productType = 'premium';
      quantity = item.premium;
    } else {
      throw new Error('Invalid queue item: no product specified');
    }

    const usernameClean = item.username?.replace(/^@/, '') || '';
    if (!usernameClean) {
      this.logger.error(
        `Queue item ${item.id} has empty username | user_id: ${item.user_id}, payment_id: ${item.payment_id}, stars: ${item.stars}, ton: ${item.ton}, premium: ${item.premium}. Cannot deliver product without recipient username.`,
      );
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      return null;
    }

    if (!item.preCheckPassed) {
      const existingItem = await this.prisma.fragmentQueue.findUnique({
        where: { id: item.id },
        select: { ton_comment: true, prev_ton_comments: true },
      });
      const prevComments = existingItem?.prev_ton_comments || [];
      const allExistingComments = existingItem?.ton_comment
        ? [...prevComments, existingItem.ton_comment]
        : prevComments;

      if (allExistingComments.length > 0) {
        this.logger.log(
          `Queue item ${item.id} has ${allExistingComments.length} existing comment(s) ` +
            `(ton_comment: ${existingItem?.ton_comment ? 'yes' : 'no'}, prev: ${prevComments.length}) ` +
            `— mandatory blockchain check before creating new Fragment order`,
        );

        try {
          const commentsToCheck = allExistingComments.map((c) => ({
            orderId: item.id,
            comment: c,
          }));
          const batchCheck =
            await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
          const found = batchCheck.results.get(item.id);

          if (found && found.txHash) {
            this.logger.warn(
              `DUPLICATE PREVENTED: Queue item ${item.id} existing comment found on blockchain ` +
                `(tx_hash ${found.txHash}). Marking COMPLETED instead of creating new Fragment order.`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: {
                status: 'COMPLETED',
                tx_hash: found.txHash,
                updated_at: new Date(),
              },
            });
            await this.redisLock.markQueueItemCompleted(item.id, found.txHash);
            return null;
          }

          if (!batchCheck.exhaustive) {
            this.logger.error(
              `Blockchain check INCOMPLETE for queue item ${item.id} with ${allExistingComments.length} existing comment(s). ` +
                `REFUSING to create new Fragment order — partial scan cannot confirm absence. ` +
                `Keeping PENDING, will retry when full blockchain verification is available.`,
            );
            return null;
          }
        } catch (error: any) {
          this.logger.error(
            `Blockchain check FAILED for queue item ${item.id} with ${allExistingComments.length} existing comment(s). ` +
              `REFUSING to create new Fragment order — cannot confirm previous transactions are absent. ` +
              `Keeping PENDING, will retry when blockchain API is available. Error: ${error.message}`,
          );
          return null;
        }

        this.logger.log(
          `Blockchain confirmed (exhaustive): no previous tx for queue item ${item.id}. Safe to create new Fragment order.`,
        );
      }
    } else {
      this.logger.log(
        `Queue item ${item.id}: batch pre-scan already confirmed safe, skipping individual blockchain check`,
      );
    }

    const claimed = await this.prisma.fragmentQueue.updateMany({
      where: { id: item.id, status: 'PENDING' },
      data: { status: 'PROCESSING', updated_at: new Date() },
    });

    if (claimed.count === 0) {
      this.logger.warn(
        `Queue item ${item.id} already claimed by another process, skipping`,
      );
      return null;
    }

    let result: Awaited<
      ReturnType<FragmentService['completePurchaseFlow']>
    > | null = null;

    const account = await this.fragmentAccountService.getNextAccount();

    if (!account) {
      this.logger.error(
        `No active Fragment accounts available for queue item ${item.id}`,
      );
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      return null;
    }

    const RETRY_DELAY_MS = 1000;
    const ITEM_RETRY_TIMEOUT_MS = 3 * 60 * 1000;
    let retryCount = 0;
    const retryStartTime = Date.now();

    this.logger.log(
      `Using Fragment account "${account.name}" (${account.id}) for queue item ${item.id}`,
    );

    while (true) {
      await this.prisma.fragmentQueue.updateMany({
        where: { id: item.id, status: 'PROCESSING', tx_hash: null },
        data: { updated_at: new Date() },
      });

      result = await this.fragmentService.completePurchaseFlow(
        account,
        usernameClean,
        quantity,
        productType,
      );

      if (result.success) {
        break;
      }

      if (result.error === 'ALREADY_SUBSCRIBED') {
        this.logger.warn(
          `Queue item ${item.id}: User ${item.username} already has Premium subscription`,
        );
        await this.prisma.fragmentQueue.update({
          where: { id: item.id },
          data: { status: 'FAILED', retry_count: 5, updated_at: new Date() },
        });
        await this.sendAlreadySubscribedNotification(item);
        return null;
      }

      if (
        result.error === 'GIFTS_CLOSED' ||
        result.error === 'User not found in Fragment'
      ) {
        this.logger.error(
          `Queue item ${item.id} permanent error: ${result.error} | username: ${item.username}`,
        );
        await this.prisma.fragmentQueue.update({
          where: { id: item.id },
          data: { status: 'FAILED', retry_count: 5, updated_at: new Date() },
        });
        return null;
      }

      retryCount++;

      if (Date.now() - retryStartTime > ITEM_RETRY_TIMEOUT_MS) {
        this.logger.warn(
          `Queue item ${item.id}: retry timeout (${retryCount} retries in ${Math.round((Date.now() - retryStartTime) / 1000)}s). Returning to PENDING for next cycle.`,
        );
        await this.prisma.fragmentQueue.update({
          where: { id: item.id },
          data: {
            status: 'PENDING',
            outbound_submitted_at: null,
            external_out_msg_hash: null,
            updated_at: new Date(),
          },
        });
        return null;
      }

      this.logger.warn(
        `Queue item ${item.id}: "${account.name}" error: ${result.error}. Retry #${retryCount}...`,
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

      await this.prisma.fragmentQueue.updateMany({
        where: { id: item.id, status: 'PROCESSING', tx_hash: null },
        data: { updated_at: new Date() },
      });
    }

    if (retryCount > 0) {
      this.logger.log(
        `Queue item ${item.id} succeeded on "${account.name}" after ${retryCount} retries` +
          (result.latencyMs ? ` (Fragment API: ${result.latencyMs}ms)` : ''),
      );
    } else if (result.latencyMs) {
      this.logger.log(
        `Queue item ${item.id} Fragment API completed in ${result.latencyMs}ms`,
      );
    }

    if (!result.transactionData) {
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      return null;
    }

    const transactionData = result.transactionData;

    if (!transactionData.transaction || !transactionData.transaction.messages) {
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      throw new Error('Transaction messages not found in Fragment response');
    }

    const message = transactionData.transaction.messages[0];
    if (!message) {
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      throw new Error('Transaction message is empty');
    }

    const address = message.address;
    const amountRaw = message.amount;
    const payload = message.payload || '';
    const validUntil = transactionData.transaction.validUntil;

    if (!address) {
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      throw new Error('Address not found in transaction');
    }
    if (!amountRaw) {
      await this.prisma.fragmentQueue.update({
        where: { id: item.id },
        data: { status: 'FAILED', updated_at: new Date() },
      });
      throw new Error('Amount not found in transaction');
    }

    const amount = parseInt(amountRaw) / 1e9;

    const comment = payload;

    const currentState = await this.prisma.fragmentQueue.findUnique({
      where: { id: item.id },
      select: { ton_comment: true, prev_ton_comments: true },
    });
    const archivePrev = currentState?.prev_ton_comments || [];
    if (currentState?.ton_comment && currentState.ton_comment !== comment) {
      archivePrev.push(currentState.ton_comment);
    }

    const claimed2 = await this.prisma.fragmentQueue.updateMany({
      where: { id: item.id, status: 'PROCESSING', tx_hash: null },
      data: {
        ton_amount: amount,
        ton_comment: comment,
        valid_until: validUntil || null,
        fragment_account_id: result.accountId || null,
        prev_ton_comments: archivePrev,
        blockchain_miss_count: 0,
        outbound_submitted_at: null,
        external_out_msg_hash: null,
        updated_at: new Date(),
      },
    });

    if (claimed2.count === 0) {
      this.logger.warn(
        `Queue item ${item.id} was modified by another process during preparation, aborting to prevent duplicate`,
      );
      return null;
    }

    this.logger.log(
      `Prepared transaction for queue item ${item.id} | user_id: ${item.user_id}, user_telegram_id: ${item.user_telegram_id}, username: ${item.username}, product: ${productType} x${quantity}, account: ${account.name}`,
    );

    return {
      destination: address,
      amount,
      comment,
      order_id: item.id,
      type: productType,
      user_id: item.user_telegram_id,
      amount_value: quantity,
      validUntil,
    };
  }

  /** Extra chain checks if Toncenter missed tx at first; slightly tighter than before (safe). */
  private readonly POST_SEND_CHAIN_VERIFY_DELAYS_MS = [
    12_000, 30_000, 52_000, 82_000,
  ] as const;

  private queueItemToTransactionToSend(row: {
    id: string;
    stars: number | null;
    ton: number | null;
    premium: number | null;
    ton_amount: number | null;
    ton_comment: string | null;
    valid_until: number | null;
    user: { telegram_id: string };
  }): TransactionToSend | null {
    if (!row.ton_comment || row.ton_amount == null) {
      return null;
    }

    let productType: 'stars' | 'premium' | 'ton';
    let quantity: number;

    if (row.stars) {
      productType = 'stars';
      quantity = row.stars;
    } else if (row.ton) {
      productType = 'ton';
      quantity = row.ton;
    } else if (row.premium) {
      productType = 'premium';
      quantity = row.premium;
    } else {
      return null;
    }

    return {
      destination: this.FRAGMENT_WALLET_ADDRESS,
      amount: row.ton_amount,
      comment: row.ton_comment,
      order_id: row.id,
      type: productType,
      user_id: row.user.telegram_id,
      amount_value: quantity,
      validUntil: row.valid_until ?? undefined,
    };
  }

  private schedulePostSendChainVerification(orderIds: readonly string[]): void {
    if (orderIds.length === 0) {
      return;
    }

    this.logger.log(
      `Scheduling ${this.POST_SEND_CHAIN_VERIFY_DELAYS_MS.length} delayed on-chain verifications ` +
        `for ${orderIds.length} order(s) (Toncenter v3 did not confirm in-window)`,
    );

    for (const delayMs of this.POST_SEND_CHAIN_VERIFY_DELAYS_MS) {
      const timeout = setTimeout(() => {
        const idx = this.postSendChainVerifyTimeouts.indexOf(timeout);
        if (idx >= 0) {
          this.postSendChainVerifyTimeouts.splice(idx, 1);
        }
        void this.tryCompleteProcessingOrdersFromChain(
          orderIds,
          `post-send+${delayMs}ms`,
        );
      }, delayMs);
      this.postSendChainVerifyTimeouts.push(timeout);
    }
  }

  private async tryCompleteProcessingOrdersFromChain(
    orderIds: readonly string[],
    source: string,
  ): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }
    if (this.eventLoopMonitor.isOverloaded()) {
      return;
    }

    const rows = await this.prisma.fragmentQueue.findMany({
      where: {
        id: { in: [...orderIds] },
        status: 'PROCESSING',
        tx_hash: null,
        ton_comment: { not: null },
      },
      include: {
        user: { select: { telegram_id: true } },
      },
    });

    if (rows.length === 0) {
      return;
    }

    const commentsToCheck = rows
      .filter((r) => r.ton_comment)
      .map((r) => ({ orderId: r.id, comment: r.ton_comment! }));

    if (commentsToCheck.length === 0) {
      return;
    }

    let batchResults: Map<string, { txHash: string; timestamp: number }>;
    let exhaustive: boolean;

    try {
      const batch =
        await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
      batchResults = batch.results;
      exhaustive = batch.exhaustive;
    } catch (error: any) {
      this.logger.warn(
        `[${source}] Post-send on-chain verify failed: ${error.message}`,
      );
      return;
    }

    if (!exhaustive) {
      this.logger.warn(
        `[${source}] Post-send on-chain verify incomplete (Toncenter); skipping updates`,
      );
      return;
    }

    for (const row of rows) {
      const found = batchResults.get(row.id);
      if (!found) {
        continue;
      }

      const txDone = await this.prisma.fragmentQueue.updateMany({
        where: { id: row.id, status: 'PROCESSING', tx_hash: null },
        data: {
          status: 'COMPLETED',
          tx_hash: found.txHash,
          blockchain_miss_count: 0,
          updated_at: new Date(),
        },
      });

      if (txDone.count === 0) {
        continue;
      }

      await this.redisLock.markQueueItemCompleted(row.id, found.txHash);

      const order = this.queueItemToTransactionToSend(row);
      if (order) {
        const tonscan = `https://tonviewer.com/transaction/${found.txHash}`;
        await this.queueSuccessNotification(order, tonscan, found.txHash);
      }

      this.logger.log(
        `[${source}] Order ${row.id} marked COMPLETED from delayed chain verify (tx_hash ${found.txHash})`,
      );
    }
  }

  private async sendBatchTransactions(
    transactions: TransactionToSend[],
  ): Promise<void> {
    this.logger.log(`Sending batch of ${transactions.length} transactions`);

    try {
      if (!this.tonWalletService.isInitialized()) {
        throw new Error('TON Wallet is not initialized');
      }

      const validTransactions: TransactionToSend[] = [];
      const skippedDuplicates: string[] = [];

      const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const orderIds = transactions.map((tx) => tx.order_id);
      const ordersWithPrevComments = await this.prisma.fragmentQueue.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, prev_ton_comments: true },
      });
      const prevCommentsMap = new Map(
        ordersWithPrevComments.map((o) => [o.id, o.prev_ton_comments || []]),
      );

      const commentsToCheck: { orderId: string; comment: string }[] = [];
      for (const tx of transactions) {
        if (tx.comment) {
          commentsToCheck.push({ orderId: tx.order_id, comment: tx.comment });
        }
        const prevComments = prevCommentsMap.get(tx.order_id) || [];
        for (const prevComment of prevComments) {
          commentsToCheck.push({ orderId: tx.order_id, comment: prevComment });
        }
      }

      let blockchainDuplicates = new Map<
        string,
        { txHash: string; timestamp: number }
      >();
      let blockchainCheckSucceeded = true;
      let blockchainCheckExhaustive = true;

      if (commentsToCheck.length > 0) {
        try {
          const batchCheck =
            await this.tonWalletService.checkCommentsInBatch(commentsToCheck);
          blockchainDuplicates = batchCheck.results;
          blockchainCheckExhaustive = batchCheck.exhaustive;
        } catch (error: any) {
          blockchainCheckSucceeded = false;
          this.logger.error(
            `Blockchain duplicate check failed: ${error.message}. ` +
              `Items with prev_ton_comments will be held back.`,
          );
        }
      }

      for (const tx of transactions) {
        try {
          const currentItem = await this.prisma.fragmentQueue.findUnique({
            where: { id: tx.order_id },
            select: { status: true, tx_hash: true, updated_at: true },
          });

          if (!currentItem) {
            this.logger.warn(`Queue item ${tx.order_id} not found, skipping`);
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          if (currentItem.status === 'COMPLETED') {
            this.logger.warn(
              `DUPLICATE PREVENTED: Queue item ${tx.order_id} already COMPLETED with tx_hash ${currentItem.tx_hash}, skipping`,
            );
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          if (currentItem.tx_hash) {
            this.logger.warn(
              `DUPLICATE PREVENTED: Queue item ${tx.order_id} already has tx_hash ${currentItem.tx_hash} (status: ${currentItem.status}), skipping`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: tx.order_id },
              data: { status: 'COMPLETED', updated_at: new Date() },
            });
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          const dup = blockchainDuplicates.get(tx.order_id);
          if (dup) {
            const prevComments = prevCommentsMap.get(tx.order_id) || [];
            const matchedPrev = prevComments.length > 0;
            this.logger.warn(
              `DUPLICATE PREVENTED (${matchedPrev ? 'prev_ton_comments' : 'current comment'} check): ` +
                `Found existing blockchain tx for order ${tx.order_id}. ` +
                `TxHash: ${dup.txHash}. prev_ton_comments count: ${prevComments.length}. ` +
                `Marking as COMPLETED.`,
            );
            await this.prisma.fragmentQueue.update({
              where: { id: tx.order_id },
              data: {
                status: 'COMPLETED',
                tx_hash: dup.txHash,
                updated_at: new Date(),
              },
            });

            skippedDuplicates.push(tx.order_id);
            continue;
          }

          if (!blockchainCheckSucceeded || !blockchainCheckExhaustive) {
            const prevComments = prevCommentsMap.get(tx.order_id) || [];
            this.logger.warn(
              `SAFETY HOLD: Queue item ${tx.order_id} ` +
                `(prev_ton_comments: ${prevComments.length}, ` +
                `check succeeded: ${blockchainCheckSucceeded}, exhaustive: ${blockchainCheckExhaustive}). ` +
                `Holding back to prevent potential double-send.`,
            );
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          if (tx.comment) {
            const sentBy = await this.redisLock.getTonCommentSentBy(tx.comment);
            if (sentBy && sentBy !== tx.order_id) {
              this.logger.warn(
                `DUPLICATE PREVENTED (Redis journal): ton_comment already sent by order ${sentBy}, ` +
                  `skipping order ${tx.order_id} to prevent double-send.`,
              );
              skippedDuplicates.push(tx.order_id);
              continue;
            }
          }

          if (currentItem.status !== 'PROCESSING') {
            this.logger.warn(
              `Queue item ${tx.order_id} has unexpected status ${currentItem.status}, skipping`,
            );
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          const updateResult = await this.prisma.fragmentQueue.updateMany({
            where: {
              id: tx.order_id,
              status: 'PROCESSING',
              tx_hash: null,
              updated_at: currentItem.updated_at,
            },
            data: {
              updated_at: new Date(),
            },
          });

          if (updateResult.count === 0) {
            this.logger.warn(
              `DUPLICATE PREVENTED: Queue item ${tx.order_id} was modified by another process, skipping`,
            );
            skippedDuplicates.push(tx.order_id);
            continue;
          }

          validTransactions.push(tx);
        } catch (error: any) {
          this.logger.error(
            `Error checking queue item ${tx.order_id}: ${error.message}`,
          );
          skippedDuplicates.push(tx.order_id);
        }
      }

      if (skippedDuplicates.length > 0) {
        this.logger.warn(
          `Skipped ${skippedDuplicates.length} potential duplicate transactions: ${skippedDuplicates.join(', ')}`,
        );
      }

      if (validTransactions.length === 0) {
        this.logger.log(
          'No valid transactions to send after filtering duplicates',
        );
        return;
      }

      const seenOrderIds = new Set<string>();
      const droppedDuplicates: TransactionToSend[] = [];
      const dedupedTransactions = validTransactions.filter((tx) => {
        if (seenOrderIds.has(tx.order_id)) {
          this.logger.warn(
            `Dropping duplicate order_id ${tx.order_id} (destination=${tx.destination}, amount=${tx.amount}) from batch before send`,
          );
          droppedDuplicates.push(tx);
          return false;
        }
        seenOrderIds.add(tx.order_id);
        return true;
      });

      if (dedupedTransactions.length < validTransactions.length) {
        this.logger.warn(
          `Removed ${validTransactions.length - dedupedTransactions.length} duplicate order_id(s) from batch before sending`,
        );
      }

      if (dedupedTransactions.length === 0) {
        this.logger.log('No transactions left after order_id dedupe');
        return;
      }

      this.logger.log(
        `Batch ${batchId}: ${dedupedTransactions.length} transactions ready to send`,
      );

      const now = Math.floor(Date.now() / 1000);
      const VALID_UNTIL_BUFFER_SECONDS = 30;
      const expiredTransactions: TransactionToSend[] = [];
      const validTransactionsFiltered = dedupedTransactions.filter((tx) => {
        if (
          tx.validUntil &&
          this.tonWalletService.isTransactionExpired(
            tx.validUntil,
            VALID_UNTIL_BUFFER_SECONDS,
          )
        ) {
          this.logger.warn(
            `Transaction ${tx.order_id} has expired validUntil (${tx.validUntil}), current time: ${now}`,
          );
          expiredTransactions.push(tx);
          return false;
        }
        return true;
      });

      if (expiredTransactions.length > 0) {
        this.logger.warn(
          `${expiredTransactions.length} transaction(s) expired, returning to PENDING for refresh`,
        );
        await Promise.allSettled(
          expiredTransactions.map(async (tx) => {
            const existing = await this.prisma.fragmentQueue.findUnique({
              where: { id: tx.order_id },
              select: { ton_comment: true, prev_ton_comments: true },
            });
            const prevComments = existing?.prev_ton_comments || [];
            const updatedPrevComments = existing?.ton_comment
              ? [...prevComments, existing.ton_comment]
              : prevComments;

            return this.prisma.fragmentQueue.update({
              where: { id: tx.order_id },
              data: {
                status: 'PENDING',
                ton_comment: null,
                ton_amount: null,
                valid_until: null,
                prev_ton_comments: updatedPrevComments,
                outbound_submitted_at: null,
                external_out_msg_hash: null,
                updated_at: new Date(),
              },
            });
          }),
        );
      }

      if (validTransactionsFiltered.length === 0) {
        this.logger.log(
          'No valid transactions left after validUntil filtering',
        );
        return;
      }

      const walletBalance = parseFloat(
        await this.tonWalletService.getBalance(),
      );
      const totalAmountNeeded = validTransactionsFiltered.reduce(
        (sum, tx) => sum + tx.amount,
        0,
      );

      const estimatedFees = this.tonWalletService.estimateBatchFees(
        validTransactionsFiltered.length,
        150,
      );
      const totalNeeded = totalAmountNeeded + estimatedFees;

      if (walletBalance < totalNeeded) {
        this.lastKnownInsufficientBalance = walletBalance;
        this.insufficientBalanceUntil =
          Date.now() + this.INSUFFICIENT_BALANCE_COOLDOWN_MS;

        this.logger.warn(
          `Insufficient wallet balance: ${walletBalance.toFixed(4)} TON, needed: ${totalNeeded.toFixed(4)} TON ` +
            `(amount: ${totalAmountNeeded.toFixed(4)}, fees: ${estimatedFees.toFixed(4)}). ` +
            `Cooldown ${this.INSUFFICIENT_BALANCE_COOLDOWN_MS / 1000}s.`,
        );

        await this.notifyInsufficientFunds(walletBalance);

        await Promise.allSettled(
          validTransactionsFiltered.map((order) =>
            this.prisma.fragmentQueue.updateMany({
              where: {
                id: order.order_id,
                status: { notIn: ['COMPLETED'] },
              },
              data: {
                status: 'PENDING',
                outbound_submitted_at: null,
                external_out_msg_hash: null,
                updated_at: new Date(),
              },
            }),
          ),
        );

        return;
      }

      for (const tx of validTransactionsFiltered) {
        if (tx.comment) {
          await this.redisLock.markTonCommentSent(tx.comment, tx.order_id);
        }
      }

      const result = await this.tonWalletService.batchTransfer(
        validTransactionsFiltered,
      );

      if (!result.success) {
        const errorMessage = result.error || 'Failed to send batch transfer';
        const isExitCode36 = errorMessage.includes('exitcode=36');
        const isExitCode35 =
          result.isExitCode35 === true || errorMessage.includes('exitcode=35');
        const isDuplicateBatch = errorMessage.includes(
          'Duplicate batch detected',
        );

        if (result.sentToBlockchain) {
          this.logger.error(
            `Batch ${batchId} was SENT TO BLOCKCHAIN but failed: ${errorMessage}. ` +
              `Keeping items in PROCESSING. Recovery cron will verify on-chain.`,
          );

          return;
        }

        if (isExitCode35) {
          // Wallet contract rejected the external message at the
          // `created_at <= now()` check. Guaranteed: no queryId consumed,
          // nothing on-chain. Safe to return items to PENDING right now and
          // let the next processQueue tick (~3s) re-prepare them with a
          // fresh Fragment order. We archive any existing `ton_comment` to
          // `prev_ton_comments` so the standard duplicate-prevention pre-scan
          // still protects us if anything was somehow applied.
          this.logger.warn(
            `Batch ${batchId} rejected with exitcode=35 (invalid_created_at) — ` +
              `Toncenter liteserver lag. Returning ${validTransactionsFiltered.length} item(s) ` +
              `to PENDING immediately for fresh-createdAt retry (no 10-min recovery wait).`,
          );

          await Promise.allSettled(
            validTransactionsFiltered.map(async (tx) => {
              const existing = await this.prisma.fragmentQueue.findUnique({
                where: { id: tx.order_id },
                select: { ton_comment: true, prev_ton_comments: true },
              });
              const prevComments = existing?.prev_ton_comments || [];
              const updatedPrevComments = existing?.ton_comment
                ? [...prevComments, existing.ton_comment]
                : prevComments;

              return this.prisma.fragmentQueue.updateMany({
                where: {
                  id: tx.order_id,
                  status: { notIn: ['COMPLETED'] },
                  tx_hash: null,
                },
                data: {
                  status: 'PENDING',
                  ton_comment: null,
                  ton_amount: null,
                  valid_until: null,
                  prev_ton_comments: updatedPrevComments,
                  blockchain_miss_count: 0,
                  outbound_submitted_at: null,
                  external_out_msg_hash: null,
                  updated_at: new Date(),
                },
              });
            }),
          );

          this.scheduleImmediateProcessing();
          return;
        }

        if (isDuplicateBatch) {
          this.logger.error(
            `DUPLICATE BATCH DETECTED at wallet level! Batch ${batchId} was rejected.`,
          );
        }

        const error: any = new Error(errorMessage);
        error.isExitCode36 = isExitCode36;
        error.isDuplicateBatch = isDuplicateBatch;
        error.originalError = result.error;
        error.validTransactions = validTransactionsFiltered;
        throw error;
      }

      const confirmedMessages = result.confirmedMessages;
      const fallbackTxHash = result.txHashHex || result.txHash || null;

      const confirmedCount = confirmedMessages?.size || 0;
      this.logger.log(
        `Batch transfer completed: ${validTransactionsFiltered.length} transactions, ` +
          `confirmed via v3 API: ${confirmedCount}/${validTransactionsFiltered.length}, ` +
          `fallback txHash: ${fallbackTxHash || 'NONE'}, ` +
          `externalMsgCell: ${result.externalMessageHashHex || 'NONE'}`,
      );

      if (confirmedCount === 0 && !fallbackTxHash) {
        this.logger.warn(
          `Batch transfer succeeded but NO messages confirmed via v3 API. ` +
            `Keeping ${validTransactionsFiltered.length} orders in PROCESSING — ` +
            `delayed on-chain verify + recovery cron will confirm. NOT marking as COMPLETED.`,
        );

        this.schedulePostSendChainVerification(
          validTransactionsFiltered.map((tx) => tx.order_id),
        );

        return;
      }

      await Promise.allSettled(
        validTransactionsFiltered.map(async (order) => {
          try {
            const confirmed = confirmedMessages?.get(order.order_id);
            const orderTxHash = confirmed?.txHash || fallbackTxHash;
            const orderTonscanUrl = confirmed
              ? confirmed.tonscanUrl
              : fallbackTxHash
                ? `https://tonviewer.com/transaction/${fallbackTxHash}`
                : null;

            if (!orderTxHash) {
              this.logger.warn(
                `Order ${order.order_id}: no tx_hash found (not confirmed). Leaving in PROCESSING for recovery cron.`,
              );
              return;
            }

            this.logger.log(
              `Message confirmed for order ${order.order_id}: ` +
                `dest=${order.destination.slice(0, 20)}..., ` +
                `amount=${order.amount} TON, ` +
                `txHash=${orderTxHash}` +
                `${confirmed ? ' (individual v3)' : ' (batch fallback)'}`,
            );

            const updateResult = await this.prisma.fragmentQueue.updateMany({
              where: {
                id: order.order_id,
                tx_hash: null,
              },
              data: {
                status: 'COMPLETED',
                tx_hash: orderTxHash,
                outbound_submitted_at: null,
                external_out_msg_hash: null,
                updated_at: new Date(),
              },
            });

            if (updateResult.count === 0) {
              this.logger.warn(
                `Queue item ${order.order_id} was already updated (possible duplicate), skipping notification`,
              );
              return;
            }

            await this.queueSuccessNotification(
              order,
              orderTonscanUrl,
              confirmed?.txHash || null,
            );
          } catch (error: any) {
            this.logger.error(
              `Failed to process order ${order.order_id}: ${error.message}`,
            );
          }
        }),
      );
    } catch (error: any) {
      const MAX_RETRIES = 5;
      const txToProcess = error.validTransactions || transactions;

      const errorString = JSON.stringify(error, null, 2);
      const isExitCode36 =
        error.isExitCode36 === true ||
        error.message?.includes('exitcode=36') ||
        error.originalError?.includes('exitcode=36') ||
        error.response?.error?.includes('exitcode=36') ||
        errorString.includes('exitcode=36') ||
        (error.response &&
          JSON.stringify(error.response).includes('exitcode=36'));

      const isDuplicateBatch =
        error.isDuplicateBatch === true ||
        error.message?.includes('Duplicate batch detected');

      if (isExitCode36) {
        this.logger.warn(
          'Detected exitcode=36 — queryId already used. Checking blockchain for original transaction...',
        );

        await Promise.allSettled(
          txToProcess.map(async (order) => {
            try {
              const queueItem = await this.prisma.fragmentQueue.findUnique({
                where: { id: order.order_id },
                select: { ton_comment: true, tx_hash: true },
              });

              if (queueItem?.tx_hash) {
                await this.prisma.fragmentQueue.update({
                  where: { id: order.order_id },
                  data: { status: 'COMPLETED', updated_at: new Date() },
                });
                this.logger.log(
                  `exitcode=36: Item ${order.order_id} already has tx_hash ${queueItem.tx_hash}, marked COMPLETED`,
                );
                return;
              }

              if (queueItem?.ton_comment) {
                const blockchainCheck =
                  await this.tonWalletService.checkTransactionByComment(
                    queueItem.ton_comment,
                  );
                if (blockchainCheck.found && blockchainCheck.txHash) {
                  await this.prisma.fragmentQueue.update({
                    where: { id: order.order_id },
                    data: {
                      status: 'COMPLETED',
                      tx_hash: blockchainCheck.txHash,
                      updated_at: new Date(),
                    },
                  });
                  this.logger.log(
                    `exitcode=36 RESOLVED: Item ${order.order_id} found in blockchain with tx_hash ${blockchainCheck.txHash}`,
                  );
                  await this.queueSuccessNotification(order, null);
                  return;
                }
              }

              this.logger.warn(
                `exitcode=36: Item ${order.order_id} not yet found in blockchain. Keeping PROCESSING for recovery cron.` +
                  ` (safe — item stays in PROCESSING, no re-send)`,
              );
            } catch (checkError: any) {
              this.logger.error(
                `exitcode=36: Failed to check blockchain for ${order.order_id}: ${checkError.message}`,
              );
            }
          }),
        );
        return;
      }

      if (isDuplicateBatch) {
        this.logger.warn(
          `Duplicate batch detected in sendBatchTransactions — will try to resolve original tx_hash instead of retrying.`,
        );

        const originalTxHash =
          await this.tonWalletService.getCompletedBatchTxHash(txToProcess);

        await Promise.allSettled(
          txToProcess.map(async (order) => {
            try {
              if (originalTxHash) {
                this.logger.log(
                  `Duplicate batch resolved: marking ${order.order_id} as COMPLETED with tx_hash ${originalTxHash}`,
                );
                await this.prisma.fragmentQueue.update({
                  where: { id: order.order_id },
                  data: {
                    status: 'COMPLETED',
                    tx_hash: originalTxHash,
                    updated_at: new Date(),
                  },
                });
              } else {
                this.logger.warn(
                  `Duplicate batch for ${order.order_id}: original tx_hash not yet available. Leaving status unchanged.`,
                );
              }
            } catch (updateError: any) {
              this.logger.error(
                `Failed to update queue item ${order.order_id} after duplicate batch: ${updateError.message}`,
              );
            }
          }),
        );
        return;
      }

      await Promise.allSettled(
        txToProcess.map(async (order) => {
          try {
            const queueItem = await this.prisma.fragmentQueue.findUnique({
              where: { id: order.order_id },
              select: { retry_count: true, tx_hash: true, ton_comment: true },
            });

            if (queueItem?.tx_hash) {
              this.logger.warn(
                `Queue item ${order.order_id} has tx_hash (${queueItem.tx_hash}) - marking as COMPLETED instead of retrying to prevent duplicate delivery`,
              );
              await this.prisma.fragmentQueue.update({
                where: { id: order.order_id },
                data: {
                  status: 'COMPLETED',
                  updated_at: new Date(),
                },
              });
              await this.queueSuccessNotification(order, null);
              return;
            }

            if (queueItem?.ton_comment) {
              this.logger.warn(
                `Queue item ${order.order_id} has ton_comment — TON transaction may have been sent. ` +
                  `Keeping in PROCESSING for blockchain verification by recovery cron. ` +
                  `NEVER resending without 100% blockchain confirmation.`,
              );
              await this.prisma.fragmentQueue.update({
                where: { id: order.order_id },
                data: { updated_at: new Date() },
              });
              return;
            }

            const currentRetryCount = queueItem?.retry_count || 0;
            const newRetryCount = currentRetryCount + 1;

            if (newRetryCount >= MAX_RETRIES) {
              await this.prisma.fragmentQueue.update({
                where: { id: order.order_id },
                data: {
                  status: 'FAILED',
                  retry_count: newRetryCount,
                  updated_at: new Date(),
                },
              });

              this.logger.error(
                `Queue item ${order.order_id} marked as FAILED after max retries (${newRetryCount}/${MAX_RETRIES})`,
              );

              await this.queueErrorNotification({
                id: order.order_id,
                user_telegram_id: order.user_id,
              });
            } else {
              await this.prisma.fragmentQueue.update({
                where: { id: order.order_id },
                data: {
                  status: 'PENDING',
                  retry_count: newRetryCount,
                  outbound_submitted_at: null,
                  external_out_msg_hash: null,
                  updated_at: new Date(),
                },
              });
              this.logger.warn(
                `Queue item ${order.order_id} returned to PENDING for retry (attempt ${newRetryCount}/${MAX_RETRIES}) — no ton_comment, safe to retry`,
              );
            }
          } catch (updateError: any) {
            this.logger.error(
              `Failed to update queue item ${order.order_id}: ${updateError.message}`,
            );
          }
        }),
      );
    }
  }

  private async queueSuccessNotification(
    order: TransactionToSend,
    tonscanUrl: string | null,
    messageHash: string | null = null,
  ): Promise<void> {
    try {
      const queueItem = await this.prisma.fragmentQueue.findUnique({
        where: { id: order.order_id },
        include: {
          payment: {
            select: {
              id: true,
              order_number: true,
              payment_message_id: true,
              product_type: true,
            },
          },
          fragment_account: {
            select: {
              stel_ssid: true,
              stel_token: true,
              stel_ton_token: true,
              stel_hash: true,
            },
          },
        },
      });

      const messageData = {
        type: order.type,
        amount_value: order.amount_value,
        order_number: queueItem?.payment?.order_number,
        payment_message_id: queueItem?.payment?.payment_message_id,
        tonscanUrl,
        messageHash,
        destination: order.destination,
        tonAmount: order.amount,
      };

      await this.prisma.notificationQueue.create({
        data: {
          user_telegram_id: order.user_id,
          message_type: 'completed',
          queue_item_id: order.order_id,
          payment_id: queueItem?.payment?.id,
          message_data: messageData,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `Failed to queue notification, sending directly: ${error.message}`,
      );
      await this.sendSuccessNotificationDirect(order, tonscanUrl);
    }
  }

  private async queueErrorNotification(item: any): Promise<void> {
    try {
      const userTelegramId = item.user_telegram_id || item.user?.telegram_id;

      let orderNumber = null;
      let paymentId = null;

      if (item.payment_id) {
        const payment = await this.prisma.payment.findUnique({
          where: { id: item.payment_id },
          select: { order_number: true, id: true },
        });
        orderNumber = payment?.order_number;
        paymentId = payment?.id;
      }

      const messageData = {
        queue_item_id: item.id,
        order_number: orderNumber,
      };

      await this.prisma.notificationQueue.create({
        data: {
          user_telegram_id: userTelegramId,
          message_type: 'failed',
          queue_item_id: item.id,
          payment_id: paymentId,
          message_data: messageData,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `Failed to queue error notification, sending directly: ${error.message}`,
      );
      await this.sendErrorNotificationDirect(item);
    }
  }

  private async sendSuccessNotificationDirect(
    order: TransactionToSend,
    tonscanUrl: string | null,
  ): Promise<void> {
    try {
      const queueItem = await this.prisma.fragmentQueue.findUnique({
        where: { id: order.order_id },
        include: {
          user: {
            select: {
              telegram_id: true,
              username: true,
            },
          },
          payment: {
            select: {
              id: true,
              order_number: true,
              payment_message_id: true,
              product_type: true,
              user_telegram_id: true,
            },
          },
        },
      });

      const payment = queueItem?.payment;

      if (
        queueItem &&
        payment &&
        order.user_id !== queueItem.user.telegram_id
      ) {
        this.logger.error(
          `🚨 CRITICAL: USER MISMATCH DETECTED! Order #${payment.order_number} | Sending to: ${order.user_id}, but queueItem.user: ${queueItem.user.telegram_id}, payment.user: ${payment.user_telegram_id}`,
        );
      } else if (queueItem && queueItem.user) {
        this.logger.log(
          `Sending success notification for order ${order.order_id} to user ${order.user_id} (${queueItem.user.username || 'no username'})`,
        );
      }

      let productText: string;
      if (order.type === 'stars') {
        productText = `${order.amount_value} звёзд ⭐`;
      } else if (order.type === 'premium') {
        productText = `Telegram Premium 👑`;
      } else if (order.type === 'ton') {
        productText = `${order.amount_value} TON 💎`;
      } else {
        productText = `${order.amount_value} ${order.type}`;
      }

      let notificationText = `✅ <b>Ваш заказ выполнен!</b>\n\n📦 <b>Товар:</b> ${productText}`;

      if (payment?.order_number) {
        notificationText += `\n\n🆔 <b>Номер заказа:</b> <code>#${payment.order_number}</code>`;
      }

      if (tonscanUrl) {
        notificationText += `\n\n🔗 <a href="${tonscanUrl}">Посмотреть транзакцию</a>`;
      }
      notificationText += `\n\nСпасибо за покупку! Если у вас есть вопросы, пожалуйста, свяжитесь с нашей поддержкой.`;

      let successImage: string;
      if (order.type === 'ton') {
        successImage = './images/ton_success.webp';
      } else if (order.type === 'stars') {
        successImage = './images/stars_success.webp';
      } else if (order.type === 'premium') {
        successImage = './images/premium_success.webp';
      } else {
        successImage = './images/main_menu.webp';
      }

      if (payment?.payment_message_id) {
        try {
          await this.bot.telegram.editMessageMedia(
            order.user_id,
            parseInt(payment.payment_message_id),
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
        } catch (editError: any) {
          await this.sendPhotoWithFallback(
            order.user_id,
            successImage,
            notificationText,
          );
        }
      } else {
        await this.sendPhotoWithFallback(
          order.user_id,
          successImage,
          notificationText,
        );
      }
    } catch (error: any) {
      if (
        error?.response?.error_code === 403 ||
        error.message?.includes('bot was blocked by the user') ||
        error.message?.includes('user is deactivated')
      ) {
        this.logger.debug(
          `User ${order.user_id} blocked the bot, skipping success notification`,
        );
        return;
      }
      this.logger.error(
        `Failed to send success notification: ${error.message}`,
      );
    }
  }

  private async sendErrorNotificationDirect(item: any): Promise<void> {
    try {
      const userTelegramId = item.user_telegram_id || item.user?.telegram_id;

      const queueItem = await this.prisma.fragmentQueue.findUnique({
        where: { id: item.id },
        include: {
          payment: {
            select: {
              order_number: true,
              status: true,
            },
          },
        },
      });

      if (queueItem?.payment?.status === 'COMPLETED') {
        this.logger.warn(
          `Skipping error notification for queue item ${item.id} - payment already COMPLETED`,
        );
        return;
      }

      const orderNumber = queueItem?.payment?.order_number
        ? `#${queueItem.payment.order_number}`
        : item.id;

      this.logger.log(
        `Skipping error notification to user ${userTelegramId} for order ${orderNumber}`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to send error notification: ${error.message}`);
    }
  }

  private async sendPhotoWithFallback(
    chatId: string,
    image: string,
    caption: string,
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
    } catch (error: any) {
      if (
        error?.response?.error_code === 403 ||
        error.message?.includes('bot was blocked by the user') ||
        error.message?.includes('user is deactivated')
      ) {
        return;
      }
      await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        reply_markup: MainKeyboard.getBackButton().reply_markup,
      });
    }
  }

  private async sendAlreadySubscribedNotification(
    item: FragmentQueueItem,
  ): Promise<void> {
    try {
      const userTelegramId = item.user_telegram_id;
      const recipientUsername = item.username || 'получатель';
      const orderDisplay = item.order_number
        ? `#${item.order_number}`
        : item.id;

      const message = `❌ <b>Не удалось отправить подарок</b>

👤 <b>Получатель:</b> @${recipientUsername}
⚠️ <b>Причина:</b> У этого пользователя уже есть активная подписка Telegram Premium.

💡 <b>Что делать?</b>
• Дождитесь окончания текущей подписки
• Или выберите другого получателя

💰 <b>Возврат средств:</b>
Обратитесь в поддержку для возврата средств по этому заказу.

🆔 <b>Номер заказа:</b> <code>${orderDisplay}</code>`;

      await this.bot.telegram.sendMessage(userTelegramId, message, {
        parse_mode: 'HTML',
        reply_markup: MainKeyboard.getBackButton().reply_markup,
      });

      this.logger.log(
        `Sent "already subscribed" notification to user ${userTelegramId} for queue item ${item.id}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to send "already subscribed" notification: ${error.message}`,
      );
    }
  }

  private async notifyInsufficientFunds(currentBalance: number): Promise<void> {
    try {
      if (
        Date.now() - this.lastInsufficientFundsNotifyTime <
        this.INSUFFICIENT_FUNDS_NOTIFY_COOLDOWN_MS
      ) {
        return;
      }

      const channels =
        await this.settingsService.getInsufficientFundsChannels();

      if (channels.length === 0) {
        return;
      }

      const pendingAgg = await this.prisma.fragmentQueue.aggregate({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        _count: true,
        _sum: { ton_amount: true },
      });

      const totalPending = pendingAgg._count || 0;
      const knownSum = Number(pendingAgg._sum.ton_amount) || 0;

      const withAmountCount = await this.prisma.fragmentQueue.count({
        where: {
          status: { in: ['PENDING', 'PROCESSING'] },
          ton_amount: { not: null },
        },
      });

      let estimatedTotal: number;
      if (withAmountCount > 0 && withAmountCount < totalPending) {
        const avgPerOrder = knownSum / withAmountCount;
        estimatedTotal =
          knownSum + avgPerOrder * (totalPending - withAmountCount);
      } else {
        estimatedTotal = knownSum;
      }

      const fees = this.tonWalletService.estimateBatchFees(totalPending, 150);
      const totalNeeded = estimatedTotal + fees;
      const missingAmount = Math.max(0, totalNeeded - currentBalance);

      let message = `⚠️ <b>Недостаточно средств на кошельке</b>\n\n`;
      message += `💰 <b>Баланс:</b> ${currentBalance.toFixed(4)} TON\n`;
      message += `💸 <b>Требуется:</b> ~${totalNeeded.toFixed(4)} TON\n`;
      message += `❌ <b>Не хватает:</b> ~${missingAmount.toFixed(4)} TON\n`;
      message += `📦 <b>Заказов в очереди:</b> ${totalPending}\n\n`;
      message += `💡 <b>Пополните кошелек на ~${missingAmount.toFixed(4)} TON</b>`;

      for (const channel of channels) {
        try {
          await this.adminBot.telegram.sendMessage(
            channel.channel_id,
            message,
            {
              parse_mode: 'HTML',
            },
          );
        } catch (error: any) {
          this.logger.error(
            `Failed to send insufficient funds notification to channel ${channel.channel_id}: ${error.message}`,
          );
        }
      }

      this.lastInsufficientFundsNotifyTime = Date.now();
    } catch (error: any) {
      this.logger.error(
        `Error sending insufficient funds notification: ${error.message}`,
      );
    }
  }

  @Cron('0 */2 * * * *')
  async resolveMissingTxHashes(): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }

    try {
      const itemsWithoutHash = await this.prisma.fragmentQueue.findMany({
        where: {
          status: 'COMPLETED',
          tx_hash: null,
          ton_comment: { not: null },
        },
        select: {
          id: true,
          ton_comment: true,
          ton_amount: true,
          prev_ton_comments: true,
          updated_at: true,
          payment: {
            select: { order_number: true },
          },
        },
        take: 50,
        orderBy: { updated_at: 'desc' },
      });

      if (itemsWithoutHash.length === 0) {
        return;
      }

      this.logger.log(
        `Resolving tx_hash for ${itemsWithoutHash.length} COMPLETED orders with null tx_hash`,
      );

      const commentsToCheck: { orderId: string; comment: string }[] = [];
      for (const item of itemsWithoutHash) {
        if (item.ton_comment) {
          commentsToCheck.push({ orderId: item.id, comment: item.ton_comment });
        }
        for (const prevComment of item.prev_ton_comments || []) {
          commentsToCheck.push({ orderId: item.id, comment: prevComment });
        }
      }
      const batchCheck =
        commentsToCheck.length > 0
          ? await this.tonWalletService.checkCommentsInBatch(commentsToCheck)
          : {
              results: new Map<string, { txHash: string; timestamp: number }>(),
              exhaustive: true,
            };
      const blockchainMatches = batchCheck.results;

      let resolved = 0;
      for (const item of itemsWithoutHash) {
        try {
          if (!item.ton_comment) continue;

          const blockchainCheck = blockchainMatches.get(item.id);

          if (blockchainCheck && blockchainCheck.txHash) {
            await this.prisma.fragmentQueue.update({
              where: { id: item.id },
              data: {
                tx_hash: blockchainCheck.txHash,
                updated_at: new Date(),
              },
            });

            await this.redisLock.markQueueItemCompleted(
              item.id,
              blockchainCheck.txHash,
            );

            resolved++;
            this.logger.log(
              `Resolved tx_hash for order ${item.id} (payment #${item.payment?.order_number || '?'}): ${blockchainCheck.txHash}`,
            );
          } else {
            const ageMinutes = Math.round(
              (Date.now() - item.updated_at.getTime()) / 60000,
            );
            this.logger.debug(
              `Could not find blockchain tx for order ${item.id} (age: ${ageMinutes}min), will retry later`,
            );
          }
        } catch (error: any) {
          this.logger.error(
            `Error resolving tx_hash for order ${item.id}: ${error.message}`,
          );
        }
      }

      if (resolved > 0) {
        this.logger.log(
          `Resolved tx_hash for ${resolved}/${itemsWithoutHash.length} orders`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error in resolveMissingTxHashes cron: ${error.message}`,
      );
    }
  }

  @Cron('0 */2 * * * *')
  async checkPendingOrdersOnWalletTopUp(): Promise<void> {
    if (!this.isWalletLeader) {
      return;
    }

    try {
      const walletBalance = parseFloat(
        await this.tonWalletService.getBalance(),
      );

      if (walletBalance <= 0) {
        return;
      }

      if (
        this.insufficientBalanceUntil > 0 &&
        walletBalance > this.lastKnownInsufficientBalance
      ) {
        this.logger.log(
          `Wallet balance increased: ${walletBalance.toFixed(4)} TON (was ${this.lastKnownInsufficientBalance.toFixed(4)} TON). Resetting insufficient balance cooldown.`,
        );
        this.insufficientBalanceUntil = 0;
        this.lastKnownInsufficientBalance = 0;
      }

      const pendingItems = await this.prisma.fragmentQueue.findMany({
        where: { status: 'PENDING' },
        orderBy: { created_at: 'asc' },
        take: this.BATCH_SIZE,
        include: {
          user: {
            select: {
              telegram_id: true,
              username: true,
              first_name: true,
            },
          },
          payment: {
            select: {
              id: true,
              order_number: true,
              payment_message_id: true,
            },
          },
        },
      });

      if (pendingItems.length === 0) {
        return;
      }

      this.logger.log(
        `Checking ${pendingItems.length} pending orders after wallet top-up`,
      );

      await this.processQueueNow();
    } catch (error: any) {
      this.logger.error(
        `Error checking pending orders on wallet top-up: ${error.message}`,
      );
    }
  }
}
