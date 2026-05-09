import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { TonWalletModule } from '@/shared/services/ton-wallet/ton-wallet.module';
import { FragmentModule } from '@/shared/services/fragment/fragment.module';
import { LocalSnapshotStorageModule } from '@/shared/services/local-storage/local-snapshot-storage.module';
import { RapiraModule } from '@/shared/services/rapira/rapira.module';
import { RedisLockModule } from '@/shared/services/redis/redis-lock.module';
import { BotModule } from '@/modules/bot/bot.module';
import { BotAdminModule } from '@/modules/bot-admin/bot-admin.module';
import { UserModule } from '@/modules/user/user.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { PricingModule } from '@/modules/pricing/pricing.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { CronModule } from '@/modules/cron/cron.module';
import { BroadcastModule } from '@/modules/cron/broadcast.module';
import { ScreenshotModule } from '@/modules/screenshot/screenshot.module';
import { HealthModule } from '@/modules/health/health.module';
const isDev = process.env.NODE_ENV !== 'production';
const isCronEnabled = process.env.ENABLE_CRON === 'true' || isDev;
const isScreenshotEnabled = process.env.ENABLE_SCREENSHOT === 'true' || isDev;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // В k8s переменные приходят из ConfigMap/Secret в process.env до старта Node.
      // Файл .env в контейнере (если появится) не должен перезатирать их.
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),

    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 3,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 20,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrismaModule,
    RedisLockModule,
    ...(isCronEnabled ? [TonWalletModule] : []),
    RapiraModule,
    UserModule,
    PricingModule,
    PaymentsModule,
    FragmentModule,
    LocalSnapshotStorageModule,
    SettingsModule,
    BotModule,
    BotAdminModule,
    BroadcastModule,
    ...(isCronEnabled ? [CronModule] : []),
    ...(isScreenshotEnabled ? [ScreenshotModule] : []),
    HealthModule,
  ],
})
export class AppModule {}
