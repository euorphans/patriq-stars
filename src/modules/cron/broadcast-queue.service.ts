import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { EventLoopMonitorService } from '@/modules/health/event-loop-monitor.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Input, Markup } from 'telegraf';

interface BroadcastCreateInput {
  adminTelegramId: string;
  adminChatId: string;
  progressMessageId?: number;
  message: string;
  photo?: string;
  animation?: string;
  video?: string;
  sticker?: string;
  audio?: string;
  entities?: any[];
  captionEntities?: any[];
  buttons?: Array<{ text: string; url: string }>;
  targetAudience?: 'all' | 'premium' | 'non_premium';
}

@Injectable()
export class BroadcastQueueService implements OnModuleInit {
  private readonly logger = new Logger(BroadcastQueueService.name);

  private readonly LOCK_ID = 'broadcast-queue-processor';
  private readonly LOCK_TTL_SECONDS = 60;
  private readonly LOCK_RENEW_INTERVAL_MS = 20_000;

  private readonly BATCH_SIZE = 30;
  private readonly BATCH_DELAY_MS = 100;
  private readonly USERS_PAGE_SIZE = 5000;
  private readonly DB_SAVE_INTERVAL = 500;

  private isProcessing = false;
  private lockRenewTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly eventLoopMonitor: EventLoopMonitorService,
    @InjectBot() private readonly bot: Telegraf,
    @InjectBot('admin') private readonly adminBot: Telegraf,
  ) {}

  /**
   * В production рассылку по умолчанию ведёт отдельный инстанс (ENABLE_BROADCAST=true).
   * В dev / любой non-production очередь обрабатывается этим же процессом, если явно не выключено.
   */
  private isBroadcastWorkerEnabled(): boolean {
    if (process.env.ENABLE_BROADCAST === 'true') return true;
    if (process.env.ENABLE_BROADCAST === 'false') return false;
    return process.env.NODE_ENV !== 'production';
  }

  async onModuleInit() {
    if (!this.isBroadcastWorkerEnabled()) return;
    if (
      process.env.NODE_ENV !== 'production' &&
      process.env.ENABLE_BROADCAST !== 'true'
    ) {
      this.logger.log(
        'Broadcast queue: processing enabled in non-production without ENABLE_BROADCAST (same process as API)',
      );
    }
    await this.recoverStaleProcessing();
  }

  private async recoverStaleProcessing(): Promise<void> {
    try {
      const stale = await this.prisma.broadcastQueue.updateMany({
        where: {
          status: 'PROCESSING',
          locked_at: {
            lt: new Date(Date.now() - this.LOCK_TTL_SECONDS * 2 * 1000),
          },
        },
        data: {
          status: 'PENDING',
          locked_by: null,
          locked_at: null,
        },
      });

      if (stale.count > 0) {
        this.logger.warn(
          `Recovered ${stale.count} stale broadcast(s) from PROCESSING to PENDING`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Error recovering stale broadcasts: ${error.message}`);
    }
  }

  async getActiveBroadcast(): Promise<any | null> {
    return this.prisma.broadcastQueue.findFirst({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { created_at: 'asc' },
    });
  }

  async stopBroadcast(broadcastId: string): Promise<void> {
    await this.prisma.broadcastQueue.update({
      where: { id: broadcastId },
      data: { status: 'CANCELLED' },
    });
    this.logger.log(`Broadcast ${broadcastId} manually stopped by admin`);
  }

  async queueBroadcast(input: BroadcastCreateInput): Promise<string> {
    const existing = await this.prisma.broadcastQueue.findFirst({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      select: { id: true, created_at: true },
    });

    if (existing) {
      throw new Error(
        `Рассылка уже выполняется (ID: ${existing.id}). Дождитесь завершения.`,
      );
    }

    const broadcast = await this.prisma.broadcastQueue.create({
      data: {
        admin_telegram_id: input.adminTelegramId,
        admin_chat_id: input.adminChatId,
        progress_message_id: input.progressMessageId,
        message: input.message,
        photo: input.photo,
        animation: input.animation,
        video: input.video,
        sticker: input.sticker,
        audio: input.audio,
        entities: input.entities ?? undefined,
        caption_entities: input.captionEntities ?? undefined,
        buttons: input.buttons ?? undefined,
        target_audience: input.targetAudience ?? 'all',
        status: 'PENDING',
      },
    });

    this.logger.log(
      `Broadcast ${broadcast.id} queued by admin ${input.adminTelegramId}`,
    );

    return broadcast.id;
  }

  @Cron('*/20 * * * * *')
  async processBroadcastQueue(): Promise<void> {
    if (!this.isBroadcastWorkerEnabled()) return;
    if (this.isProcessing) return;
    if (this.eventLoopMonitor.isOverloaded()) return;

    const acquired = await this.acquireLock();
    if (!acquired) return;

    this.isProcessing = true;
    this.startLockRenewal();

    try {
      const broadcast = await this.prisma.broadcastQueue.findFirst({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { created_at: 'asc' },
      });

      if (!broadcast) return;

      await this.prisma.broadcastQueue.update({
        where: { id: broadcast.id },
        data: {
          status: 'PROCESSING',
          locked_by: this.redisLock.getInstanceId(),
          locked_at: new Date(),
        },
      });

      this.logger.log(
        `Processing broadcast ${broadcast.id} (resuming from offset ${broadcast.processed_users})`,
      );

      this.cachedPhotoFileId = null;

      try {
        await this.executeBroadcast(broadcast);
      } catch (execError: any) {
        this.logger.error(
          `Broadcast ${broadcast.id} execution error: ${execError.message}`,
        );

        try {
          await this.prisma.broadcastQueue.update({
            where: { id: broadcast.id },
            data: {
              error: execError.message?.slice(0, 500) || 'Unknown error',
              locked_by: null,
              locked_at: null,
            },
          });

          if (broadcast.admin_chat_id) {
            await this.adminBot.telegram
              .sendMessage(
                broadcast.admin_chat_id,
                `⚠️ Ошибка рассылки: ${execError.message?.slice(0, 200) || 'Неизвестная ошибка'}\n\nРассылка будет автоматически возобновлена.`,
              )
              .catch(() => {});
          }
        } catch {}
      }
    } catch (error: any) {
      this.logger.error(`Broadcast queue processor error: ${error.message}`);
    } finally {
      this.stopLockRenewal();
      this.isProcessing = false;
      await this.releaseLock();
    }
  }

  private async executeBroadcast(broadcast: any): Promise<void> {
    let { processed_users, success_count, failed_count, last_user_cursor } =
      broadcast;

    const message = broadcast.message;
    const photo = broadcast.photo as string | null;
    const animation = broadcast.animation as string | null;
    const video = broadcast.video as string | null;
    const sticker = broadcast.sticker as string | null;
    const audio = broadcast.audio as string | null;
    const entities = broadcast.entities as any[] | null;
    const captionEntities = broadcast.caption_entities as any[] | null;
    const buttons =
      (broadcast.buttons as Array<{
        text: string;
        url: string;
      }>) || [];

    const audienceFilter = this.buildAudienceFilter(
      broadcast.target_audience ?? 'all',
    );

    if (broadcast.total_users === 0) {
      const totalUsers = await this.prisma.user.count({
        where: audienceFilter,
      });

      await this.prisma.broadcastQueue.update({
        where: { id: broadcast.id },
        data: { total_users: totalUsers },
      });

      broadcast.total_users = totalUsers;

      await this.updateProgress(broadcast, 0, 0, 0);
    }

    let photoSource: any = null;
    if (photo) {
      photoSource = await this.preparePhotoSource(photo);
    }

    let animationSource: any = null;
    if (animation) {
      animationSource = await this.preparePhotoSource(animation);
    }

    let videoSource: any = null;
    if (video) {
      videoSource = await this.preparePhotoSource(video);
    }

    let stickerSource: any = null;
    if (sticker) {
      stickerSource = sticker;
    }

    let audioSource: any = null;
    if (audio) {
      audioSource = await this.preparePhotoSource(audio);
    }

    let replyMarkup: any = undefined;
    if (buttons.length > 0) {
      const keyboardButtons = buttons.map((button) => [
        Markup.button.url(button.text, button.url),
      ]);
      replyMarkup = Markup.inlineKeyboard(keyboardButtons).reply_markup;
    }

    let cursor: string | undefined = last_user_cursor ?? undefined;
    let hasMore = true;

    if (
      (photoSource || animationSource || videoSource || audioSource) &&
      !this.cachedPhotoFileId &&
      !cursor
    ) {
      const firstUser = await this.prisma.user.findFirst({
        where: audienceFilter,
        select: { id: true, telegram_id: true },
        orderBy: { id: 'asc' },
      });

      if (firstUser) {
        const result = await this.sendToOne(
          firstUser.telegram_id,
          message,
          photoSource,
          animationSource,
          videoSource,
          stickerSource,
          audioSource,
          entities,
          captionEntities,
          replyMarkup,
        );

        if (result === 'ok') success_count++;
        else if (result === 'blocked') failed_count++;

        processed_users = 1;
        cursor = firstUser.id;

        await this.safeDbUpdate(broadcast.id, {
          processed_users,
          success_count,
          failed_count,
          last_user_cursor: cursor,
          locked_at: new Date(),
        });

        if (this.cachedPhotoFileId) {
          this.logger.log(
            'Photo/animation file_id cached after first send, switching to fast mode',
          );
        }
      }
    }

    let lastDbSaveAt = processed_users;

    while (hasMore) {
      const freshStatus = await this.prisma.broadcastQueue.findUnique({
        where: { id: broadcast.id },
        select: { status: true },
      });
      if (freshStatus?.status === 'CANCELLED') {
        this.logger.log(`Broadcast ${broadcast.id} was cancelled, stopping`);
        return;
      }

      const users = await this.prisma.user.findMany({
        where: audienceFilter,
        select: { id: true, telegram_id: true },
        orderBy: { id: 'asc' },
        take: this.USERS_PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (users.length === 0) {
        hasMore = false;
        break;
      }

      for (let i = 0; i < users.length; i += this.BATCH_SIZE) {
        const batch = users.slice(i, i + this.BATCH_SIZE);

        const waitMs = this.rateLimitedUntil - Date.now();
        if (waitMs > 0) {
          this.logger.warn(
            `Rate limit active, waiting ${Math.ceil(waitMs / 1000)}s before next batch`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          this.rateLimitLogged = false;
        }

        const sendPromises: Promise<
          'ok' | 'blocked' | 'ratelimit' | 'error'
        >[] = [];

        for (let j = 0; j < batch.length; j++) {
          if (this.rateLimitedUntil > Date.now()) {
            break;
          }

          sendPromises.push(
            this.sendToOne(
              batch[j].telegram_id,
              message,
              photoSource,
              animationSource,
              videoSource,
              stickerSource,
              audioSource,
              entities,
              captionEntities,
              replyMarkup,
            ),
          );
        }

        const results = await Promise.allSettled(sendPromises);
        const batchProcessed = results.length;

        let rateLimitHit = false;
        let rateLimitedFromIndex = batchProcessed;

        results.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            if (result.value === 'ok') {
              success_count++;
            } else if (result.value === 'blocked') {
              failed_count++;
            } else if (result.value === 'ratelimit') {
              rateLimitHit = true;
              rateLimitedFromIndex = Math.min(rateLimitedFromIndex, idx);
            }
          } else {
            failed_count++;
          }
        });

        const effectiveProcessed = rateLimitHit
          ? rateLimitedFromIndex
          : batchProcessed;
        processed_users += effectiveProcessed;
        cursor =
          effectiveProcessed > 0 ? batch[effectiveProcessed - 1].id : cursor;

        if (rateLimitHit) {
          await this.safeDbUpdate(broadcast.id, {
            processed_users,
            success_count,
            failed_count,
            last_user_cursor: cursor,
            locked_at: new Date(),
          });
          lastDbSaveAt = processed_users;
          await this.updateProgress(
            broadcast,
            processed_users,
            success_count,
            failed_count,
          );
          const pauseMs = this.rateLimitedUntil - Date.now();
          if (pauseMs > 0) {
            await new Promise((r) => setTimeout(r, pauseMs));
          }
        }

        const shouldSaveToDb =
          processed_users - lastDbSaveAt >= this.DB_SAVE_INTERVAL ||
          processed_users >= broadcast.total_users;

        if (shouldSaveToDb) {
          await this.safeDbUpdate(broadcast.id, {
            processed_users,
            success_count,
            failed_count,
            last_user_cursor: cursor,
            locked_at: new Date(),
          });
          lastDbSaveAt = processed_users;

          await this.updateProgress(
            broadcast,
            processed_users,
            success_count,
            failed_count,
          );
        }

        await this.redisLock.extendLock(this.LOCK_ID, this.LOCK_TTL_SECONDS);

        if (i + this.BATCH_SIZE < users.length) {
          await new Promise((r) => setTimeout(r, this.BATCH_DELAY_MS));
        }
      }

      if (users.length < this.USERS_PAGE_SIZE) {
        hasMore = false;
      } else {
        await new Promise((r) => setTimeout(r, this.BATCH_DELAY_MS));
      }
    }

    await this.safeDbUpdate(broadcast.id, {
      status: 'COMPLETED',
      processed_users,
      success_count,
      failed_count,
      locked_by: null,
      locked_at: null,
    });

    await this.updateProgress(
      broadcast,
      processed_users,
      success_count,
      failed_count,
      true,
    );

    this.logger.log(
      `Broadcast ${broadcast.id} completed: ${broadcast.total_users} total, ${success_count} sent, ${failed_count} failed`,
    );
  }

  private buildAudienceFilter(audience: string): Record<string, any> {
    const base: Record<string, any> = {
      is_ban: false,
      is_bot_blocked: false,
    };
    if (audience === 'premium') {
      base.is_premium = true;
    } else if (audience === 'non_premium') {
      base.is_premium = false;
    }
    return base;
  }

  private formatBroadcastAudienceLabel(
    audience: string | null | undefined,
  ): string {
    const a = audience ?? 'all';
    if (a === 'premium') return '⭐ Premium';
    if (a === 'non_premium') return '👤 Без Premium';
    return '👥 Все';
  }

  private cachedPhotoFileId: string | null = null;
  private rateLimitedUntil = 0;
  private rateLimitLogged = false;

  private async sendToOne(
    telegramId: string,
    message: string,
    photoSource: any,
    animationSource: any,
    videoSource: any,
    stickerSource: any,
    audioSource: any,
    entities: any[] | null,
    captionEntities: any[] | null,
    replyMarkup: any,
  ): Promise<'ok' | 'blocked' | 'ratelimit' | 'error'> {
    try {
      if (photoSource) {
        const photoOptions: any = {
          caption: message,
        };
        if (captionEntities && captionEntities.length > 0) {
          photoOptions.caption_entities = captionEntities;
        }
        if (replyMarkup) {
          photoOptions.reply_markup = replyMarkup;
        }

        const photoToSend = this.cachedPhotoFileId || photoSource;

        const sentMessage = await this.bot.telegram.sendPhoto(
          telegramId,
          photoToSend,
          photoOptions,
        );

        if (!this.cachedPhotoFileId && sentMessage?.photo?.length > 0) {
          this.cachedPhotoFileId =
            sentMessage.photo[sentMessage.photo.length - 1].file_id;
          this.logger.log(
            `Cached photo file_id for broadcast: ${this.cachedPhotoFileId.slice(0, 30)}...`,
          );
        }
      } else if (animationSource) {
        const animationOptions: any = {
          caption: message,
        };
        if (captionEntities && captionEntities.length > 0) {
          animationOptions.caption_entities = captionEntities;
        }
        if (replyMarkup) {
          animationOptions.reply_markup = replyMarkup;
        }

        const animationToSend = this.cachedPhotoFileId || animationSource;

        const sentMessage = await this.bot.telegram.sendAnimation(
          telegramId,
          animationToSend,
          animationOptions,
        );

        if (!this.cachedPhotoFileId && sentMessage?.animation?.file_id) {
          this.cachedPhotoFileId = sentMessage.animation.file_id;
          this.logger.log(
            `Cached animation file_id for broadcast: ${this.cachedPhotoFileId.slice(0, 30)}...`,
          );
        }
      } else if (videoSource) {
        const videoOptions: any = {
          caption: message,
        };
        if (captionEntities && captionEntities.length > 0) {
          videoOptions.caption_entities = captionEntities;
        }
        if (replyMarkup) {
          videoOptions.reply_markup = replyMarkup;
        }

        const videoToSend = this.cachedPhotoFileId || videoSource;

        const sentMessage = await this.bot.telegram.sendVideo(
          telegramId,
          videoToSend,
          videoOptions,
        );

        if (!this.cachedPhotoFileId && sentMessage?.video?.file_id) {
          this.cachedPhotoFileId = sentMessage.video.file_id;
          this.logger.log(
            `Cached video file_id for broadcast: ${this.cachedPhotoFileId.slice(0, 30)}...`,
          );
        }
      } else if (stickerSource) {
        const stickerToSend = this.cachedPhotoFileId || stickerSource;
        const sentMessage = await this.bot.telegram.sendSticker(
          telegramId,
          stickerToSend,
        );
        if (!this.cachedPhotoFileId && sentMessage?.sticker?.file_id) {
          this.cachedPhotoFileId = sentMessage.sticker.file_id;
          this.logger.log(
            `Cached sticker file_id for broadcast: ${this.cachedPhotoFileId.slice(0, 30)}...`,
          );
        }
      } else if (audioSource) {
        const audioOptions: any = {
          caption: message,
        };
        if (captionEntities && captionEntities.length > 0) {
          audioOptions.caption_entities = captionEntities;
        }
        if (replyMarkup) {
          audioOptions.reply_markup = replyMarkup;
        }

        const audioToSend = this.cachedPhotoFileId || audioSource;

        const sentMessage = await this.bot.telegram.sendAudio(
          telegramId,
          audioToSend,
          audioOptions,
        );

        if (!this.cachedPhotoFileId && sentMessage?.audio?.file_id) {
          this.cachedPhotoFileId = sentMessage.audio.file_id;
          this.logger.log(
            `Cached audio file_id for broadcast: ${this.cachedPhotoFileId.slice(0, 30)}...`,
          );
        }
      } else {
        const messageOptions: any = {};
        if (entities && entities.length > 0) {
          messageOptions.entities = entities;
        }
        if (replyMarkup) {
          messageOptions.reply_markup = replyMarkup;
        }
        await this.bot.telegram.sendMessage(
          telegramId,
          message,
          messageOptions,
        );
      }
      return 'ok';
    } catch (err: any) {
      const errorCode = err.response?.error_code;
      const description = err.response?.description || err.message || '';

      if (errorCode === 429) {
        const retryAfter = err.response.parameters?.retry_after ?? 30;
        const newLimit = Date.now() + retryAfter * 1000;
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, newLimit);
        if (!this.rateLimitLogged) {
          this.rateLimitLogged = true;
          this.logger.warn(
            `Broadcast rate limited (429), pausing for ${retryAfter}s`,
          );
        }
        return 'ratelimit';
      }

      const isBotBlocked =
        errorCode === 403 ||
        description.includes('bot blocked by user') ||
        description.includes('bot was kicked') ||
        description.includes("bot can't initiate conversation") ||
        description.includes('bot is not a member') ||
        description.includes('user is deactivated') ||
        description.includes('chat not found') ||
        description.includes('PEER_ID_INVALID') ||
        description.includes('user not found') ||
        description.includes('group is deactivated');

      if (isBotBlocked) {
        this.logger.debug(
          `User ${telegramId} blocked bot: [${errorCode}] ${description}`,
        );
        await this.prisma.user
          .updateMany({
            where: { telegram_id: telegramId },
            data: { is_bot_blocked: true },
          })
          .catch(() => {});
        return 'blocked';
      }

      this.logger.warn(
        `Temporary error sending to ${telegramId}: [${errorCode}] ${description}`,
      );
      return 'error';
    }
  }

  private async preparePhotoSource(photo: string): Promise<any> {
    if (photo.length > 100 && !photo.startsWith('AgAC')) {
      try {
        const buffer = Buffer.from(photo, 'base64');
        this.logger.log(`Using base64 photo, size: ${buffer.length} bytes`);
        return Input.fromBuffer(buffer);
      } catch (error: any) {
        this.logger.error(`Failed to decode base64 photo: ${error.message}`);
        return null;
      }
    }

    try {
      const fileLink = await this.bot.telegram.getFileLink(photo);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());
      this.logger.log(
        `Photo downloaded successfully, size: ${buffer.length} bytes`,
      );
      return Input.fromBuffer(buffer);
    } catch (error: any) {
      this.logger.error(`Failed to download photo: ${error.message}`);
      return photo;
    }
  }

  private async updateProgress(
    broadcast: any,
    processed: number,
    success: number,
    failed: number,
    isComplete = false,
  ): Promise<void> {
    if (!broadcast.progress_message_id || !broadcast.admin_chat_id) return;

    const total = broadcast.total_users;
    const percentage =
      total > 0 ? ((processed / total) * 100).toFixed(1) : '0.0';

    const aud = this.formatBroadcastAudienceLabel(broadcast.target_audience);
    let progressText: string;
    if (processed === 0) {
      progressText = `📢 Начало рассылки (${aud}): ${processed} из ${total} (${percentage}%)`;
    } else if (isComplete) {
      progressText = `✅ Готово (${aud}): ${processed} из ${total} (${percentage}%)\n✅ Успешно: ${success}\n❌ Не доставлено: ${failed}`;
    } else {
      progressText = `📤 Рассылка (${aud}): ${processed} из ${total} (${percentage}%)\n✅ Успешно: ${success}\n❌ Не доставлено: ${failed}`;
    }

    try {
      await this.adminBot.telegram.editMessageText(
        broadcast.admin_chat_id,
        broadcast.progress_message_id,
        undefined,
        progressText,
      );
    } catch (editError: any) {
      if (!editError.message?.includes('message is not modified')) {
        this.logger.warn(
          `Failed to update broadcast progress message: ${editError.message}`,
        );
      }
    }
  }

  private async safeDbUpdate(
    broadcastId: string,
    data: Record<string, any>,
    retries = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.prisma.broadcastQueue.update({
          where: { id: broadcastId },
          data,
        });
        return;
      } catch (error: any) {
        const isTransient =
          error.message?.includes('Too many database connections') ||
          error.message?.includes('Connection reset') ||
          error.message?.includes('Connection pool timeout') ||
          error.code === 'P2024';

        if (isTransient && attempt < retries) {
          this.logger.warn(
            `DB connection error on attempt ${attempt}/${retries}, retrying in ${attempt * 2}s...`,
          );
          await new Promise((r) => setTimeout(r, attempt * 2000));
        } else {
          throw error;
        }
      }
    }
  }

  private async acquireLock(): Promise<boolean> {
    if (this.redisLock.isAvailable()) {
      return this.redisLock.acquireLock(this.LOCK_ID, this.LOCK_TTL_SECONDS);
    }
    return this.acquireDbLock();
  }

  private async releaseLock(): Promise<void> {
    if (this.redisLock.isAvailable()) {
      await this.redisLock.releaseLock(this.LOCK_ID);
    } else {
      await this.releaseDbLock();
    }
  }

  private startLockRenewal(): void {
    this.lockRenewTimer = setInterval(async () => {
      if (this.redisLock.isAvailable()) {
        await this.redisLock.extendLock(this.LOCK_ID, this.LOCK_TTL_SECONDS);
      } else {
        await this.renewDbLock();
      }
    }, this.LOCK_RENEW_INTERVAL_MS);
  }

  private stopLockRenewal(): void {
    if (this.lockRenewTimer) {
      clearInterval(this.lockRenewTimer);
      this.lockRenewTimer = null;
    }
  }

  private async acquireDbLock(): Promise<boolean> {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.LOCK_TTL_SECONDS * 1000);
      const instanceId = this.redisLock.getInstanceId();

      return await this.prisma.$transaction(async (tx) => {
        const existingLock = await tx.distributedLock.findUnique({
          where: { id: this.LOCK_ID },
        });

        if (existingLock) {
          if (
            existingLock.expires_at > now &&
            existingLock.locked_by !== instanceId
          ) {
            return false;
          }

          await tx.distributedLock.update({
            where: { id: this.LOCK_ID },
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
            id: this.LOCK_ID,
            locked_by: instanceId,
            locked_at: now,
            expires_at: expiresAt,
          },
        });
        return true;
      });
    } catch (error: any) {
      if (error.code === 'P2002') return false;
      this.logger.error(`Error acquiring DB lock: ${error.message}`);
      return false;
    }
  }

  private async releaseDbLock(): Promise<void> {
    try {
      const instanceId = this.redisLock.getInstanceId();
      await this.prisma.distributedLock.deleteMany({
        where: {
          id: this.LOCK_ID,
          locked_by: instanceId,
        },
      });
    } catch (error: any) {
      this.logger.error(`Error releasing DB lock: ${error.message}`);
    }
  }

  private async renewDbLock(): Promise<void> {
    try {
      const instanceId = this.redisLock.getInstanceId();
      const expiresAt = new Date(Date.now() + this.LOCK_TTL_SECONDS * 1000);

      await this.prisma.distributedLock.updateMany({
        where: {
          id: this.LOCK_ID,
          locked_by: instanceId,
        },
        data: {
          expires_at: expiresAt,
        },
      });
    } catch (error: any) {
      this.logger.error(`Error renewing DB lock: ${error.message}`);
    }
  }
}
