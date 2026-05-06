import { Injectable } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { TelegramBotService } from '@/shared/services/telegram/telegram-bot.service';

@Injectable()
export class BotService extends TelegramBotService {
  constructor(@InjectBot() bot: Telegraf, prisma: PrismaService) {
    super(bot, prisma, BotService.name);
  }
}
