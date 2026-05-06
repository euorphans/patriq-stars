import { Module } from '@nestjs/common';
import { ScreenshotQueueService } from './screenshot-queue.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { FragmentModule } from '@/shared/services/fragment/fragment.module';

@Module({
  imports: [PrismaModule, FragmentModule],
  providers: [ScreenshotQueueService],
})
export class ScreenshotModule {}
