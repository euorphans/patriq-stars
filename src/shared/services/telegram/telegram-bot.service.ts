import { Logger, OnModuleInit } from '@nestjs/common';
import { Telegraf, Input, Markup } from 'telegraf';
import { PrismaService } from '@/shared/services/prisma/prisma.service';

interface QueuedMessage {
  chatId: string | number;
  message: string;
  options?: any;
  photo?: string;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

export abstract class TelegramBotService implements OnModuleInit {
  protected readonly logger: Logger;

  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue = false;
  private readonly QUEUE_PROCESS_INTERVAL = 50;

  constructor(
    protected readonly bot: Telegraf,
    protected readonly prisma: PrismaService,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  async onModuleInit() {
    this.startQueueProcessor();
  }

  private startQueueProcessor(): void {
    setInterval(async () => {
      if (this.isProcessingQueue || this.messageQueue.length === 0) {
        return;
      }

      this.isProcessingQueue = true;

      try {
        const message = this.messageQueue.shift();
        if (!message) return;

        try {
          let result;
          if (message.photo) {
            const photoOptions = {
              caption: message.message,
              ...message.options,
            };
            result = await this.bot.telegram.sendPhoto(
              message.chatId,
              message.photo,
              photoOptions,
            );
          } else {
            result = await this.bot.telegram.sendMessage(
              message.chatId,
              message.message,
              message.options,
            );
          }
          message.resolve(result);
        } catch (error: any) {
          if (error.response?.error_code === 429) {
            const retryAfter = error.response.parameters?.retry_after || 1;
            this.logger.warn(`Rate limited, retrying after ${retryAfter}s`);

            this.messageQueue.unshift(message);
            await new Promise((resolve) =>
              setTimeout(resolve, retryAfter * 1000),
            );
          } else {
            message.reject(error);
          }
        }
      } finally {
        this.isProcessingQueue = false;
      }
    }, this.QUEUE_PROCESS_INTERVAL);
  }

  async queueMessage(
    chatId: string | number,
    message: string,
    options?: any,
    photo?: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        chatId,
        message,
        options,
        photo,
        resolve,
        reject,
      });
    });
  }

  getQueueLength(): number {
    return this.messageQueue.length;
  }

  async broadcastToAllUsers(
    message: string,
    options: {
      parse_mode?: 'HTML' | 'Markdown';
      photo?: string;
      animation?: string;
      video?: string;
      sticker?: string;
      audio?: string;
      testMode?: boolean;
      testRecipients?: { telegram_id: string }[];
      entities?: any[];
      caption_entities?: any[];
      buttons?: Array<{ text: string; url: string }>;
      onProgress?: (stats: {
        total: number;
        processed: number;
        success: number;
        failed: number;
      }) => Promise<void>;
      progressInterval?: number;
    } = {},
  ): Promise<{ total: number; success: number; failed: number }> {
    let users: { telegram_id: string }[];
    if (options.testRecipients) {
      users = options.testRecipients;
    } else {
      users = [];
      const PAGE_SIZE = 5000;
      let cursor: string | undefined;
      while (true) {
        const batch = await this.prisma.user.findMany({
          where: { is_ban: false },
          select: { id: true, telegram_id: true },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        if (batch.length === 0) break;
        users.push(...batch);
        cursor = batch[batch.length - 1].id;
        if (batch.length < PAGE_SIZE) break;
      }
    }

    let success = 0;
    let failed = 0;
    const BATCH_SIZE = 30;
    const BATCH_DELAY_MS = 1050;

    let photoSource: any = null;
    if (options.photo) {
      if (options.photo.length > 100 && !options.photo.startsWith('AgAC')) {
        try {
          const buffer = Buffer.from(options.photo, 'base64');
          photoSource = Input.fromBuffer(buffer);
          this.logger.log(`Using base64 photo, size: ${buffer.length} bytes`);
        } catch (error: any) {
          this.logger.error(`Failed to decode base64 photo: ${error.message}`);
        }
      } else {
        try {
          const fileLink = await this.bot.telegram.getFileLink(options.photo);
          const response = await fetch(fileLink.href);
          const buffer = Buffer.from(await response.arrayBuffer());
          photoSource = Input.fromBuffer(buffer);
          this.logger.log(
            `Photo downloaded successfully, size: ${buffer.length} bytes`,
          );
        } catch (error: any) {
          this.logger.error(`Failed to download photo: ${error.message}`);

          photoSource = options.photo;
        }
      }
    }

    let animationSource: any = null;
    if (options.animation) {
      if (
        options.animation.length > 100 &&
        !options.animation.startsWith('CgAC')
      ) {
        try {
          const buffer = Buffer.from(options.animation, 'base64');
          animationSource = Input.fromBuffer(buffer);
          this.logger.log(
            `Using base64 animation, size: ${buffer.length} bytes`,
          );
        } catch (error: any) {
          this.logger.error(
            `Failed to decode base64 animation: ${error.message}`,
          );
        }
      } else {
        try {
          const fileLink = await this.bot.telegram.getFileLink(
            options.animation,
          );
          const response = await fetch(fileLink.href);
          const buffer = Buffer.from(await response.arrayBuffer());
          animationSource = Input.fromBuffer(buffer);
          this.logger.log(
            `Animation downloaded successfully, size: ${buffer.length} bytes`,
          );
        } catch (error: any) {
          this.logger.error(`Failed to download animation: ${error.message}`);
          animationSource = options.animation;
        }
      }
    }

    let videoSource: any = null;
    if (options.video) {
      if (options.video.length > 100) {
        try {
          const buffer = Buffer.from(options.video, 'base64');
          videoSource = Input.fromBuffer(buffer);
          this.logger.log(`Using base64 video, size: ${buffer.length} bytes`);
        } catch (error: any) {
          this.logger.error(`Failed to decode base64 video: ${error.message}`);
        }
      } else {
        try {
          const fileLink = await this.bot.telegram.getFileLink(options.video);
          const response = await fetch(fileLink.href);
          const buffer = Buffer.from(await response.arrayBuffer());
          videoSource = Input.fromBuffer(buffer);
          this.logger.log(
            `Video downloaded successfully, size: ${buffer.length} bytes`,
          );
        } catch (error: any) {
          this.logger.error(`Failed to download video: ${error.message}`);
          videoSource = options.video;
        }
      }
    }

    const stickerSource: string | null = options.sticker || null;

    let audioSource: any = null;
    if (options.audio) {
      if (options.audio.length > 100) {
        try {
          const buffer = Buffer.from(options.audio, 'base64');
          audioSource = Input.fromBuffer(buffer);
          this.logger.log(`Using base64 audio, size: ${buffer.length} bytes`);
        } catch (error: any) {
          this.logger.error(`Failed to decode base64 audio: ${error.message}`);
        }
      } else {
        try {
          const fileLink = await this.bot.telegram.getFileLink(options.audio);
          const response = await fetch(fileLink.href);
          const buffer = Buffer.from(await response.arrayBuffer());
          audioSource = Input.fromBuffer(buffer);
          this.logger.log(
            `Audio downloaded successfully, size: ${buffer.length} bytes`,
          );
        } catch (error: any) {
          this.logger.error(`Failed to download audio: ${error.message}`);
          audioSource = options.audio;
        }
      }
    }

    let replyMarkup = undefined;
    if (options.buttons && options.buttons.length > 0) {
      const keyboardButtons = options.buttons.map((button) => [
        Markup.button.url(button.text, button.url),
      ]);
      replyMarkup = Markup.inlineKeyboard(keyboardButtons).reply_markup;
    }

    const sendToOne = async (telegramId: string): Promise<boolean> => {
      try {
        if (photoSource) {
          const photoOptions: any = {
            caption: message,
          };
          if (options.caption_entities && options.caption_entities.length > 0) {
            photoOptions.caption_entities = options.caption_entities;
          } else if (options.parse_mode) {
            photoOptions.parse_mode = options.parse_mode;
          }
          if (replyMarkup) {
            photoOptions.reply_markup = replyMarkup;
          }
          await this.bot.telegram.sendPhoto(
            telegramId,
            photoSource,
            photoOptions,
          );
        } else if (animationSource) {
          const animationOptions: any = {
            caption: message,
          };
          if (options.caption_entities && options.caption_entities.length > 0) {
            animationOptions.caption_entities = options.caption_entities;
          } else if (options.parse_mode) {
            animationOptions.parse_mode = options.parse_mode;
          }
          if (replyMarkup) {
            animationOptions.reply_markup = replyMarkup;
          }
          await this.bot.telegram.sendAnimation(
            telegramId,
            animationSource,
            animationOptions,
          );
        } else if (videoSource) {
          const videoOptions: any = {
            caption: message,
          };
          if (options.caption_entities && options.caption_entities.length > 0) {
            videoOptions.caption_entities = options.caption_entities;
          } else if (options.parse_mode) {
            videoOptions.parse_mode = options.parse_mode;
          }
          if (replyMarkup) {
            videoOptions.reply_markup = replyMarkup;
          }
          await this.bot.telegram.sendVideo(
            telegramId,
            videoSource,
            videoOptions,
          );
        } else if (stickerSource) {
          await this.bot.telegram.sendSticker(telegramId, stickerSource);
        } else if (audioSource) {
          const audioOptions: any = {
            caption: message,
          };
          if (options.caption_entities && options.caption_entities.length > 0) {
            audioOptions.caption_entities = options.caption_entities;
          } else if (options.parse_mode) {
            audioOptions.parse_mode = options.parse_mode;
          }
          if (replyMarkup) {
            audioOptions.reply_markup = replyMarkup;
          }
          await this.bot.telegram.sendAudio(
            telegramId,
            audioSource,
            audioOptions,
          );
        } else {
          const messageOptions: any = {};
          if (options.entities && options.entities.length > 0) {
            messageOptions.entities = options.entities;
          } else if (options.parse_mode) {
            messageOptions.parse_mode = options.parse_mode;
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
        return true;
      } catch (err: any) {
        if (err.response?.error_code === 429) {
          const retryAfter = err.response.parameters?.retry_after ?? 1;
          this.logger.warn(
            `Broadcast rate limited (429), waiting ${retryAfter}s before retry`,
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          return sendToOne(telegramId);
        }

        return false;
      }
    };

    if (options.onProgress) {
      await options.onProgress({
        total: users.length,
        processed: 0,
        success: 0,
        failed: 0,
      });
    }

    this.logger.log(
      `[BROADCAST] Starting broadcast to ${users.length} users (batch size: ${BATCH_SIZE})`,
    );

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map((user) => sendToOne(user.telegram_id)),
      );

      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value === true) {
          success++;
        } else {
          failed++;
        }
      });

      const processed = Math.min(i + BATCH_SIZE, users.length);

      if (processed % 500 === 0 || processed === users.length) {
        this.logger.log(
          `[BROADCAST] ${processed}/${users.length} (${((processed / users.length) * 100).toFixed(1)}%) - success: ${success}, failed: ${failed}`,
        );
      }

      if (options.onProgress) {
        await options.onProgress({
          total: users.length,
          processed,
          success,
          failed,
        });
      }

      if (i + BATCH_SIZE < users.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    this.logger.log(
      `[BROADCAST] Completed: ${users.length} total, ${success} sent, ${failed} failed`,
    );

    return {
      total: users.length,
      success,
      failed,
    };
  }

  async sendNotificationToChannel(
    channelId: string,
    message: string,
    options: {
      parse_mode?: 'HTML' | 'Markdown';
      photo?: string;
    } = {},
  ): Promise<void> {
    try {
      if (options.photo) {
        await this.bot.telegram.sendPhoto(channelId, options.photo, {
          caption: message,
          parse_mode: options.parse_mode,
        });
      } else {
        await this.bot.telegram.sendMessage(channelId, message, {
          parse_mode: options.parse_mode,
        });
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to send notification to channel ${channelId}: ${error.message}`,
      );
    }
  }

  async checkUserSubscription(
    userId: number,
    channelUsername: string,
  ): Promise<boolean> {
    try {
      const member = await this.bot.telegram.getChatMember(
        channelUsername,
        userId,
      );
      return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error: any) {
      this.logger.error(
        `Error checking subscription for user ${userId} in ${channelUsername}: ${error.message}`,
      );
      return false;
    }
  }
}
