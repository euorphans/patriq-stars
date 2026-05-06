import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { RedisLockModule } from '@/shared/services/redis/redis-lock.module';

@Module({
  imports: [PrismaModule, RedisLockModule],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
