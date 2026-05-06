import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface AurapayCreatePaymentParams {
  order_id: string;
  amount: number;
  service?: 'sbp' | 'card';
  description?: string;
  callback_url?: string;
  success_url?: string;
  fail_url?: string;
}

export interface AurapayCreatePaymentResponse {
  id: string;
  url: string;
}

export interface AurapayWebhookPayload {
  id: string;
  amount: string;
  status: 'PAID' | 'EXPIRED' | 'PENDING';
  comment?: string;
  created_at: string;
  expires_at: string;
  service?: string;
  payer_details?: string;
  payer_ip?: string;
  shop_id: string;
  order_id: string;
  custom_fields?: string | null;
}

@Injectable()
export class AurapayService {
  private readonly logger = new Logger(AurapayService.name);

  private readonly API_URL = 'https://app.aurapay.tech';
  private readonly TIMEOUT = 30_000;
  private readonly API_KEY = (process.env.AURAPAY_API_KEY || '').trim();
  private readonly SHOP_ID = (process.env.AURAPAY_SHOP_ID || '').trim();
  private readonly SECRET_KEY = (process.env.AURAPAY_SECRET_KEY || '').trim();
  private readonly CALLBACK_URL = (
    process.env.AURAPAY_CALLBACK_URL || ''
  ).trim();

  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.API_URL,
      timeout: this.TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-ApiKey': this.API_KEY,
        'X-ShopId': this.SHOP_ID,
      },
    });

    if (this.API_KEY && this.SHOP_ID) {
      const maskedKey =
        this.API_KEY.substring(0, 4) +
        '***' +
        this.API_KEY.substring(this.API_KEY.length - 4);
      this.logger.log(
        `Aurapay configured: shop_id=${this.SHOP_ID}, api_key=${maskedKey}`,
      );
    } else {
      this.logger.warn(
        'Aurapay not configured: missing AURAPAY_API_KEY or AURAPAY_SHOP_ID',
      );
    }
  }

  async createPayment(
    params: AurapayCreatePaymentParams,
  ): Promise<AurapayCreatePaymentResponse> {
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `Invalid Aurapay amount: ${params.amount} (must be a positive number)`,
      );
    }

    if (!this.API_KEY || !this.SHOP_ID) {
      throw new Error(
        'Aurapay provider not configured: missing AURAPAY_API_KEY or AURAPAY_SHOP_ID',
      );
    }

    const body: Record<string, any> = {
      amount: Math.round(amount * 100) / 100,
      order_id: params.order_id,
      comment: params.description || `Order #${params.order_id}`,
      lifetime: 60,
      service: params.service || undefined,
      callback_url: params.callback_url || this.CALLBACK_URL || undefined,
      success_url: params.success_url || undefined,
      fail_url: params.fail_url || undefined,
    };

    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

    try {
      const response = await this.client.post('/invoice/create', body);
      const data = response.data;

      if (!data?.id || !data?.payment_data?.url) {
        this.logger.error(
          `Invalid Aurapay response: missing id or payment_data.url`,
          data,
        );
        throw new Error(
          'Invalid response from Aurapay API: missing invoice id or payment URL',
        );
      }

      this.logger.log(
        `Aurapay invoice created: order_id=${params.order_id}, id=${data.id}, amount=${amount}`,
      );

      return {
        id: data.id,
        url: data.payment_data.url,
      };
    } catch (error: any) {
      if (error.message?.includes('Aurapay')) throw error;

      const status = error.response?.status;
      const responseData = error.response?.data;
      const apiMessage =
        typeof responseData === 'object'
          ? JSON.stringify(responseData)
          : String(responseData ?? '');

      this.logger.error(
        `Failed to create Aurapay payment (HTTP ${status ?? 'network'}): ${apiMessage}`,
        { order_id: params.order_id, amount, responseData },
      );
      throw new Error(
        `Failed to create Aurapay payment (HTTP ${status}): ${apiMessage}`.trim(),
      );
    }
  }

  async getInvoiceStatus(invoiceId: string): Promise<string> {
    try {
      const response = await this.client.post('/invoice/status', {
        id: invoiceId,
      });
      return response.data?.status || 'UNKNOWN';
    } catch (error: any) {
      if (error.response?.status === 404) return 'NOT_FOUND';
      this.logger.warn(
        `Aurapay getInvoiceStatus error for ${invoiceId}: ${error.message}`,
      );
      return 'UNKNOWN';
    }
  }

  async checkPaymentStatus(invoiceId: string): Promise<boolean> {
    const status = await this.getInvoiceStatus(invoiceId);
    return status === 'PAID';
  }

  verifyWebhookSignature(
    payload: AurapayWebhookPayload,
    signature: string,
  ): boolean {
    if (!this.SECRET_KEY) {
      this.logger.warn(
        'Aurapay: AURAPAY_SECRET_KEY not set, skipping signature verification',
      );
      return true;
    }

    try {
      const sortedKeys = Object.keys(payload).sort();
      const concatenated = sortedKeys
        .map((key) => {
          const val = (payload as any)[key];
          return val === null || val === undefined ? '' : String(val);
        })
        .join('');

      const expected = crypto
        .createHmac('sha256', this.SECRET_KEY)
        .update(concatenated)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature),
      );
    } catch (error: any) {
      this.logger.error(
        `Aurapay signature verification error: ${error.message}`,
      );
      return false;
    }
  }
}
