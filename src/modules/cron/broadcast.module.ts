import { Global, Module } from '@nestjs/common';
import { BroadcastQueueService } from './broadcast-queue.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [BroadcastQueueService],
  exports: [BroadcastQueueService],
})
export class BroadcastModule {}
