import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Request, Response } from 'express';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

@Controller('bot-admin')
export class BotAdminWebhookController {
  private readonly logger = new Logger(BotAdminWebhookController.name);

  constructor(
    @InjectBot('admin') private readonly bot: Telegraf,
    private readonly redis: RedisLockService,
  ) {}

  @Post('webhook')
  handleWebhook(@Req() req: Request, @Res() res: Response) {
    res.status(200).send('OK');

    const updateId = req.body?.update_id;
    if (!updateId) return;

    this.redis
      .setNX(`webhook:admin:update:${updateId}`, '1', 60)
      .then((acquired) => {
        if (!acquired) {
          this.logger.warn(`Duplicate admin update_id=${updateId}, skipping`);
          return;
        }
        return this.bot.handleUpdate(req.body);
      })
      .catch((error) => {
        this.logger.error(`Admin webhook error: ${error.message}`);
      });
  }
}
