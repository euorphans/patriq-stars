import { Logger } from '@nestjs/common';
import { session } from 'telegraf';
import { createClient } from 'redis';
import * as https from 'https';

export interface TelegrafConfigOptions {
  token: string;
  botName?: string;
  includeModule: any;
}

function buildRedisUrl(
  redisUrl: string,
  redisPassword: string | undefined,
  redisDb: number,
): string {
  if (!redisPassword) return redisUrl;

  try {
    const url = new URL(redisUrl);
    url.password = redisPassword;
    url.pathname = `/${redisDb}`;
    return url.toString();
  } catch {
    const stripped = redisUrl.replace('redis://', '');
    const [host, port] = stripped.split(':');
    return `redis://:${redisPassword}@${host || 'localhost'}:${port || '6379'}/${redisDb}`;
  }
}

function createRedisSessionStore(
  client: ReturnType<typeof createClient>,
  prefix = 'telegraf:session:',
  ttlSeconds: number,
) {
  return {
    async get(key: string) {
      const data = await client.get(prefix + key);
      if (!data || typeof data !== 'string') return undefined;
      try {
        return JSON.parse(data);
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: any) {
      await client.set(prefix + key, JSON.stringify(value), {
        EX: ttlSeconds,
      });
    },
    async delete(key: string) {
      await client.del(prefix + key);
    },
  };
}

export async function createTelegrafConfig(
  options: TelegrafConfigOptions,
): Promise<{
  token: string;
  middlewares: any[];
  include: any[];
  launchOptions?: { dropPendingUpdates?: boolean; polling?: boolean } | false;
}> {
  const logger = new Logger(
    options.botName ? `TelegrafConfig-${options.botName}` : 'TelegrafConfig',
  );

  const webhookDomain = process.env.WEBHOOK_DOMAIN;
  const useWebhook = !!webhookDomain;

  if (useWebhook) {
    logger.log(`Webhook mode enabled (domain: ${webhookDomain})`);
  } else {
    logger.log('Long Polling mode enabled');
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${options.token}/deleteWebhook?drop_pending_updates=true`,
      );
      await response.json();
    } catch {}
  }

  const redisUrl = process.env.REDIS_URL;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisDb = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0;
  const useRedisSession = process.env.USE_REDIS_SESSION === 'true';
  let sessionMiddleware;

  if (useRedisSession && redisUrl) {
    try {
      const fullRedisUrl = buildRedisUrl(redisUrl, redisPassword, redisDb);

      const client = createClient({
        url: fullRedisUrl,
        pingInterval: 60_000,
      });

      client.on('error', (err) => {
        logger.error(`Redis session client error: ${err.message}`);
      });

      client.on('reconnecting', () => {
        logger.warn('Redis session client reconnecting...');
      });

      await client.connect();

      const sessionTtl = parseInt(
        process.env.TELEGRAF_SESSION_TTL_SECONDS || '2592000',
        10,
      );
      const store = createRedisSessionStore(
        client,
        'telegraf:session:',
        Number.isFinite(sessionTtl) && sessionTtl > 60 ? sessionTtl : 2592000,
      );
      sessionMiddleware = session({ store });
      logger.log('Using Redis session storage (USE_REDIS_SESSION=true)');
    } catch (err) {
      logger.warn(
        `Failed to connect to Redis, falling back to memory session: ${err instanceof Error ? err.message : err}`,
      );
      sessionMiddleware = session();
    }
  } else {
    sessionMiddleware = session();
    logger.log('Using in-memory session storage (fast mode)');

    if (useWebhook) {
      logger.warn(
        '⚠️  WARNING: Using in-memory sessions with webhook mode (multiple replicas). ' +
          'Session data (including broadcasts) will NOT be shared across replicas! ' +
          'Set USE_REDIS_SESSION=true for production deployments with replicas.',
      );
    }
  }

  const ensureSession = (ctx: any, next: () => Promise<void>) => {
    if (ctx.session === undefined || ctx.session === null) {
      ctx.session = {};
    }
    return next();
  };

  /** Продлевает TTL ключа сессии в Redis при каждом апдейте (иначе после ~24ч простоя сессия исчезает). */
  const touchSession = (ctx: any, next: () => Promise<void>) => {
    if (ctx.session && typeof ctx.session === 'object') {
      ctx.session._t = Date.now();
    }
    return next();
  };

  const telegramAgent = new https.Agent({
    keepAlive: true,
    timeout: 25000,
  });
  const origCreateConnection = (telegramAgent as any).createConnection.bind(
    telegramAgent,
  ) as (opts: any, cb: any) => any;
  (telegramAgent as any).createConnection = function (
    this: any,
    opts: any,
    cb: any,
  ) {
    const socket = origCreateConnection(opts, cb);
    socket.on('timeout', () =>
      socket.destroy(new Error('Telegram API socket timeout')),
    );
    return socket;
  };

  const config: any = {
    token: options.token,
    options: {
      telegram: { agent: telegramAgent },
      handlerTimeout: 30_000,
    },
    middlewares: [sessionMiddleware, ensureSession, touchSession],
    include: [options.includeModule],
  };

  if (useWebhook) {
    config.launchOptions = false;
  }

  return config;
}
