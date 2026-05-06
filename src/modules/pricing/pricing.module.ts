import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
