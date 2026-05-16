import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';

export interface CreateFreekassaPaymentParams {
  /** MERCHANT_ORDER_ID / paymentId (у нас — order_number). */
  orderId: string;
  amountRub: number;
  /**
   * ID способа оплаты (§8 / API `i`): СБП 4.2 = 44, USDT TRC20 = 15.
   * СБП создаётся через API → paymentt.kassa.ai; крипто — SCI pay.fk.money.
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
 * - СБП (i=44): API https://api.fk.life/v1/orders/create → paymentt.kassa.ai
 * - Крипто и др.: SCI GET https://pay.fk.money/
 * Webhook: md5(MERCHANT_ID:AMOUNT:secret2:MERCHANT_ORDER_ID)
 * @see https://docs.freekassa.ru/
 */
@Injectable()
export class FreekassaService {
  private readonly logger = new Logger(FreekassaService.name);
  private readonly SCI_PAY_URL = 'https://pay.fk.money/';
  private readonly API_BASE_URL = 'https://api.fk.life/v1';

  private static readonly SBP_METHOD_ID = () =>
    parseInt(process.env.FREEKASSA_SBP_CUR_ID || '44', 10);

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

  private resolvePayerIp(): string {
    const fromEnv = process.env.FREEKASSA_API_PAYER_IP?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    return '127.0.0.1';
  }

  private isSbpMethod(methodId?: number): boolean {
    const sbpId = FreekassaService.SBP_METHOD_ID();
    return (
      typeof methodId === 'number' &&
      Number.isFinite(methodId) &&
      methodId === sbpId
    );
  }

  async createPayment(
    params: CreateFreekassaPaymentParams,
  ): Promise<{ id: string; url: string }> {
    if (this.isSbpMethod(params.suggestedMethodId)) {
      return this.createPaymentViaApi(params);
    }
    return this.createPaymentViaSci(params);
  }

  /** API v1 — СБП 4.2, страница оплаты paymentt.kassa.ai */
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

    const apiAmount = Number.isInteger(amount) ? amount : Number(amount.toFixed(2));

    const body: Record<string, string | number> = {
      shopId,
      nonce: Date.now(),
      paymentId: orderId,
      i: paymentSystemId,
      email,
      ip: this.resolvePayerIp(),
      amount: apiAmount,
      currency: 'RUB',
    };
    body.signature = this.buildApiSignature(body);

    this.logger.log(
      `Freekassa API create order ${orderId}, i=${paymentSystemId}, amount=${apiAmount}`,
    );

    try {
      const { data } = await axios.post<FkApiCreateOrderResponse>(
        `${this.API_BASE_URL}/orders/create`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30_000,
        },
      );

      if (data.type === 'error') {
        const errMsg = data.error || data.message || 'Unknown API error';
        throw new Error(`Freekassa API error: ${errMsg}`);
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
      const detail =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message;
      this.logger.error(`Freekassa API create failed: ${detail}`);
      throw error;
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
