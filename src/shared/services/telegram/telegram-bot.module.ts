import { Module } from '@nestjs/common';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  exports: [PrismaModule],
})
export class TelegramBotModule {}
