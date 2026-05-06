import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Request, Response } from 'express';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { HealthTrackerService } from '@/modules/health/health-tracker.service';

@Controller('bot')
export class BotWebhookController {
  private readonly logger = new Logger(BotWebhookController.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly redis: RedisLockService,
    private readonly healthTracker: HealthTrackerService,
  ) {}

  @Post('webhook')
  handleWebhook(@Req() req: Request, @Res() res: Response) {
    res.status(200).send('OK');

    const updateId = req.body?.update_id;
    const userId = req.body?.callback_query?.from?.id;
    const callbackData = req.body?.callback_query?.data;
    if (!updateId) return;

    const handleError = (error: Error) => {
      if (error.message?.includes('timed out')) {
        this.healthTracker.recordError();
      }
      this.logger.error(`Webhook error: ${error.message}`);
    };

    if (!this.redis.isAvailable()) {
      this.bot.handleUpdate(req.body).catch(handleError);
      return;
    }

    const dedupeKeys: string[] = [`webhook:update:${updateId}`];
    if (userId && callbackData) {
      dedupeKeys.push(`webhook:cbq:${userId}:${callbackData}`);
    }

    Promise.all(
      dedupeKeys.map((key, i) => this.redis.setNX(key, '1', i === 0 ? 60 : 2)),
    )
      .then(([updateAcquired, cbqAcquired]) => {
        if (!updateAcquired) {
          this.logger.warn(`Duplicate update_id=${updateId}, skipping`);
          return;
        }
        if (cbqAcquired === false) {
          this.logger.debug(
            `Duplicate callback_query userId=${userId} data=${callbackData}, skipping`,
          );
          return;
        }
        return this.bot.handleUpdate(req.body);
      })
      .catch(handleError);
  }
}
