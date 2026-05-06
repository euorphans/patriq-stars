import { Module, Global } from '@nestjs/common';
import { RapiraService } from './rapira.service';

@Global()
@Module({
  providers: [RapiraService],
  exports: [RapiraService],
})
export class RapiraModule {}
