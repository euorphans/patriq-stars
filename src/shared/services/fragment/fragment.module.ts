import { Module, Global } from '@nestjs/common';
import { FragmentService } from './fragment.service';
import { FragmentAccountService } from './fragment-account.service';
import { FragmentScreenshotService } from './fragment-screenshot.service';

@Global()
@Module({
  providers: [
    FragmentService,
    FragmentAccountService,
    FragmentScreenshotService,
  ],
  exports: [FragmentService, FragmentAccountService, FragmentScreenshotService],
})
export class FragmentModule {}
