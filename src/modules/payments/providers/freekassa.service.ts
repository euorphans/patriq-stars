import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface CreateFreekassaPaymentParams {
  /** MERCHANT_ORDER_ID в форме Freekassa (у нас — order_number). */
  orderId: string;
  amountRub: number;
  /**
   * Параметр `i` — ID способа оплаты в ЛК Freekassa (§8).
   * СБП: 44 (СБП 4.2, paymentt.kassa.ai). Крипто: см. FREEKASSA_CRYPTO_CUR_ID (15 = USDT TRC20).
   */
  suggestedMethodId?: number;
}

/**
 * SCI Freekassa: форма GET https://pay.fk.money/, оповещение form-data.
 * Подпись формы: md5(m:oa:secret1:currency:o).
 * Подпись оповещения: md5(MERCHANT_ID:AMOUNT:secret2:MERCHANT_ORDER_ID).
 * @see https://docs.freekassa.net/
 */
@Injectable()
export class FreekassaService {
  private readonly logger = new Logger(FreekassaService.name);
  private readonly PAY_URL = 'https://pay.fk.money/';

  /** Сумма в строке для подписи и параметра oa (как в документации, 2 знака). */
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

  async createPayment(
    params: CreateFreekassaPaymentParams,
  ): Promise<{ id: string; url: string }> {
    const m = process.env.FREEKASSA_MERCHANT_ID?.trim();
    const secret1 = process.env.FREEKASSA_SECRET1?.trim();
    if (!m || !secret1) {
      throw new Error(
        'Freekassa: FREEKASSA_MERCHANT_ID and FREEKASSA_SECRET1 are required',
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

    const url = `${this.PAY_URL}?${qs.toString()}`;
    this.logger.debug(`Freekassa payment URL created for order ${orderId}`);

    return { id: orderId, url };
  }
}
