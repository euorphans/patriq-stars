import { Module, Global } from '@nestjs/common';
import { TonWalletService } from './ton-wallet.service';
import { TonStreamingListenerService } from './ton-streaming-listener.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { RedisLockModule } from '@/shared/services/redis/redis-lock.module';

@Global()
@Module({
  imports: [PrismaModule, RedisLockModule],
  providers: [TonWalletService, TonStreamingListenerService],
  exports: [TonWalletService],
})
export class TonWalletModule {}
