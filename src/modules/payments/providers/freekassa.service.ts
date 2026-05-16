import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';

export interface CreateFreekassaPaymentParams {
  /** MERCHANT_ORDER_ID / paymentId (у нас — order_number). */
  orderId: string;
  amountRub: number;
  /**
   * ID способа оплаты (§8 / API `i`): СБП 4.2 = 44, карты 5.7 = 36, USDT TRC20 = 15.
   * СБП и карты — API → paymentt.kassa.ai; крипто — SCI pay.fk.money.
   */
  suggestedMethodId?: number;
  /** Email плательщика (обязателен для API СБП). */
  payerEmail?: string;
}

interface FkApiCreateOrderResponse {
  type?: string;
  location?: string;
  orderId?: number;
  orderHash?: string;
  error?: string;
  message?: string;
}

/**
 * Freekassa:
 * - СБП (i=44), карты 5.7 (i=36): API https://api.fk.life/v1/orders/create → paymentt.kassa.ai
 * - Крипто и др.: SCI GET https://pay.fk.money/
 * Webhook: md5(MERCHANT_ID:AMOUNT:secret2:MERCHANT_ORDER_ID)
 * @see https://docs.freekassa.ru/
 */
const IP_LOOKUP_URLS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
];

@Injectable()
export class FreekassaService {
  private readonly logger = new Logger(FreekassaService.name);
  private readonly SCI_PAY_URL = 'https://pay.fk.money/';
  private readonly API_BASE_URL = 'https://api.fk.life/v1';

  private cachedPayerIp: string | null = null;
  private payerIpLookup: Promise<string> | null = null;

  private static readonly SBP_METHOD_ID = () =>
    parseInt(process.env.FREEKASSA_SBP_CUR_ID || '44', 10);

  private static readonly CARD_METHOD_ID = () =>
    parseInt(process.env.FREEKASSA_CARD_CUR_ID || '36', 10);

  private static apiMethodIds(): number[] {
    return [FreekassaService.SBP_METHOD_ID(), FreekassaService.CARD_METHOD_ID()];
  }

  formatAmountForSign(amountRub: number): string {
    return amountRub.toFixed(2);
  }

  buildFormSignature(params: {
    merchantId: string;
    amountStr: string;
    secret1: string;
    currency: string;
    orderId: string;
  }): string {
    const raw = `${params.merchantId}:${params.amountStr}:${params.secret1}:${params.currency}:${params.orderId}`;
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  verifyNotificationSignature(params: {
    merchantId: string;
    amount: string;
    secret2: string;
    orderId: string;
    sign: string;
  }): boolean {
    const raw = `${params.merchantId}:${params.amount}:${params.secret2}:${params.orderId}`;
    const expected = crypto.createHash('md5').update(raw).digest('hex');
    return expected.toLowerCase() === params.sign.toLowerCase();
  }

  private buildApiSignature(
    params: Record<string, string | number>,
  ): string {
    const apiKey = process.env.FREEKASSA_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Freekassa API: FREEKASSA_API_KEY is required for SBP');
    }

    const signData = { ...params };
    delete (signData as { signature?: string }).signature;

    const sortedKeys = Object.keys(signData).sort();
    const msg = sortedKeys.map((k) => String(signData[k])).join('|');

    return crypto
      .createHmac('sha256', apiKey)
      .update(msg)
      .digest('hex');
  }

  private resolvePayerIpFromEnv(): string | undefined {
    return (
      process.env.FREEKASSA_API_PAYER_IP?.trim() ||
      process.env.WEBHOOK_IP?.trim() ||
      process.env.SERVER_PUBLIC_IP?.trim() ||
      undefined
    );
  }

