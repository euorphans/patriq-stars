import { Module, Global } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryExceptionFilter } from './sentry.filter';

@Global()
@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: SentryExceptionFilter,
    },
  ],
})
export class SentryModule {}
