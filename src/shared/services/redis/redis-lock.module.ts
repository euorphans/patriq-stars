import { Global, Module } from '@nestjs/common';
import { RedisLockService } from './redis-lock.service';

@Global()
@Module({
  providers: [RedisLockService],
  exports: [RedisLockService],
})
export class RedisLockModule {}
