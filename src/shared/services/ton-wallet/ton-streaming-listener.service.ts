import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TonWalletService } from './ton-wallet.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

type StreamingEvent = {
  type?: string;
  finality?: 'pending' | 'confirmed' | 'finalized';
  status?: string;
  [key: string]: unknown;
};

@Injectable()
export class TonStreamingListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TonStreamingListenerService.name);
  private abortController: AbortController | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelayMs = 15_000;
  private lastQueueHintAt = 0;
  private readonly minQueueHintGapMs: number;
  private readonly lockId = 'ton_streaming_listener';
  private readonly lockTtlSeconds = 30;
  private lockExtendTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tonWallet: TonWalletService,
    private readonly redisLock: RedisLockService,
  ) {
    this.minQueueHintGapMs = this.readPositiveIntEnv(
      'TON_STREAMING_MIN_HINT_GAP_MS',
      2_000,
    );
  }

  async onModuleInit(): Promise<void> {
    const enabled = process.env.TON_STREAMING_ENABLED === 'true';
    if (!enabled) {
      return;
    }

    if (!this.tonWallet.isToncenterConfigured()) {
      this.logger.warn(
        'TON streaming disabled: TONCENTER_API_KEY is not configured',
      );
      return;
    }

    this.stopped = false;
    this.runLoop().catch((error: unknown) => {
      this.logger.error(`Streaming loop crashed: ${String(error)}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.stopLockExtender();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    await this.redisLock.releaseLock(this.lockId);
  }

  private getEndpoint(): string {
    const custom = process.env.TON_STREAMING_URL?.trim();
    if (custom) {
      return custom;
    }
    return 'https://toncenter.com/api/streaming/v2/sse';
  }

  private getMinFinality(): 'pending' | 'confirmed' | 'finalized' {
    const raw = (process.env.TON_STREAMING_MIN_FINALITY || 'confirmed').trim();
    if (raw === 'pending' || raw === 'confirmed' || raw === 'finalized') {
      return raw;
    }
    return 'confirmed';
  }

  private getApiKey(): string | null {
    const first = process.env.TONCENTER_API_KEY?.split(',')[0]?.trim();
    return first || null;
  }

  private readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const walletAddress = await this.waitForWalletAddress();
        if (!walletAddress) {
          return;
        }

        const lockAcquired = await this.redisLock.acquireLock(
          this.lockId,
          this.lockTtlSeconds,
        );
        if (!lockAcquired) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          continue;
        }

        this.startLockExtender();
        await this.connectAndConsume(walletAddress);
        this.reconnectAttempts = 0;
      } catch (error: unknown) {
        if (this.stopped) {
          return;
        }
        this.reconnectAttempts += 1;
        const backoffMs = Math.min(
          1000 * this.reconnectAttempts,
          this.maxReconnectDelayMs,
        );
        this.logger.warn(
          `TON streaming disconnected: ${String(error)}. Reconnect in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } finally {
        this.stopLockExtender();
        await this.redisLock.releaseLock(this.lockId);
      }
    }
  }

  private startLockExtender(): void {
    this.stopLockExtender();
    this.lockExtendTimer = setInterval(async () => {
      try {
        await this.redisLock.extendLock(this.lockId, this.lockTtlSeconds);
      } catch {
        // No-op: if extension fails, lock naturally expires and another pod can take over.
      }
    }, 10_000);
    this.lockExtendTimer.unref();
  }

  private stopLockExtender(): void {
    if (this.lockExtendTimer) {
      clearInterval(this.lockExtendTimer);
      this.lockExtendTimer = null;
    }
  }

  private async waitForWalletAddress(): Promise<string | null> {
    const maxWaitMs = 15_000;
    const stepMs = 500;
    let waitedMs = 0;

    while (!this.stopped && waitedMs <= maxWaitMs) {
      const address = this.tonWallet.getAddress();
      if (address) {
        return address;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
      waitedMs += stepMs;
    }

    this.logger.warn('TON wallet address is not initialized, skip streaming');
    return null;
  }

  private async connectAndConsume(address: string): Promise<void> {
    const endpoint = this.getEndpoint();
    const minFinality = this.getMinFinality();
    const apiKey = this.getApiKey();
    this.abortController = new AbortController();

    const body = {
      addresses: [address],
      types: ['transactions'],
      min_finality: minFinality,
      include_address_book: false,
      include_metadata: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (apiKey) {
      headers['X-Api-Key'] = apiKey;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} from streaming endpoint`);
    }

    this.logger.log(
      `TON streaming connected: ${endpoint} (min_finality=${minFinality})`,
    );

    const decoder = new TextDecoder();
    let buffer = '';
    let eventDataLines: string[] = [];

    for await (const chunk of response.body as any) {
      if (this.stopped) {
        break;
      }

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');

        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('data:')) {
          eventDataLines.push(line.slice(5).trimStart());
          continue;
        }

        if (line === '') {
          if (eventDataLines.length > 0) {
            const payload = eventDataLines.join('\n');
            eventDataLines = [];
            this.handleSsePayload(payload).catch((error: unknown) => {
              this.logger.warn(`Streaming payload handling failed: ${error}`);
            });
          }
        }
      }
    }

    throw new Error('Stream ended');
  }

  private async handleSsePayload(payload: string): Promise<void> {
    let parsed: StreamingEvent;
    try {
      parsed = JSON.parse(payload) as StreamingEvent;
    } catch {
      return;
    }

    if (parsed.status === 'subscribed') {
      this.logger.log('TON streaming subscription confirmed');
      return;
    }

    if (parsed.type !== 'transactions') {
      return;
    }

    if (parsed.finality !== 'confirmed' && parsed.finality !== 'finalized') {
      return;
    }

    const now = Date.now();
    if (now - this.lastQueueHintAt < this.minQueueHintGapMs) {
      return;
    }
    this.lastQueueHintAt = now;

    await this.tonWallet.processStreamingConfirmationHint(parsed.finality);
  }
}
