import './patches/ton-crypto-patch';
import * as Sentry from '@sentry/nestjs';
import {
  SentryTelegramIntegration,
  configureSentryTelegram,
  isIgnorableTelegramUserError,
  isIgnorableCorsOriginError,
} from '@shared/services/sentry/sentry-telegram.integration';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0,
    integrations: [new SentryTelegramIntegration()],
    beforeSend(event, hint) {
      if (isIgnorableTelegramUserError(hint?.originalException)) {
        return null;
      }
      if (isIgnorableCorsOriginError(hint?.originalException)) {
        return null;
      }
      const v = event.exception?.values?.[0]?.value;
      if (v && isIgnorableTelegramUserError(new Error(v))) {
        return null;
      }
      if (v && isIgnorableCorsOriginError(new Error(v))) {
        return null;
      }
      return event;
    },
  });
}

import * as express from 'express';
import * as path from 'path';
import * as cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { SettingsService } from './modules/settings/settings.service';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      process.env.LOG_LEVEL === 'verbose'
        ? ['error', 'warn', 'log', 'debug']
        : process.env.NODE_ENV === 'production'
          ? ['error', 'warn', 'log', 'debug']
          : ['error', 'warn', 'log', 'debug'],
    bufferLogs: true,
  });

  const port = process.env.APPLICATION_PORT || 3001;

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(cookieParser());

  const normalizeCorsOrigin = (raw: string): string | null => {
    try {
      return new URL(raw.trim()).origin;
    } catch {
      return null;
    }
  };

  const allowedOriginSet = new Set<string>();
  for (const raw of (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    const n = normalizeCorsOrigin(raw);
    if (n) allowedOriginSet.add(n);
  }

  for (const raw of (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)) {
    const n = normalizeCorsOrigin(raw);
    if (n) allowedOriginSet.add(n);
  }

  if (process.env.WEBHOOK_DOMAIN) {
    const webhookOrigin = process.env.WEBHOOK_DOMAIN.replace(/\/+$/, '');
    const n = normalizeCorsOrigin(webhookOrigin);
    if (n) allowedOriginSet.add(n);
  }

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = normalizeCorsOrigin(origin);
      if (normalized && allowedOriginSet.has(normalized)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 3600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,

      disableErrorMessages: process.env.NODE_ENV === 'production',
      validateCustomDecorators: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      frameguard: {
        action: 'deny',
      },
      noSniff: true,
      xssFilter: true,
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
      },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });

  app.use(
    express.json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  if (process.env.SENTRY_DSN && process.env.BOT_ADMIN_TOKEN) {
    const settingsService = app.get(SettingsService);
    configureSentryTelegram(process.env.BOT_ADMIN_TOKEN, () =>
      settingsService.getInsufficientFundsChannels(),
    );
  }

  const handleShutdown = async (signal: string) => {
    console.log(`${signal} received, starting graceful shutdown...`);

    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 25_000);
    forceExit.unref();

    try {
      await app.close();
    } catch (err) {
      console.error('Error during app.close():', err);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  await app.listen(port, '0.0.0.0', () => {
    console.log(`📢 Server starting on: http://localhost:${port}/ ⚡️`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
