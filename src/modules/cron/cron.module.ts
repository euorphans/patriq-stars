import { Global, Module } from '@nestjs/common';
import { PaymentCheckerService } from './payment-checker.service';
import { FragmentQueueService } from './fragment-queue.service';
import { NotificationQueueService } from './notification-queue.service';
import { InfraMonitorService } from './infra-monitor.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { PaymentsModule } from '@/modules/payments/payments.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { FragmentModule } from '@/shared/services/fragment/fragment.module';
import { I18nModule } from '@/shared/services/i18n/i18n.module';
import { UserModule } from '@/modules/user/user.module';
import { FraudModule } from '@/modules/fraud/fraud.module';
@Global()
@Module({
  imports: [
    PrismaModule,
    PaymentsModule,
    SettingsModule,
    FragmentModule,
    I18nModule,
    UserModule,
    FraudModule,
  ],
  providers: [
    PaymentCheckerService,
    FragmentQueueService,
    NotificationQueueService,
    InfraMonitorService,
  ],
  exports: [
    PaymentCheckerService,
    FragmentQueueService,
    NotificationQueueService,
    InfraMonitorService,
  ],
})
export class CronModule {}
