import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';
import { Address } from '@ton/ton';
import { beginCell } from '@ton/core';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface FindTransactionResult {
  found: boolean;
  txHash?: string;
  allTxHashes?: string[];
  actualAmountNano?: bigint;
  partialAmountNano?: bigint;
}

@Injectable()
export class TonPaymentService {
  private readonly logger = new Logger(TonPaymentService.name);
  private readonly WALLET: string;

  private readonly AMOUNT_TOLERANCE_PERCENT = 1;

  private usedTxHashesLocal = new Set<string>();
  private readonly MAX_USED_TX_HASHES = 10000;

  private readonly toncenterApis: AxiosInstance[] = [];
  private toncenterRoundRobin = 0;

  private get toncenterApi(): AxiosInstance {
    const api =
      this.toncenterApis[this.toncenterRoundRobin % this.toncenterApis.length];
    this.toncenterRoundRobin =
      (this.toncenterRoundRobin + 1) % this.toncenterApis.length;
    return api;
  }

  constructor(private readonly redisLock: RedisLockService) {
    this.WALLET = process.env.WALLET_ADDRESS || '';

    const toncenterKeys = (process.env.TONCENTER_API_KEY || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (toncenterKeys.length === 0) {
      return;
    }

    for (const key of toncenterKeys) {
      this.toncenterApis.push(
        axios.create({
          baseURL: 'https://toncenter.com/',
          timeout: 10_000,
          headers: { 'X-Api-Key': key },
          httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
        }),
      );
    }
    this.logger.log(
      `Toncenter API configured for incoming payment lookups (${this.toncenterApis.length} key(s))`,
    );
  }

  private createCommentBodyHash(comment: string): string {
    const body = beginCell()
      .storeUint(0, 32)
      .storeStringTail(comment)
      .endCell();
    return body.hash().toString('hex');
  }

  private tonToNano(tonAmount: string): bigint {
    const [intPart, decPart = ''] = tonAmount.split('.');
    const paddedDec = decPart.padEnd(9, '0').slice(0, 9);
    return BigInt(intPart + paddedDec);
  }

  async findTransaction(value: string, comment: string): Promise<boolean> {
    const result = await this.findTransactionWithHash(value, comment);
    return result.found;
  }

  async findTransactionWithHash(
    value: string,
    comment: string,
  ): Promise<FindTransactionResult> {
    try {
      const valueInNano = this.tonToNano(value);
      const walletRaw = Address.parse(this.WALLET).toRawString();

      const uuidMatch = comment.match(UUID_REGEX);
      const uuid = uuidMatch ? uuidMatch[0].toLowerCase() : null;

      let partialAmountNano: bigint | undefined;

      if (uuid) {
        const bodyHash = this.createCommentBodyHash(uuid);
        let response: any;
        try {
          response = await this.toncenterApi.get(
            'api/v3/transactionsByMessage',
            {
              params: { body_hash: bodyHash, direction: 'in', limit: 10 },
            },
          );
        } catch (error: any) {
          this.logger.error(`Failed to find transaction: ${error.message}`);
          throw new Error(`Failed to find transaction: ${error.message}`);
        }

        const result = await this.matchTransactions(
          response.data?.transactions || [],
          walletRaw,
          valueInNano,
          uuid,
        );
        if (result.found) return result;
        partialAmountNano = result.partialAmountNano;
      }

      if (uuid) {
        const fallback = await this.findByUuidInRecentTransactions(
          uuid,
          valueInNano,
          walletRaw,
        );
        if (fallback.found) return fallback;
        if (fallback.partialAmountNano !== undefined) {
          partialAmountNano = fallback.partialAmountNano;
        }
      }

      return { found: false, partialAmountNano };
    } catch (error: any) {
      this.logger.error(`Failed to find transaction: ${error.message}`);
      throw new Error(`Failed to find transaction: ${error.message}`);
    }
  }

  private async matchTransactions(
    transactions: any[],
    walletRaw: string,
    valueInNano: bigint,
    label: string,
  ): Promise<FindTransactionResult> {
    const toleranceNumerator = BigInt(
      Math.round(this.AMOUNT_TOLERANCE_PERCENT * 10),
    );
    const tolerance = (valueInNano * toleranceNumerator) / 1000n;
    const minTolerance = BigInt(1000000);
    const effectiveTolerance =
      tolerance > minTolerance ? tolerance : minTolerance;

    const validTxs: Array<{ txHash: string; txValue: bigint }> = [];

    for (const tx of transactions) {
      const inMsg = tx.in_msg;
      if (!inMsg) continue;

      const dest = inMsg.destination?.address;
      if (dest && dest.toLowerCase() !== walletRaw.toLowerCase()) continue;

      const txHashRaw = tx.hash;
      const txHash = /^[0-9a-f]{64}$/i.test(txHashRaw)
        ? txHashRaw
        : Buffer.from(txHashRaw, 'base64').toString('hex');

      if (txHash && (await this.isTxHashUsed(txHash))) {
        this.logger.warn(`TxHash ${txHash} already used, skipping`);
        continue;
      }

      const txValue = BigInt(inMsg.value || '0');
      if (txValue > 0n) {
        validTxs.push({ txHash, txValue });
      }
    }

    if (validTxs.length === 0) {
      return { found: false };
    }

    const totalNano = validTxs.reduce((sum, tx) => sum + tx.txValue, 0n);
    const underpayment = valueInNano > totalNano ? valueInNano - totalNano : 0n;

    if (underpayment <= effectiveTolerance) {
      const primaryTx = validTxs.reduce((best, tx) =>
        tx.txValue > best.txValue ? tx : best,
      );
      const allTxHashes = validTxs.map((tx) => tx.txHash);
      this.logger.log(
        `Found incoming payment (${validTxs.length} tx, total ${totalNano} nano) for "${label}"`,
      );
      return {
        found: true,
        txHash: primaryTx.txHash,
        allTxHashes,
        actualAmountNano: totalNano,
      };
    }

    return { found: false, partialAmountNano: totalNano };
  }

  private async findByUuidInRecentTransactions(
    uuid: string,
    valueInNano: bigint,
    walletRaw: string,
  ): Promise<FindTransactionResult> {
    try {
      const response = await this.toncenterApi.get('api/v3/transactions', {
        params: { account: walletRaw, limit: 100 },
      });

      const matching = (response.data?.transactions || []).filter((tx: any) => {
        const inMsg = tx.in_msg;
        if (!inMsg) return false;
        const dest = inMsg.destination?.address;
        if (dest && dest.toLowerCase() !== walletRaw.toLowerCase())
          return false;
        const msgComment: string =
          inMsg.message_content?.decoded?.comment || '';
        const m = msgComment.match(UUID_REGEX);
        return m && m[0].toLowerCase() === uuid;
      });

      return this.matchTransactions(matching, walletRaw, valueInNano, uuid);
    } catch (error: any) {
      this.logger.warn(`UUID fallback search failed: ${error.message}`);
      return { found: false };
    }
  }

  async markTxHashAsUsed(txHash: string): Promise<void> {
    if (this.redisLock.isAvailable()) {
      await this.redisLock.markTxHashAsUsed(txHash);
    }

    this.usedTxHashesLocal.add(txHash);

    if (this.usedTxHashesLocal.size > this.MAX_USED_TX_HASHES) {
      const entries = Array.from(this.usedTxHashesLocal);
      entries.slice(0, entries.length / 2).forEach((hash) => {
        this.usedTxHashesLocal.delete(hash);
      });
    }
  }

  async isTxHashUsed(txHash: string): Promise<boolean> {
    if (this.usedTxHashesLocal.has(txHash)) {
      return true;
    }

    if (this.redisLock.isAvailable()) {
      const usedInRedis = await this.redisLock.isTxHashUsed(txHash);
      if (usedInRedis) {
        this.usedTxHashesLocal.add(txHash);
        return true;
      }
    }

    return false;
  }

  async markTxHashAsUsedIfNotUsed(txHash: string): Promise<boolean> {
    if (this.redisLock.isAvailable()) {
      const wasMarked = await this.redisLock.markTxHashAsUsedWithNX(txHash);
      if (wasMarked) {
        this.usedTxHashesLocal.add(txHash);
        return true;
      }
      return false;
    }

    if (this.usedTxHashesLocal.has(txHash)) {
      return false;
    }

    this.usedTxHashesLocal.add(txHash);
    return true;
  }

  async detectAddress(address: string): Promise<string | null> {
    try {
      const parsed = Address.parse(address);
      return parsed.toString({ bounceable: true, urlSafe: true });
    } catch (error: any) {
      this.logger.error(`Failed to detect address: ${error.message}`);
      return null;
    }
  }

  clearUsedTxHashes(): void {
    this.usedTxHashesLocal.clear();
  }
}
