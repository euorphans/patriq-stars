import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthTrackerService } from './health-tracker.service';
import { EventLoopMonitorService } from './event-loop-monitor.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { TonWalletModule } from '@/shared/services/ton-wallet/ton-wallet.module';

@Global()
@Module({
  imports: [PrismaModule, TonWalletModule],
  controllers: [HealthController],
  providers: [HealthTrackerService, EventLoopMonitorService],
  exports: [HealthTrackerService, EventLoopMonitorService],
})
export class HealthModule {}
