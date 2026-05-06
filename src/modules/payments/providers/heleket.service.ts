import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

@Injectable()
export class HeleketService {
  private readonly logger = new Logger(HeleketService.name);
  private readonly API_URL = 'https://api.heleket.com/v1/';
  private readonly MERCHANT_ID: string;
  private readonly API_KEY: string;
  private readonly client: AxiosInstance;

  constructor() {
    this.MERCHANT_ID = process.env.HELEKET_MERCHANT_ID || '';
    this.API_KEY = process.env.HELEKET_API_KEY || '';

    this.client = axios.create({
      baseURL: this.API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        merchant: this.MERCHANT_ID,
      },
    });
  }

  private createSignature(data: any): string {
    const jsonString = JSON.stringify(data);
    const base64Data = Buffer.from(jsonString).toString('base64');
    const signData = base64Data + this.API_KEY;
    return crypto.createHash('md5').update(signData).digest('hex');
  }

  async createPayment(params: {
    order_id: string;
    amount: number;
    currency: string;
    url_callback?: string;
  }): Promise<{ id: string; url: string }> {
    const { order_id, amount, currency, url_callback } = params;
    const lifetime = 1800;

    const callbackUrl = url_callback || process.env.HELEKET_CALLBACK_URL;

    try {
      const paymentData: any = {
        amount: amount.toFixed(2).replace(',', '.'),
        currency: currency,
        order_id: order_id,
        lifetime,
        from_referral_code: 'n5pMbP',
      };

      if (callbackUrl) {
        paymentData.url_callback = callbackUrl;
      }

      const signature = this.createSignature(paymentData);

      const response = await this.client.post('payment', paymentData, {
        headers: {
          sign: signature,
        },
      });

      if (!response.data.result) {
        throw new Error('Invalid response from Heleket API');
      }

      return {
        id: response.data.result.uuid || '',
        url: response.data.result.url || '',
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to create Heleket payment: ${error.message}`,
        error.response?.data,
      );
      throw new Error(`Failed to create payment: ${error.message}`);
    }
  }

  async checkPaymentStatus(uuid: string): Promise<boolean> {
    const status = await this.getPaymentInfo(uuid);
    return status === 'paid' || status === 'paid_over';
  }

  async getPaymentInfo(uuid: string): Promise<string> {
    try {
      const paymentData = { uuid };
      const signature = this.createSignature(paymentData);

      const response = await this.client.post('payment/info', paymentData, {
        headers: {
          sign: signature,
        },
      });

      return response.data.result?.payment_status || '';
    } catch (error: any) {
      this.logger.error(`Failed to get Heleket payment info: ${error.message}`);
      throw new Error(`Failed to get payment info: ${error.message}`);
    }
  }

  async isPaymentCompleted(uuid: string): Promise<boolean> {
    const status = await this.getPaymentInfo(uuid);
    return status === 'paid' || status === 'paid_over';
  }

  verifySignature(payload: any, receivedSign: string): boolean {
    try {
      const expectedSign = this.createSignature(payload);
      return expectedSign.toLowerCase() === receivedSign.toLowerCase();
    } catch (error: any) {
      this.logger.error(`Error verifying signature: ${error.message}`);
      return false;
    }
  }
}
