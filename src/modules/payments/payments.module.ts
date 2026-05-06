import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { PaymentsService } from './payments.service';
import { PaymentAdminService } from './payment-admin.service';
import { PaymentsController } from './payments.controller';
import { PlategaService } from './providers/platega.service';
import { HeleketService } from './providers/heleket.service';
import { TonPaymentService } from './providers/ton-payment.service';
import { Sbp2Service } from './providers/sbp2.service';
import { AurapayService } from './providers/aurapay.service';
import { PaymentHealthService } from './payment-health.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { SettingsModule } from '@/modules/settings/settings.module';
import { FraudModule } from '@/modules/fraud/fraud.module';
import { WebhookGuard } from '@/shared/guards/webhook.guard';
import { IpWhitelistGuard } from '@/shared/guards/ip-whitelist.guard';
import { UserModule } from '@/modules/user/user.module';
import { I18nModule } from '@/shared/services/i18n/i18n.module';

@Module({
  imports: [
    PrismaModule,
    TelegrafModule,
    SettingsModule,
    FraudModule,
    UserModule,
    I18nModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentAdminService,
    PlategaService,
    HeleketService,
    TonPaymentService,
    Sbp2Service,
    AurapayService,
    PaymentHealthService,
    WebhookGuard,
    IpWhitelistGuard,
  ],
  exports: [
    PaymentsService,
    PaymentAdminService,
    PlategaService,
    HeleketService,
    TonPaymentService,
    Sbp2Service,
    AurapayService,
    PaymentHealthService,
  ],
})
export class PaymentsModule {}
