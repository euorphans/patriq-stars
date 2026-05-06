import * as https from 'https';
import type { Event, EventHint } from '@sentry/node';

type ChannelProvider = () => Promise<Array<{ channel_id: string }>>;

export function isIgnorableTelegramUserError(err: unknown): boolean {
  if (err == null) return false;
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const lower = msg.toLowerCase();
  if (lower.includes('bot was blocked by the user')) return true;
  if (lower.includes('user is deactivated')) return true;
  if (
    lower.includes('forbidden') &&
    lower.includes('403') &&
    lower.includes('bot')
  )
    return true;

  const any = err as {
    response?: { error_code?: number; description?: string };
    code?: number;
  };
  if (any.response?.error_code === 403) {
    const d = String(any.response.description || '').toLowerCase();
    if (d.includes('blocked') || d.includes('deactivated')) return true;
  }
  if (any.code === 403 && lower.includes('forbidden')) return true;

  return false;
}

export function isIgnorableCorsOriginError(err: unknown): boolean {
  if (err == null) return false;
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /^Origin .+ not allowed$/.test(msg.trim());
}

const COOLDOWN_MS = 60_000;
const lastSentByFingerprint = new Map<string, number>();

let channelProvider: ChannelProvider | null = null;
let adminBotToken: string | null = null;

export function configureSentryTelegram(
  token: string,
  provider: ChannelProvider,
): void {
  adminBotToken = token;
  channelProvider = provider;
}

function sendTelegramMessage(
  token: string,
  channelId: string,
  text: string,
): void {
  const body = JSON.stringify({
    chat_id: channelId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const req = https.request(
    {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    () => {},
  );

  req.on('error', () => {});
  req.write(body);
  req.end();
}

function buildMessage(event: Event, hint?: EventHint): string {
  const error = hint?.originalException;
  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : event.exception?.values?.[0]?.value || 'Unknown error';

  const errorType =
    error instanceof Error
      ? error.constructor.name
      : event.exception?.values?.[0]?.type || 'Error';

  const env = event.environment || process.env.NODE_ENV || 'unknown';
  const eventId = event.event_id?.slice(0, 8) || '?';

  let stack = '';
  if (error instanceof Error && error.stack) {
    const lines = error.stack.split('\n').slice(0, 4).join('\n');
    stack = `\n\n<pre>${escapeHtml(lines)}</pre>`;
  }

  return (
    `🚨 <b>Ошибка сервера [${env}]</b>\n\n` +
    `🆔 <code>${eventId}</code>\n` +
    `❗ <b>${escapeHtml(errorType)}</b>\n` +
    `📋 ${escapeHtml(errorMessage)}` +
    stack
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function notifyChannels(message: string): Promise<void> {
  if (!channelProvider || !adminBotToken) return;

  try {
    const channels = await channelProvider();
    for (const ch of channels) {
      sendTelegramMessage(adminBotToken, ch.channel_id, message);
    }
  } catch {}
}

export class SentryTelegramIntegration {
  readonly name = 'SentryTelegram';

  setupOnce(): void {}

  processEvent(event: Event, hint?: EventHint): Event {
    if (event.level !== 'error' && event.level !== 'fatal') {
      return event;
    }

    if (isIgnorableTelegramUserError(hint?.originalException)) {
      return event;
    }

    const firstVal = event.exception?.values?.[0]?.value;
    if (firstVal && isIgnorableTelegramUserError(new Error(firstVal))) {
      return event;
    }

    if (isIgnorableCorsOriginError(hint?.originalException)) {
      return event;
    }
    if (firstVal && isIgnorableCorsOriginError(new Error(firstVal))) {
      return event;
    }

    if (!event.exception?.values?.length) {
      return event;
    }

    const fingerprint = event.exception.values
      .map((v) => `${v.type}:${v.value}`)
      .join('|');

    const now = Date.now();
    const lastSent = lastSentByFingerprint.get(fingerprint) || 0;

    if (now - lastSent < COOLDOWN_MS) {
      return event;
    }

    lastSentByFingerprint.set(fingerprint, now);

    const message = buildMessage(event, hint);
    notifyChannels(message).catch(() => {});

    return event;
  }
}
