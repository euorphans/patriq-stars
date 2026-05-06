import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';

@Catch()
export class SentryExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SentryExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const isHttp = host.getType() === 'http';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const url = isHttp
        ? ((host.switchToHttp().getRequest().url as string | undefined) ?? '')
        : '';

      if (
        status < HttpStatus.INTERNAL_SERVER_ERROR ||
        url.includes('/health/')
      ) {
        if (isHttp) {
          const ctx = host.switchToHttp();
          ctx.getResponse().status(status).json(exception.getResponse());
        }
        return;
      }
    }

    Sentry.captureException(exception);

    if (isHttp) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse();
      const status =
        exception instanceof HttpException
          ? exception.getStatus()
          : HttpStatus.INTERNAL_SERVER_ERROR;

      response.status(status).json({
        statusCode: status,
        message: 'Internal server error',
      });
    } else {
      this.logger.error('Unhandled exception', exception);
    }
  }
}
