import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface RapiraSymbol {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  chg: number;
  change: number;
  volume?: number;
  turnover?: number;
  fee: number;
  lastDayClose: number;
  usdRate: number;
  baseUsdRate: number;
  zone?: number;
  baseCoinScale: number;
  coinScale: number;
  quoteCurrencyName: string;
  baseCurrency: string;
  quoteCurrency: string;
}

/** https://api.rapira.net/open/market/rates — public; `/market/symbol-thumb` returns 403 for many clients */
interface RapiraRatesEnvelope {
  data: RapiraSymbol[];
  code?: number;
  message?: string;
}

interface CurrencyRatesCache {
  usdtToRub: number;
  tonToUsdt: number;
  tonToUsd: number;
  tonToRub: number;
  timestamp: number;
}

@Injectable()
export class RapiraService {
  private readonly logger = new Logger(RapiraService.name);
  private readonly CACHE_TTL = 5 * 60 * 1000;
  private readonly API_URL = 'https://api.rapira.net/open/market/rates';

  private ratesCache: CurrencyRatesCache | null = null;

  private async fetchAllRates(): Promise<CurrencyRatesCache> {
    try {
      const response = await axios.get<RapiraRatesEnvelope>(this.API_URL, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
        },
      });

      const rows = response.data?.data;
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Invalid or empty Rapira API response');
      }

      let usdtToRub: number | null = null;
      let tonToUsdt: number | null = null;

      for (const item of rows) {
        if (item.symbol === 'USDT/RUB') {
          usdtToRub = item.close;
        }
        if (item.symbol === 'TON/USDT') {
          tonToUsdt = item.close;
        }

        if (usdtToRub && tonToUsdt) {
          break;
        }
      }

      if (!usdtToRub) {
        throw new Error('USDT/RUB rate not found in Rapira API response');
      }

      if (!tonToUsdt) {
        throw new Error('TON/USDT rate not found in Rapira API response');
      }

      const tonToUsd = tonToUsdt;
      const tonToRub = tonToUsdt * usdtToRub;

      const rates: CurrencyRatesCache = {
        usdtToRub,
        tonToUsdt,
        tonToUsd,
        tonToRub,
        timestamp: Date.now(),
      };

      this.ratesCache = rates;
      return rates;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch rates from Rapira API: ${error.message}`,
      );

      if (this.ratesCache) {
        this.logger.warn('Using stale cache due to API error');
        return this.ratesCache;
      }

      throw error;
    }
  }

  private async getRates(): Promise<CurrencyRatesCache> {
    if (this.ratesCache && this.isCacheValid(this.ratesCache)) {
      return this.ratesCache;
    }

    return await this.fetchAllRates();
  }

  async getUsdtToRubRate(): Promise<number> {
    const rates = await this.getRates();
    return rates.usdtToRub;
  }

  async getTonToUsdRate(): Promise<number> {
    const rates = await this.getRates();
    return rates.tonToUsd;
  }

  async getTonToRubRate(): Promise<number> {
    const rates = await this.getRates();
    return rates.tonToRub;
  }

  async usdToTon(amountUsd: number = 1): Promise<number> {
    const rate = await this.getTonToUsdRate();
    return amountUsd / rate;
  }

  async tonToUsd(amountTon: number = 1): Promise<number> {
    const rate = await this.getTonToUsdRate();
    return amountTon * rate;
  }

  private isCacheValid(cache: CurrencyRatesCache): boolean {
    return Date.now() - cache.timestamp < this.CACHE_TTL;
  }

  async refreshRates(): Promise<void> {
    await this.fetchAllRates();
  }

  async getFreshRates(): Promise<{ tonToUsd: number; usdtToRub: number }> {
    const rates = await this.fetchAllRates();
    return {
      tonToUsd: rates.tonToUsd,
      usdtToRub: rates.usdtToRub,
    };
  }

  async getCachedRates(): Promise<{ tonToUsd: number; usdtToRub: number }> {
    const rates = await this.getRates();
    return {
      tonToUsd: rates.tonToUsd,
      usdtToRub: rates.usdtToRub,
    };
  }
}
