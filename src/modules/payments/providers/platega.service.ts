import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

export interface CreatePaymentParams {
  order_id: string;
  amount: number;
  user_id: string;
  stars_count?: number;
  description?: string;
  return_url?: string;
  payment_method?: number;
}

interface TransactionStatus {
  status: string;
}

interface TransactionPhoneResponse {
  contactPhoneNumber: string;
}

/**
 * Интеграция Platega. Статусы транзакции (документация): PENDING, CONFIRMED, EXPIRED, CANCELED, FAILED.
 * В ответах API также встречаются CANCELLED и пост-оплатные CHARGEBACK / CHARGEBACKED.
 */
@Injectable()
export class PlategaService {
  private readonly logger = new Logger(PlategaService.name);
  private readonly API_URL = 'https://app.platega.io/';
  private readonly TIMEOUT = 15_000;
  private readonly ALLOW_PAYMENT_METHODS = [2, 10, 11, 12, 13];
  private readonly CURRENCY = 'RUB';
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.API_URL,
      timeout: this.TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-MerchantId': process.env.PLATEGA_MERCHANT_ID || '',
        'X-Secret': process.env.PLATEGA_SECRET || '',
      },
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
    });
  }

  async createPayment(
    params: CreatePaymentParams,
  ): Promise<{ id: string; url: string }> {
    const paymentMethodNum = params.payment_method || 2;

    if (!this.ALLOW_PAYMENT_METHODS.includes(paymentMethodNum)) {
      throw new Error(`Unsupported payment method: ${paymentMethodNum}`);
    }

    const returnUrl =
      params.return_url?.trim() || process.env.BOT_URL?.trim() || '';
    if (!returnUrl) {
      this.logger.warn(
        'Platega: BOT_URL and return_url are empty; payment return links may be invalid',
      );
    }

    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `Invalid Platega amount: ${params.amount} (must be a positive number)`,
      );
    }

    const rawUserId = params.user_id?.trim();
    if (!rawUserId) {
      throw new Error('Platega metadata.userId is required');
    }
    const metadataUserId = rawUserId.startsWith('tg_')
      ? rawUserId
      : `tg_${rawUserId}`;

    const paymentData = {
      paymentMethod: paymentMethodNum,
      paymentDetails: {
        amount,
        currency: this.CURRENCY,
      },
      description: params.description || `Payment #${params.order_id}`,
      return: returnUrl,
      failedUrl: returnUrl,
      payload: params.order_id,
      metadata: {
        userId: metadataUserId,
        ...(Number.isFinite(params.stars_count)
          ? { starsCount: Number(params.stars_count) }
          : {}),
      },
    };

    try {
      const response = await this.client.post(
        'transaction/process',
        paymentData,
      );

      const transactionId = response.data?.transactionId;
      const redirectUrl = response.data?.redirect;

      if (!transactionId || !redirectUrl) {
        this.logger.error(
          `Invalid Platega response: missing transactionId or redirect`,
          response.data,
        );
        throw new Error(
          'Invalid response from Platega API: missing transaction ID or redirect URL',
        );
      }

      return {
        id: transactionId,
        url: redirectUrl,
      };
    } catch (error: any) {
      const status = error.response?.status;
      const responseData = error.response?.data;
      const apiMessage =
        typeof responseData === 'object'
          ? JSON.stringify(responseData)
          : String(responseData ?? '');
      const detail =
        status === 400 && apiMessage
          ? ` Platega API: ${apiMessage}`
          : ` ${error.message}`;
      this.logger.error(
        `Failed to create Platega payment (${status ?? 'network'}): ${detail}`,
        { requestPayload: paymentData, responseData },
      );
      throw new Error(`Failed to create payment:${detail}`.trim());
    }
  }

  async checkPaymentStatus(transactionId: string): Promise<boolean> {
    const status = await this.getTransactionStatus(transactionId);
    return status.status === 'CONFIRMED';
  }

  async getTransactionStatus(
    transactionId: string,
  ): Promise<TransactionStatus> {
    try {
      const response = await this.client.get(`transaction/${transactionId}`);

      const status = response.data?.status || '';
      this.logger.debug(
        `Platega transaction ${transactionId} status: ${status}`,
      );
      return { status };
    } catch (error: any) {
      const httpStatus = error.response?.status;
      const responseData = error.response?.data;

      this.logger.warn(
        `Platega getTransactionStatus ${transactionId} error (HTTP ${httpStatus}): ${JSON.stringify(responseData)}`,
      );

      const errorData = responseData?.data;
      if (Array.isArray(errorData)) {
        const ipError = errorData.find(
          (e: any) => e.key === 'payerIp' || e.message?.includes('IP'),
        );
        if (ipError) {
          return { status: 'IP_DENIED' };
        }
      }

      if (httpStatus === 400 || httpStatus === 404) {
        return { status: 'NOT_FOUND' };
      }

      throw new Error(`Failed to get transaction: ${error.message}`);
    }
  }

  async isPaymentCompleted(transactionId: string): Promise<boolean> {
    const status = await this.getTransactionStatus(transactionId);
    return status.status === 'CONFIRMED';
  }

  async getTransactionPhone(transactionId: string): Promise<string | null> {
    try {
      const response = await this.client.get<TransactionPhoneResponse>(
        `transaction/${transactionId}/phone`,
      );

      const phone = response.data?.contactPhoneNumber;
      if (!phone || phone.trim() === '') {
        return null;
      }

      return phone.trim();
    } catch (error: any) {
      this.logger.warn(
        `Failed to get phone for transaction ${transactionId}: ${error.message}`,
      );
      return null;
    }
  }
}
