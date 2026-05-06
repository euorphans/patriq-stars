import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { PrismaModule } from '@/shared/services/prisma/prisma.module';
import { SettingsModule } from '@/modules/settings/settings.module';

@Module({
  imports: [PrismaModule, SettingsModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
