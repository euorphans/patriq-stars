import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  Address,
  fromNano,
  internal,
  SendMode,
  toNano,
  TonClient,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { HighloadWalletV3 } from '@tonkite/highload-wallet-v3';
import { beginCell, Cell } from '@ton/core';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import {
  withRetry,
  isBlockchainApiRetryable,
} from '@/shared/utils/retry.utils';
import { createHash } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

/** Toncenter `transactionsByMessage` outcome — never conflate API errors with an empty index. */
export type BodyHashLookupResult =
  | { ok: true; found: true; txHash: string; timestamp: number }
  | { ok: true; found: false }
  | { ok: false; reason: string };

interface TransferMessage {
  destination: string;
  amount: number;
  comment: string;
}

interface BatchTransferMessage extends TransferMessage {
  order_id: string;
  type: string;
  user_id: string;
  amount_value: number;
  validUntil?: number;
}

@Injectable()
export class TonWalletService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TonWalletService.name);
  private tonClient: TonClient;
  private wallet: HighloadWalletV3 | null = null;
  private keyPair: { publicKey: Buffer; secretKey: Buffer } | null = null;
  private walletAddress: Address | null = null;
  private readonly WALLET_MNEMONIC: string[];
  private readonly TON_SUBWALLET_ID: number;
  private readonly TON_WALLET_WORKCHAIN = 0;
  private readonly TON_WALLET_TIMEOUT: number;

  /**
   * How far in the past `createdAt` is shifted when signing external messages
   * for highload-wallet-v3. Must be large enough to survive the lag of any
   * Toncenter liteserver behind the masterchain head, otherwise the wallet
   * contract throws exitcode=35 (`error::invalid_created_at`, check
   * `created_at <= now()`). Community-recommended floor is ~20s; we keep 60s
   * as a safety margin against periodic Toncenter lag spikes.
   * See https://github.com/ton-blockchain/highload-wallet-contract-v3/issues/4
   */
  private readonly CREATED_AT_OFFSET_SECONDS = 60;

  /**
   * Cached masterchain `gen_utime`. We prefer chain time over wall-clock when
   * computing `createdAt` so that an out-of-sync local clock or a lagging
   * liteserver cannot push the message into the future relative to the
   * validator's `now()`.
   */
  private chainTimeCache: { genUtime: number; fetchedAtMs: number } | null =
    null;
  private readonly CHAIN_TIME_CACHE_MS = 1500;

  private lastTransactionTime = 0;

  private readonly MIN_TRANSACTION_DELAY = 3000;

  private readonly MAX_BATCH_SIZE = 254;

  private shift = 0;
  private bitNumber = 0;

  private recentBatchHashes: Map<string, number> = new Map();
  private readonly BATCH_HASH_TTL_MS = 30 * 60 * 1000;
  private readonly BATCH_HASH_TTL_SECONDS = 30 * 60;
  private readonly BATCH_HASH_REDIS_PREFIX = 'batch_hash:';
  private streamingHintInFlight = false;

  private readonly toncenterApis: AxiosInstance[] = [];
  private toncenterRoundRobin = 0;
  private readonly TONCENTER_TIMEOUT_MS = 10_000;

  private get toncenterApi(): AxiosInstance | null {
    if (this.toncenterApis.length === 0) return null;
    const api =
      this.toncenterApis[this.toncenterRoundRobin % this.toncenterApis.length];
    this.toncenterRoundRobin =
      (this.toncenterRoundRobin + 1) % this.toncenterApis.length;
    return api;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
  ) {
    const toncenterKeys = (process.env.TONCENTER_API_KEY || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const mnemonicEnv = process.env.WALLET_MNEMONIC || '';
    this.WALLET_MNEMONIC = mnemonicEnv
      .split(',')
      .map((word) => word.trim())
      .filter((word) => word.length > 0);

    this.TON_SUBWALLET_ID = this.readEnvInt(
      'TON_SUBWALLET_ID',
      698983191,
      0,
      4294967295,
    );
    this.TON_WALLET_TIMEOUT = this.readEnvInt(
      'TON_WALLET_TIMEOUT',
      300,
      1,
      4194303,
    );

    for (const key of toncenterKeys) {
      this.toncenterApis.push(
        axios.create({
          baseURL: 'https://toncenter.com/',
          timeout: this.TONCENTER_TIMEOUT_MS,
          headers: { 'X-Api-Key': key },
          httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
        }),
      );
    }

    if (this.toncenterApis.length > 0) {
      this.logger.log(
        `Toncenter API configured with ${this.toncenterApis.length} key(s) (effective RPS: ${this.toncenterApis.length * 80})`,
      );
    }

    this.logger.log(
      `TON wallet config: subwalletId=${this.TON_SUBWALLET_ID}, timeout=${this.TON_WALLET_TIMEOUT}s`,
    );
  }

  private readEnvInt(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
      return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      this.logger.warn(
        `${name}="${raw}" is invalid, using fallback ${fallback}`,
      );
      return fallback;
    }

    return parsed;
  }

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {}

  private async initialize(): Promise<void> {
    try {
      if (this.WALLET_MNEMONIC.length === 0) {
        this.logger.warn(
          'WALLET_MNEMONIC is not configured — TON wallet disabled',
        );
        return;
      }

      if (this.toncenterApis.length === 0) {
        this.logger.warn(
          'TONCENTER_API_KEY is not configured — TON wallet disabled',
        );
        return;
      }

      const firstKey = (process.env.TONCENTER_API_KEY || '')
        .split(',')[0]
        ?.trim();
      this.tonClient = new TonClient({
        endpoint: 'https://toncenter.com/api/v2/jsonRPC',
        apiKey: firstKey,
      });

      this.keyPair = await mnemonicToPrivateKey(this.WALLET_MNEMONIC);

      await this.initializeHighloadWallet();
    } catch (error: any) {
      this.logger.error(`Failed to initialize TON wallet: ${error.message}`);
    }
  }

  private async initializeHighloadWallet(): Promise<void> {
    if (!this.keyPair) {
      throw new Error('KeyPair not initialized');
    }

    await this.synchronizeWalletState();

    const sequence = {
      shift: BigInt(this.shift),
      bitNumber: this.bitNumber,

      current: () => {
        return (this.shift << 10) | this.bitNumber;
      },

      hasNext: () => {
        return this.bitNumber < 1022;
      },

      next: () => {
        this.bitNumber++;
        if (this.bitNumber > 1022) {
          this.bitNumber = 0;
          this.shift = (this.shift + 1) % 8192;
        }

        return (this.shift << 10) | this.bitNumber;
      },
    };

    this.wallet = new HighloadWalletV3(
      sequence as any,
      this.keyPair.publicKey,
      this.TON_WALLET_TIMEOUT,
      this.TON_SUBWALLET_ID,
      this.TON_WALLET_WORKCHAIN,
    );

    this.walletAddress = this.wallet.address;
  }

  private async synchronizeWalletState(): Promise<void> {
    try {
      const savedShift = await this.prisma.botSettings.findUnique({
        where: { setting_key: 'wallet_shift' },
      });
      const savedBitNumber = await this.prisma.botSettings.findUnique({
        where: { setting_key: 'wallet_bitNumber' },
      });

      if (savedShift && savedBitNumber) {
        this.shift = parseInt(savedShift.setting_value, 10) || 0;
        this.bitNumber = parseInt(savedBitNumber.setting_value, 10) || 0;

        this.bitNumber += 200;
        if (this.bitNumber > 1022) {
          const overflow = this.bitNumber - 1023;
          this.bitNumber = overflow;
          this.shift = (this.shift + 1) % 8192;
        }

        await this.saveWalletState();
        this.logger.log(
          `Wallet state synchronized: shift=${this.shift}, bitNumber=${this.bitNumber} (after +200 startup buffer, saved to DB)`,
        );
      } else {
        this.shift = 0;
        this.bitNumber = 500;
        await this.saveWalletState();
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to synchronize wallet state: ${error.message}. Using default values.`,
      );
      this.shift = 0;
      this.bitNumber = 0;
    }
  }

  private async saveWalletState(): Promise<void> {
    try {
      await Promise.all([
        this.prisma.botSettings.upsert({
          where: { setting_key: 'wallet_shift' },
          update: { setting_value: this.shift.toString() },
          create: {
            setting_key: 'wallet_shift',
            setting_value: this.shift.toString(),
          },
        }),
        this.prisma.botSettings.upsert({
          where: { setting_key: 'wallet_bitNumber' },
          update: { setting_value: this.bitNumber.toString() },
          create: {
            setting_key: 'wallet_bitNumber',
            setting_value: this.bitNumber.toString(),
          },
        }),
      ]);
    } catch (error: any) {
      this.logger.error(`Failed to save wallet state: ${error.message}`);
    }
  }

  private async withBlockchainRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxAttempts: number = 4,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts,
      delayMs: 2000,
      exponentialBackoff: true,
      jitter: true,
      shouldRetry: isBlockchainApiRetryable,
      onRetry: (attempt, error) => {
        this.logger.warn(
          `[${context}] Blockchain API retry ${attempt}/${maxAttempts}: ${error.message}`,
        );
      },
    });
  }

  async getBalance(): Promise<string> {
    if (!this.walletAddress) {
      throw new Error('Wallet not initialized');
    }

    if (this.toncenterApis.length === 0) {
      throw new Error('Toncenter API is not configured');
    }
    const walletRaw = this.walletAddress.toRawString();
    return this.withBlockchainRetry(async () => {
      const response = await this.toncenterApi!.get('api/v3/accountStates', {
        params: { address: walletRaw, include_boc: false },
      });
      const accounts = response.data?.accounts || [];
      const account = accounts[0];
      return fromNano(BigInt(account?.balance || '0'));
    }, 'getBalance');
  }

  async checkAllToncenterKeys(): Promise<{
    total: number;
    ok: number;
    failures: { index: number; error: string }[];
  }> {
    const failures: { index: number; error: string }[] = [];
    if (!this.walletAddress || this.toncenterApis.length === 0) {
      return { total: this.toncenterApis.length, ok: 0, failures };
    }
    const walletRaw = this.walletAddress.toRawString();
    for (let i = 0; i < this.toncenterApis.length; i++) {
      try {
        await this.toncenterApis[i].get('api/v3/accountStates', {
          params: { address: walletRaw, include_boc: false },
        });
      } catch (err: any) {
        failures.push({ index: i + 1, error: err.message ?? 'Unknown error' });
      }
    }
    return {
      total: this.toncenterApis.length,
      ok: this.toncenterApis.length - failures.length,
      failures,
    };
  }

  private computeBatchHash(messages: BatchTransferMessage[]): string {
    const sortedMessages = [...messages].sort((a, b) =>
      a.order_id.localeCompare(b.order_id),
    );

    const hashInput = sortedMessages
      .map((m) => `${m.order_id}:${m.destination}:${m.amount}`)
      .join('|');

    return createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  }

  private cleanupRecentBatchHashes(): void {
    const now = Date.now();
    for (const [hash, timestamp] of this.recentBatchHashes) {
      if (now - timestamp > this.BATCH_HASH_TTL_MS) {
        this.recentBatchHashes.delete(hash);
      }
    }
  }

  private async isBatchAlreadySent(batchHash: string): Promise<boolean> {
    if (this.recentBatchHashes.has(batchHash)) {
      return true;
    }

    if (this.redisLock.isAvailable()) {
      const key = this.BATCH_HASH_REDIS_PREFIX + batchHash;
      const result = await this.redisLock.get(key);
      if (result !== null) {
        this.recentBatchHashes.set(batchHash, Date.now());
        return true;
      }
    }

    return false;
  }

  private async tryAcquireBatchSendRight(batchHash: string): Promise<boolean> {
    if (this.redisLock.isAvailable()) {
      const key = this.BATCH_HASH_REDIS_PREFIX + batchHash;

      try {
        const wasSet = await this.redisLock.setNX(
          key,
          'pending',
          this.BATCH_HASH_TTL_SECONDS,
        );

        if (!wasSet) {
          return false;
        }

        this.recentBatchHashes.set(batchHash, Date.now());
        return true;
      } catch (error: any) {
        this.logger.error(`Error acquiring batch send right: ${error.message}`);
        return false;
      }
    }

    if (this.recentBatchHashes.has(batchHash)) {
      return false;
    }

    this.recentBatchHashes.set(batchHash, Date.now());
    return true;
  }

  private async clearBatchSendRight(batchHash: string): Promise<void> {
    this.recentBatchHashes.delete(batchHash);
    if (this.redisLock.isAvailable()) {
      try {
        const key = this.BATCH_HASH_REDIS_PREFIX + batchHash;
        await this.redisLock.delete(key);
      } catch (error: any) {
        this.logger.error(
          `Error clearing batch send right for ${batchHash}: ${error.message}`,
        );
      }
    }
  }

  private async markBatchAsCompleted(
    batchHash: string,
    txHash: string,
  ): Promise<void> {
    if (this.redisLock.isAvailable()) {
      const key = this.BATCH_HASH_REDIS_PREFIX + batchHash;
      await this.redisLock.setWithTTL(
        key,
        `completed:${txHash}`,
        this.BATCH_HASH_TTL_SECONDS,
      );
    }
    this.recentBatchHashes.set(batchHash, Date.now());
  }

  async getCompletedBatchTxHash(
    messages: BatchTransferMessage[],
  ): Promise<string | null> {
    const batchHash = this.computeBatchHash(messages);
    if (this.redisLock.isAvailable()) {
      try {
        const key = this.BATCH_HASH_REDIS_PREFIX + batchHash;
        const result = await this.redisLock.get(key);
        if (
          result &&
          typeof result === 'string' &&
          result.startsWith('completed:')
        ) {
          return result.slice('completed:'.length);
        }
      } catch (error: any) {
        this.logger.error(
          `Error looking up completed batch tx_hash: ${error.message}`,
        );
      }
    }
    return null;
  }

  private createMessageBody(payload: string): Cell | undefined {
    if (!payload) {
      return undefined;
    }

    try {
      const paddingNeeded = (4 - (payload.length % 4)) % 4;
      const paddedPayload = payload + '='.repeat(paddingNeeded);

      const buffer = Buffer.from(paddedPayload, 'base64');

      if (buffer.length > 0) {
        const cells = Cell.fromBoc(buffer);
        if (cells && cells.length > 0) {
          return cells[0];
        }
      }
    } catch (error: any) {
      try {
        return beginCell().storeUint(0, 32).storeStringTail(payload).endCell();
      } catch (textError: any) {
        this.logger.error(
          `Failed to create text comment: ${textError.message}`,
        );
        return undefined;
      }
    }

    return undefined;
  }

  computeBodyHashesInPool(payloads: string[]): Promise<string[]> {
    if (payloads.length === 0) return Promise.resolve([]);
    return Promise.resolve(
      payloads.map((payload) => {
        const body = this.createMessageBody(payload);
        return body ? body.hash().toString('hex') : '';
      }),
    );
  }

  /**
   * Returns the current TON masterchain time (`gen_utime` of the latest known
   * masterchain block) with a small in-memory cache. Falls back to wall-clock
   * if Toncenter is unreachable. The returned value is a unix timestamp
   * suitable for `createdAt` of an external message to highload-wallet-v3.
   */
  private async getChainTime(): Promise<number> {
    const nowMs = Date.now();

    if (this.chainTimeCache) {
      const ageMs = nowMs - this.chainTimeCache.fetchedAtMs;
      if (ageMs < this.CHAIN_TIME_CACHE_MS) {
        return this.chainTimeCache.genUtime + Math.floor(ageMs / 1000);
      }
    }

    const api = this.toncenterApi;
    if (api) {
      try {
        const response = await api.get('api/v3/masterchainInfo', {
          timeout: 3000,
        });
        const genUtime = Number(response.data?.last?.gen_utime);
        if (Number.isFinite(genUtime) && genUtime > 0) {
          this.chainTimeCache = { genUtime, fetchedAtMs: nowMs };
          return genUtime;
        }
      } catch (error: any) {
        this.logger.debug(
          `getChainTime: masterchainInfo failed (${error.message}), using wall-clock`,
        );
      }
    }

    return Math.floor(nowMs / 1000);
  }

  async batchTransfer(messages: BatchTransferMessage[]): Promise<{
    success: boolean;
    sentToBlockchain?: boolean;
    /** Root cell hash of the signed external message to the wallet (from sendBatch return). */
    externalMessageHashHex?: string;
    txHash?: string;
    txHashHex?: string;
    tonscanUrl?: string;
    confirmedMessages?: Map<string, { txHash: string; tonscanUrl: string }>;
    error?: string;
    isExitCode36?: boolean;
    isExitCode35?: boolean;
  }> {
    let sentToBlockchain = false;

    try {
      await this.waitForTransactionDelay();

      if (!this.wallet || !this.keyPair) {
        throw new Error('Wallet not initialized');
      }

      if (!this.walletAddress) {
        throw new Error('Wallet address not initialized');
      }

      if (messages.length > this.MAX_BATCH_SIZE) {
        throw new Error(
          `Batch size ${messages.length} exceeds maximum ${this.MAX_BATCH_SIZE}`,
        );
      }

      if (messages.length === 0) {
        return { success: true };
      }

      this.cleanupRecentBatchHashes();

      const batchHash = this.computeBatchHash(messages);
      const orderIds = messages.map((m) => m.order_id).join(', ');

      this.logger.debug(
        `Attempting to send batch ${batchHash} with orders: ${orderIds}`,
      );

      if (await this.isBatchAlreadySent(batchHash)) {
        const timeSinceLast = this.recentBatchHashes.get(batchHash);
        const timeSinceLastStr = timeSinceLast
          ? `${Date.now() - timeSinceLast}ms ago`
          : 'unknown time ago';

        this.logger.error(
          `DUPLICATE BATCH DETECTED (quick check)! Batch hash ${batchHash} was sent ${timeSinceLastStr}. ` +
            `Order IDs: ${orderIds}. ` +
            `This batch will be rejected to prevent double-spending.`,
        );
        return {
          success: false,
          error: `Duplicate batch detected (hash: ${batchHash}). Batch was already sent.`,
        };
      }

      const acquiredRight = await this.tryAcquireBatchSendRight(batchHash);
      if (!acquiredRight) {
        this.logger.error(
          `DUPLICATE BATCH DETECTED (atomic check)! Another instance is already sending batch ${batchHash}. ` +
            `Order IDs: ${orderIds}. ` +
            `This batch will be rejected to prevent double-spending.`,
        );
        return {
          success: false,
          error: `Duplicate batch detected (hash: ${batchHash}). Another instance is sending this batch.`,
        };
      }

      this.logger.log(
        `Batch ${batchHash} acquired send right for orders: ${orderIds}`,
      );

      if (this.toncenterApis.length > 0) {
        try {
          const walletRaw = this.walletAddress.toRawString();
          const accountResp = await this.toncenterApi!.get(
            'api/v3/accountStates',
            { params: { address: walletRaw, include_boc: false } },
          );
          const accounts = accountResp.data?.accounts || [];
          const status = accounts[0]?.status;
          if (status && status !== 'active') {
            throw new Error(
              `Wallet is not active. Current state: ${status}. Please deploy the wallet first.`,
            );
          }
        } catch (stateError: any) {
          this.logger.error(
            `Failed to get wallet state: ${stateError.message}`,
          );
        }
      }

      const transferMessages = messages.map((msg, _) => {
        const destinationAddress = Address.parse(msg.destination);
        const body = msg.comment
          ? this.createMessageBody(msg.comment)
          : undefined;

        return {
          mode: SendMode.PAY_GAS_SEPARATELY,
          message: internal({
            to: destinationAddress,
            value: toNano(msg.amount.toString()),
            body,
          }),
        };
      });

      const provider = this.tonClient.provider(this.walletAddress, null);

      const chainNow = await this.getChainTime();
      const createdAt = chainNow - this.CREATED_AT_OFFSET_SECONDS;

      try {
        const externalMessageCell = await this.wallet.sendBatch(
          provider,
          this.keyPair.secretKey,
          {
            messages: transferMessages,
            createdAt,
          },
        );

        sentToBlockchain = true;
        const externalMessageHashHex = externalMessageCell
          .hash()
          .toString('hex');
        this.logger.log(
          `Highload sendBatch finished (lite-server accepted BOC); external message cell hash=${externalMessageHashHex}`,
        );

        try {
          const submittedAt = new Date();
          const queueIds = messages.map((m) => m.order_id);
          await this.prisma.fragmentQueue.updateMany({
            where: {
              id: { in: queueIds },
              status: 'PROCESSING',
              tx_hash: null,
            },
            data: {
              outbound_submitted_at: submittedAt,
              external_out_msg_hash: externalMessageHashHex,
              updated_at: submittedAt,
            },
          });
        } catch (dbErr: any) {
          this.logger.warn(
            `Could not persist outbound_submitted_at for batch ${batchHash}: ${dbErr.message}`,
          );
        }

        this.lastTransactionTime = Date.now();

        this.bitNumber++;
        if (this.bitNumber > 1022) {
          this.bitNumber = 0;
          this.shift = (this.shift + 1) % 8192;
        }

        await this.saveWalletState();

        const bodyHashToOrder = new Map<
          string,
          { orderId: string; destination: string; comment: string }
        >();
        const msgsWithComments = messages.filter((m) => m.comment);
        if (msgsWithComments.length > 0) {
          const hashes = await this.computeBodyHashesInPool(
            msgsWithComments.map((m) => m.comment),
          );
          for (let i = 0; i < msgsWithComments.length; i++) {
            if (hashes[i]) {
              bodyHashToOrder.set(hashes[i], {
                orderId: msgsWithComments[i].order_id,
                destination: msgsWithComments[i].destination,
                comment: msgsWithComments[i].comment,
              });
            }
          }
        }

        /** Short yield after wallet accepted the external — v3 indexes outgoing bodies, not this hash. */
        const FIRST_POLL_DELAY_MS = 200;
        const MAX_CONFIRM_ATTEMPTS = 18;
        const RETRY_DELAY_MS = 2_800;

        const confirmedMessages = new Map<
          string,
          { txHash: string; tonscanUrl: string }
        >();

        this.logger.log(
          `Confirming ${bodyHashToOrder.size} outgoing message(s) via Toncenter v3 (first poll in ${FIRST_POLL_DELAY_MS}ms, then every ${RETRY_DELAY_MS}ms)`,
        );

        for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
          if (attempt === 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, FIRST_POLL_DELAY_MS),
            );
          } else {
            this.logger.debug(
              `Confirmation attempt ${attempt + 1}/${MAX_CONFIRM_ATTEMPTS}, confirmed ${confirmedMessages.size}/${bodyHashToOrder.size}...`,
            );
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          }

          const pending = Array.from(bodyHashToOrder.entries()).filter(
            ([, info]) => !confirmedMessages.has(info.orderId),
          );

          const results = await Promise.allSettled(
            pending.map(async ([bodyHash, info]) => {
              const found = await this.findMessageByBodyHash(bodyHash);
              if (found) {
                return { orderId: info.orderId, ...found };
              }
              return null;
            }),
          );

          for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
              const { orderId, txHash: msgTxHash } = result.value;
              confirmedMessages.set(orderId, {
                txHash: msgTxHash,
                tonscanUrl: `https://tonviewer.com/transaction/${msgTxHash}`,
              });
            }
          }

          if (confirmedMessages.size >= bodyHashToOrder.size) {
            this.logger.log(
              `All ${confirmedMessages.size} messages confirmed via v3 API (attempt ${attempt + 1})`,
            );
            break;
          }
        }

        let txHash: string | undefined;
        let txHashHex: string | undefined;
        let tonscanUrl: string | undefined;

        const firstConfirmed = confirmedMessages.values().next().value as
          | { txHash: string; tonscanUrl: string }
          | undefined;
        if (firstConfirmed) {
          txHashHex = firstConfirmed.txHash;
          txHash = firstConfirmed.txHash;
          tonscanUrl = firstConfirmed.tonscanUrl;
        }

        if (confirmedMessages.size > 0) {
          await this.markBatchAsCompleted(
            batchHash,
            txHashHex || txHash || batchHash,
          );
          this.logger.log(
            `Batch ${batchHash} completed: ${confirmedMessages.size}/${bodyHashToOrder.size} confirmed via v3 API`,
          );
        } else {
          this.logger.warn(
            `Batch ${batchHash} was sent but NO messages confirmed via v3 API after ${MAX_CONFIRM_ATTEMPTS} attempts. ` +
              `Recovery cron will verify. Batch send right KEPT to prevent duplicate sends.`,
          );
        }

        return {
          success: true,
          sentToBlockchain,
          externalMessageHashHex,
          txHash,
          txHashHex,
          tonscanUrl,
          confirmedMessages:
            confirmedMessages.size > 0 ? confirmedMessages : undefined,
        };
      } catch (sendError: any) {
        this.logger.error(
          `Error details: ${JSON.stringify({
            message: sendError.message,
            code: sendError.code,
            response: sendError.response?.data,
            status: sendError.response?.status,
          })}`,
        );
        throw sendError;
      }
    } catch (error: any) {
      this.logger.error(`Failed to batch transfer: ${error.message}`);

      try {
        const balance = await this.getBalance();
        this.logger.error(`Current wallet balance: ${balance} TON`);
      } catch {
        this.logger.error('Could not fetch wallet balance for error logging');
      }

      const batchHash = this.computeBatchHash(messages);

      if (sentToBlockchain) {
        this.logger.error(
          `Batch ${batchHash} was SENT TO BLOCKCHAIN but error occurred after: ${error.message}. ` +
            `Keeping batch send right locked to prevent duplicate sends.`,
        );
        return {
          success: false,
          sentToBlockchain: true,
          error: error.message || 'Failed to send batch transfer',
        };
      }

      await this.clearBatchSendRight(batchHash);
      this.logger.warn(
        `Cleared batch hash ${batchHash} from Redis after real send failure (not sent to blockchain) to allow retry`,
      );

      let errorMessage = error.message || 'Failed to send batch transfer';
      let isExitCode36 = false;
      let isExitCode35 = false;

      const errorStringified = JSON.stringify(
        error.response?.data ?? error.response ?? {},
      );
      if (
        error.message?.includes('exitcode=36') ||
        errorStringified.includes('exitcode=36')
      ) {
        isExitCode36 = true;
        errorMessage =
          error.response?.error ||
          error.response?.data?.error ||
          error.message ||
          'exitcode=36: queryId already used';
      }

      if (
        !isExitCode36 &&
        (error.message?.includes('exitcode=35') ||
          errorStringified.includes('exitcode=35'))
      ) {
        isExitCode35 = true;
        errorMessage =
          error.response?.error ||
          error.response?.data?.error ||
          error.message ||
          'exitcode=35: invalid_created_at (Toncenter liteserver lag)';
      }

      if (isExitCode36) {
        const skipCount = 50;
        this.logger.warn(
          `exitcode=36 detected in batchTransfer — advancing sequence by ${skipCount} to avoid reusing queryIds (current: shift=${this.shift}, bitNumber=${this.bitNumber})`,
        );
        for (let i = 0; i < skipCount; i++) {
          this.bitNumber++;
          if (this.bitNumber > 1022) {
            this.bitNumber = 0;
            this.shift = (this.shift + 1) % 8192;
          }
        }
        await this.saveWalletState();
        this.logger.warn(
          `Sequence advanced to shift=${this.shift}, bitNumber=${this.bitNumber} and saved to DB`,
        );
      }

      if (isExitCode35) {
        // The wallet contract rejected the external message at the
        // `created_at <= now()` check (highload-wallet-v3 error 35,
        // `error::invalid_created_at`). The check fires BEFORE
        // `accept_message()`, so no queryId was consumed and the message was
        // never propagated to the network — `sentToBlockchain` stays false.
        // Most common cause: the Toncenter liteserver that pre-validated our
        // message has a stale view of the masterchain head, so its `now()` is
        // behind our `createdAt` by more than the offset.
        // Drop the chain-time cache so the next attempt re-fetches a fresh
        // `gen_utime` (very likely from a different upstream).
        this.chainTimeCache = null;
        this.logger.warn(
          `exitcode=35 (invalid_created_at) in batchTransfer — Toncenter liteserver ` +
            `lags behind chain head, our createdAt landed in its "future". ` +
            `No queryId consumed, no on-chain effect. Will retry next cycle with fresh chain time. ` +
            `(createdAt offset: ${this.CREATED_AT_OFFSET_SECONDS}s)`,
        );
      }

      return {
        success: false,
        sentToBlockchain: false,
        error: errorMessage,
        isExitCode36,
        isExitCode35,
      };
    }
  }

  private async waitForTransactionDelay(): Promise<void> {
    const currentTime = Date.now();
    const timeSinceLast = currentTime - this.lastTransactionTime;

    if (timeSinceLast < this.MIN_TRANSACTION_DELAY) {
      const waitTime = this.MIN_TRANSACTION_DELAY - timeSinceLast;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  getAddress(): string | null {
    return this.walletAddress?.toString() || null;
  }

  isInitialized(): boolean {
    return this.wallet !== null && this.keyPair !== null;
  }

  isToncenterConfigured(): boolean {
    return this.toncenterApis.length > 0;
  }

  estimateBatchFees(
    messagesCount: number,
    avgPayloadSize: number = 100,
  ): number {
    const BASE_TX_FEE = 0.01;
    const FEE_PER_MESSAGE = 0.005;
    const FEE_PER_CELL = 0.0005;
    const CELLS_PER_MESSAGE = Math.ceil(avgPayloadSize / 127);
    const FORWARD_FEE = 0.003;

    const STORAGE_BUFFER = 0.005;

    const messageFees = messagesCount * FEE_PER_MESSAGE;
    const cellFees = messagesCount * CELLS_PER_MESSAGE * FEE_PER_CELL;
    const forwardFees = messagesCount * FORWARD_FEE;

    const totalFee =
      BASE_TX_FEE + messageFees + cellFees + forwardFees + STORAGE_BUFFER;

    const feeWithBuffer = totalFee * 1.2;

    this.logger.debug(
      `Estimated fees for ${messagesCount} messages: ${feeWithBuffer.toFixed(4)} TON ` +
        `(base=${BASE_TX_FEE}, msg=${messageFees.toFixed(4)}, cell=${cellFees.toFixed(4)}, fwd=${forwardFees.toFixed(4)})`,
    );

    return feeWithBuffer;
  }

  isTransactionExpired(
    validUntil: number | undefined,
    bufferSeconds: number = 60,
  ): boolean {
    if (!validUntil) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = validUntil - now;

    if (expiresIn <= bufferSeconds) {
      this.logger.warn(
        `Transaction expired or expiring soon: validUntil=${validUntil}, ` +
          `now=${now}, expiresIn=${expiresIn}s (buffer=${bufferSeconds}s)`,
      );
      return true;
    }

    return false;
  }

  private async findMessageByBodyHash(
    bodyHash: string,
  ): Promise<{ txHash: string; timestamp: number } | null> {
    const r = await this.findByBodyHashViaToncenter(bodyHash);
    if (r.ok === false) {
      this.logger.debug(
        `findMessageByBodyHash: Toncenter lookup not ok (${r.reason})`,
      );
      return null;
    }
    if (!r.found) {
      return null;
    }
    return { txHash: r.txHash, timestamp: r.timestamp };
  }

  private get TONCENTER_BATCH_RPS(): number {
    return Math.max(this.toncenterApis.length, 1) * 80;
  }

  private async runWithRateLimit<T>(
    tasks: (() => Promise<T>)[],
    maxPerSecond: number,
  ): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = [];
    for (let i = 0; i < tasks.length; i += maxPerSecond) {
      const chunk = tasks.slice(i, i + maxPerSecond);
      const chunkResults = await Promise.allSettled(
        chunk.map((task) => task()),
      );
      results.push(...chunkResults);
      if (i + maxPerSecond < tasks.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return results;
  }

  async checkCommentsInBatch(
    comments: { orderId: string; comment: string }[],
  ): Promise<{
    results: Map<string, { txHash: string; timestamp: number }>;
    exhaustive: boolean;
  }> {
    const results = new Map<string, { txHash: string; timestamp: number }>();

    if (!this.walletAddress || comments.length === 0) {
      return { results, exhaustive: true };
    }

    if (this.toncenterApis.length === 0) {
      this.logger.warn(
        `checkCommentsInBatch: Toncenter NOT configured — cannot verify ${comments.length} comment(s)`,
      );
      return { results, exhaustive: false };
    }

    try {
      const hashToOrders = new Map<
        string,
        { orderId: string; comment: string }[]
      >();
      const validComments = comments.filter((c) => c.comment);
      if (validComments.length > 0) {
        const payloads = validComments.map((c) => c.comment);
        const hashes = await this.computeBodyHashesInPool(payloads);
        for (let i = 0; i < validComments.length; i++) {
          const bodyHash = hashes[i];
          if (!bodyHash) continue;
          const existing = hashToOrders.get(bodyHash) || [];
          existing.push(validComments[i]);
          hashToOrders.set(bodyHash, existing);
        }
      }

      if (hashToOrders.size === 0) {
        return { results, exhaustive: true };
      }

      const entries = Array.from(hashToOrders.entries());
      let found = 0;
      let checked = 0;
      let failed = 0;

      const tasks = entries.map(([bodyHash, orders]) => async () => {
        const tcResult = await this.findByBodyHashViaToncenter(bodyHash);
        if (tcResult.ok === false) {
          throw new Error(tcResult.reason);
        }
        if (tcResult.found) {
          for (const order of orders) {
            if (!results.has(order.orderId)) {
              results.set(order.orderId, {
                txHash: tcResult.txHash,
                timestamp: tcResult.timestamp,
              });
              found++;
            }
          }
        }
      });

      const settled = await this.runWithRateLimit(
        tasks,
        this.TONCENTER_BATCH_RPS,
      );

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          checked++;
        } else {
          failed++;
        }
      }

      this.logger.log(
        `Batch comment check (Toncenter): ${checked}/${entries.length} checked, ` +
          `${found} duplicate(s) found, ${failed} failed` +
          `${entries.length > this.TONCENTER_BATCH_RPS ? ` (rate-limited to ${this.TONCENTER_BATCH_RPS}/sec)` : ''}`,
      );

      const exhaustive = failed === 0 && checked === entries.length;

      if (!exhaustive) {
        this.logger.warn(
          `INCOMPLETE CHECK: ${failed}/${entries.length} Toncenter lookups failed. ` +
            `Callers MUST treat unmatched as UNCERTAIN, not as "definitely absent".`,
        );
      }

      return { results, exhaustive };
    } catch (error: any) {
      this.logger.error(`Error in batch comment check: ${error.message}`);
      throw error;
    }
  }

  async findByBodyHashViaToncenter(
    bodyHash: string,
  ): Promise<BodyHashLookupResult> {
    if (this.toncenterApis.length === 0 || !this.walletAddress) {
      return { ok: false, reason: 'Toncenter or wallet not configured' };
    }

    const walletRaw = this.walletAddress.toRawString();

    try {
      return await withRetry(
        async (): Promise<BodyHashLookupResult> => {
          const response = await this.toncenterApi!.get(
            'api/v3/transactionsByMessage',
            {
              params: {
                body_hash: bodyHash,
                direction: 'out',
                limit: 1,
              },
            },
          );

          const transactions = response.data?.transactions;
          if (!transactions || transactions.length === 0) {
            return { ok: true, found: false };
          }

          const tx = transactions[0];
          const txAccount = tx.account;

          if (txAccount && txAccount.toLowerCase() !== walletRaw.toLowerCase()) {
            const walletFriendly = this.walletAddress!.toString();
            if (txAccount !== walletFriendly) {
              return { ok: true, found: false };
            }
          }

          const txHashRaw = tx.hash;
          const txHash = /^[0-9a-f]{64}$/i.test(txHashRaw)
            ? txHashRaw
            : Buffer.from(txHashRaw, 'base64').toString('hex');
          const timestamp = tx.now || 0;

          return { ok: true, found: true, txHash, timestamp };
        },
        {
          maxAttempts: 5,
          delayMs: 400,
          exponentialBackoff: true,
          shouldRetry: isBlockchainApiRetryable,
        },
      );
    } catch (error: any) {
      this.logger.warn(
        `Toncenter body_hash lookup failed after retries: ${error.message}`,
      );
      return {
        ok: false,
        reason: error.message || 'Toncenter error',
      };
    }
  }

  async checkTransactionByComment(comment: string): Promise<{
    found: boolean;
    txHash?: string;
    timestamp?: number;
    exhaustive: boolean;
  }> {
    if (!this.walletAddress) {
      this.logger.warn('Wallet not initialized for comment check');
      return { found: false, exhaustive: false };
    }

    if (!comment) {
      return { found: false, exhaustive: true };
    }

    if (this.toncenterApis.length === 0) {
      this.logger.warn(
        `checkTransactionByComment: Toncenter NOT configured — cannot verify`,
      );
      return { found: false, exhaustive: false };
    }

    try {
      const [bodyHash] = await this.computeBodyHashesInPool([comment]);
      if (!bodyHash) {
        this.logger.warn('Could not create expected body from comment');
        return { found: false, exhaustive: false };
      }

      const toncenterResult = await this.findByBodyHashViaToncenter(bodyHash);
      if (toncenterResult.ok === false) {
        this.logger.warn(
          `checkTransactionByComment: Toncenter lookup failed: ${toncenterResult.reason}`,
        );
        return { found: false, exhaustive: false };
      }
      if (toncenterResult.found) {
        this.logger.log(
          `Found transaction by body_hash via Toncenter: ${toncenterResult.txHash}`,
        );
        return {
          found: true,
          txHash: toncenterResult.txHash,
          timestamp: toncenterResult.timestamp,
          exhaustive: true,
        };
      }

      return { found: false, exhaustive: true };
    } catch (error: any) {
      this.logger.error(
        `Error checking transaction by comment: ${error.message}`,
      );
      return { found: false, exhaustive: false };
    }
  }

  /**
   * Called by Toncenter streaming listener on confirmed/finalized wallet activity.
   * This method is intentionally lightweight: it checks recent submitted queue items
   * and marks them completed as soon as message body hash appears in indexer.
   */
  async processStreamingConfirmationHint(
    finality: 'confirmed' | 'finalized',
  ): Promise<void> {
    if (this.streamingHintInFlight) {
      return;
    }
    if (!this.walletAddress || this.toncenterApis.length === 0) {
      return;
    }

    this.streamingHintInFlight = true;
    try {
      const recentCutoff = new Date(Date.now() - 60 * 60 * 1000);
      const candidates = await this.prisma.fragmentQueue.findMany({
        where: {
          status: 'PROCESSING',
          tx_hash: null,
          outbound_submitted_at: { gte: recentCutoff },
          ton_comment: { not: null },
        },
        select: {
          id: true,
          ton_comment: true,
        },
        orderBy: { outbound_submitted_at: 'desc' },
        take: 30,
      });

      if (candidates.length === 0) {
        return;
      }

      let markedCount = 0;
      for (const item of candidates) {
        if (!item.ton_comment) {
          continue;
        }
        const [bodyHash] = await this.computeBodyHashesInPool([item.ton_comment]);
        if (!bodyHash) {
          continue;
        }

        const found = await this.findByBodyHashViaToncenter(bodyHash);
        if (!found.ok || !found.found) {
          continue;
        }

        const updateResult = await this.prisma.fragmentQueue.updateMany({
          where: {
            id: item.id,
            status: 'PROCESSING',
            tx_hash: null,
          },
          data: {
            status: 'COMPLETED',
            tx_hash: found.txHash,
            retry_count: 0,
            outbound_submitted_at: null,
            external_out_msg_hash: null,
          },
        });

        if (updateResult.count > 0) {
          markedCount += 1;
          await this.redisLock.markQueueItemCompleted(item.id, found.txHash);
        }
      }

      if (markedCount > 0) {
        this.logger.log(
          `Streaming hint (${finality}): marked ${markedCount} queue item(s) COMPLETED`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `processStreamingConfirmationHint failed: ${error.message}`,
      );
    } finally {
      this.streamingHintInFlight = false;
    }
  }
}
