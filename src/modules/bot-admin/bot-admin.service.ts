import { Injectable } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { TelegramBotService } from '@/shared/services/telegram/telegram-bot.service';

@Injectable()
export class BotAdminService extends TelegramBotService {
  constructor(@InjectBot('admin') bot: Telegraf, prisma: PrismaService) {
    super(bot, prisma, BotAdminService.name);
  }
}