  private async resolvePayerIp(): Promise<string> {
    const fromEnv = this.resolvePayerIpFromEnv();
    if (fromEnv) {
      return fromEnv;
    }

    if (this.cachedPayerIp) {
      return this.cachedPayerIp;
    }

    if (!this.payerIpLookup) {
      this.payerIpLookup = this.fetchPublicIp();
    }

    this.cachedPayerIp = await this.payerIpLookup;
    return this.cachedPayerIp;
  }

  private async fetchPublicIp(): Promise<string> {
    for (const url of IP_LOOKUP_URLS) {
      try {
        const { data } = await axios.get<string>(url, { timeout: 5000 });
        const ip = String(data).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          this.logger.log(`Freekassa API: detected public IP ${ip}`);
          return ip;
        }
      } catch {
        /* try next */
      }
    }

    this.logger.error(
      'Freekassa API: set FREEKASSA_API_PAYER_IP to your server public outbound IP (ЛК Freekassa → API)',
    );
    return '127.0.0.1';
  }

  private nextNonce(): number {
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }

  private formatApiError(error: unknown, responseData?: unknown): string {
    const data = responseData as Record<string, unknown> | undefined;
    const parts: string[] = [];

    if (data?.message) parts.push(String(data.message));
    if (data?.error) parts.push(String(data.error));
    if (data?.errors && typeof data.errors === 'object') {
      parts.push(JSON.stringify(data.errors));
    }

    if (parts.length > 0) {
      return parts.join('; ');
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown API error';
  }

  private usesApiMethod(methodId?: number): boolean {
    if (typeof methodId !== 'number' || !Number.isFinite(methodId)) {
      return false;
    }
    return FreekassaService.apiMethodIds().includes(methodId);
  }

  async createPayment(
    params: CreateFreekassaPaymentParams,
  ): Promise<{ id: string; url: string }> {
    if (this.usesApiMethod(params.suggestedMethodId)) {
      return this.createPaymentViaApi(params);
    }
    return this.createPaymentViaSci(params);
  }

  /** API v1 — СБП / карты, страница оплаты paymentt.kassa.ai */
  private async createPaymentViaApi(
    params: CreateFreekassaPaymentParams,
  ): Promise<{ id: string; url: string }> {
    const shopIdRaw = process.env.FREEKASSA_MERCHANT_ID?.trim();
    if (!shopIdRaw) {
      throw new Error('Freekassa API: FREEKASSA_MERCHANT_ID is required');
    }

    const shopId = parseInt(shopIdRaw, 10);
    if (!Number.isFinite(shopId)) {
      throw new Error('Freekassa API: FREEKASSA_MERCHANT_ID must be numeric');
    }

    const amount = Number(params.amountRub);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid Freekassa amount: ${params.amountRub}`);
    }

    const orderId = params.orderId?.trim();
    if (!orderId) {
      throw new Error('Freekassa: orderId is required');
    }

    const paymentSystemId =
      params.suggestedMethodId ?? FreekassaService.SBP_METHOD_ID();
    const email =
      params.payerEmail?.trim() ||
      `order_${orderId}@telegram.org`;

    const amountStr = this.formatAmountForSign(amount);
    const payerIp = await this.resolvePayerIp();

    if (payerIp === '127.0.0.1' && !this.resolvePayerIpFromEnv()) {
      this.logger.warn(
        'Freekassa API: using 127.0.0.1 as ip — set FREEKASSA_API_PAYER_IP to avoid "Оплата временно не доступна"',
      );
    }

    const body: Record<string, string | number> = {
      shopId,
      nonce: this.nextNonce(),
      paymentId: orderId,
      i: paymentSystemId,
      email,
      ip: payerIp,
      amount: amountStr,
      currency: 'RUB',
    };
    body.signature = this.buildApiSignature(body);

    this.logger.log(
      `Freekassa API create order ${orderId}, i=${paymentSystemId}, amount=${amountStr}, ip=${payerIp}`,
    );

    try {
      await this.assertPaymentSystemAvailable(shopId, paymentSystemId);

      const { status, data } = await axios.post<FkApiCreateOrderResponse>(
        `${this.API_BASE_URL}/orders/create`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30_000,
          validateStatus: () => true,
        },
      );

      if (status >= 400 || data.type === 'error' || !data.location) {
        const errMsg = this.formatApiError(null, data);
        this.logger.error(
          `Freekassa API create rejected (HTTP ${status}): ${errMsg} | body=${JSON.stringify(data)}`,
        );
        if (errMsg.includes('временно не доступна')) {
          throw new Error(
            `Способ оплаты i=${paymentSystemId} недоступен. В ЛК Freekassa включите метод и укажите публичный IP (WEBHOOK_IP / FREEKASSA_API_PAYER_IP).`,
          );
        }
        throw new Error(`Freekassa API: ${errMsg}`);
      }

      const location = data.location?.trim();
      if (!location) {
        throw new Error('Freekassa API did not return payment URL (location)');
      }

      if (!location.includes('paymentt.kassa.ai')) {
        this.logger.warn(
          `Freekassa API location is not paymentt.kassa.ai: ${location}`,
        );
      }

      this.logger.debug(`Freekassa API payment URL for order ${orderId}: ${location}`);

      return { id: orderId, url: location };
    } catch (error: any) {
      const responseData = error.response?.data;
      const detail = this.formatApiError(error, responseData);
      this.logger.error(
        `Freekassa API create failed: ${detail}` +
          (responseData ? ` | response=${JSON.stringify(responseData)}` : ''),
      );

      throw new Error(`Freekassa API: ${detail}`);
    }
  }

  /** POST /currencies/{id}/status — диагностика перед созданием заказа */
  private async assertPaymentSystemAvailable(
    shopId: number,
    paymentSystemId: number,
  ): Promise<void> {
    const body: Record<string, string | number> = {
      shopId,
      nonce: this.nextNonce(),
    };
    body.signature = this.buildApiSignature(body);

    try {
      const { data } = await axios.post<{ type?: string; message?: string }>(
        `${this.API_BASE_URL}/currencies/${paymentSystemId}/status`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15_000,
          validateStatus: () => true,
        },
      );

      if (data.type !== 'success') {
        this.logger.warn(
          `Freekassa: payment system ${paymentSystemId} status check: ${JSON.stringify(data)}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Freekassa: could not check status for i=${paymentSystemId}: ${err.message}`,
      );
    }
  }

  /** SCI — криптовалюта и прочие методы через pay.fk.money */
  private createPaymentViaSci(
    params: CreateFreekassaPaymentParams,
  ): { id: string; url: string } {
    const m = process.env.FREEKASSA_MERCHANT_ID?.trim();
    const secret1 = process.env.FREEKASSA_SECRET1?.trim();
    if (!m || !secret1) {
      throw new Error(
        'Freekassa SCI: FREEKASSA_MERCHANT_ID and FREEKASSA_SECRET1 are required',
      );
    }

    const amount = Number(params.amountRub);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid Freekassa amount: ${params.amountRub}`);
    }

    const orderId = params.orderId?.trim();
    if (!orderId) {
      throw new Error('Freekassa: orderId is required');
    }

    const currency = 'RUB';
    const amountStr = this.formatAmountForSign(amount);
    const s = this.buildFormSignature({
      merchantId: m,
      amountStr,
      secret1,
      currency,
      orderId,
    });

    const qs = new URLSearchParams({
      m,
      oa: amountStr,
      o: orderId,
      s,
      currency,
      lang: 'ru',
      pay: 'PAY',
    });

    const iRaw = params.suggestedMethodId;
    if (typeof iRaw === 'number' && Number.isFinite(iRaw) && iRaw > 0) {
      qs.set('i', String(Math.floor(iRaw)));
    }

    const url = `${this.SCI_PAY_URL}?${qs.toString()}`;
    this.logger.debug(`Freekassa SCI payment URL for order ${orderId}`);

    return { id: orderId, url };
  }
}
