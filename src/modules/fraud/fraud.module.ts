import { Module } from '@nestjs/common';
import { FraudService } from './fraud.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { SettingsModule } from '@/modules/settings/settings.module';

@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [FraudService],
  exports: [FraudService],
})
export class FraudModule {}
