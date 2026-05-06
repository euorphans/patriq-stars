import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

export interface Sbp2CreatePaymentParams {
  order_id: string;
  amount: number;
  user_id: string;
  description?: string;
  success_url?: string;
  failure_url?: string;
}

export interface Sbp2CreatePaymentResponse {
  id: string;
  url: string;
}

@Injectable()
export class Sbp2Service {
  private readonly logger = new Logger(Sbp2Service.name);

  private readonly API_URL = 'https://api.1payment.com/';
  private readonly TIMEOUT = 30000;
  private readonly PARTNER_ID = (process.env.SBP2_PARTNER_ID || '').trim();
  private readonly PROJECT_ID = (process.env.SBP2_PROJECT_ID || '').trim();
  private readonly API_KEY = (process.env.SBP2_API_KEY || '').trim();
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.API_URL,
      timeout: this.TIMEOUT,
    });

    if (this.API_KEY) {
      const masked =
        this.API_KEY.substring(0, 3) +
        '***' +
        this.API_KEY.substring(this.API_KEY.length - 3);
      this.logger.log(
        `1payment config: partner_id=${this.PARTNER_ID}, project_id=${this.PROJECT_ID}, api_key=${masked} (len=${this.API_KEY.length})`,
      );

      const testHash = crypto.createHash('md5').update('test').digest('hex');
      if (testHash !== '098f6bcd4621d373cade4e832627b4f6') {
        this.logger.error('MD5 self-test FAILED!');
      }
    } else {
      this.logger.warn('SBP2_API_KEY is empty!');
    }
  }

  private static readonly ERROR_CODES: Record<number, string> = {
    1: 'General error',
    2: 'Invalid signature',
    3: 'Method unavailable',
    4: 'Partner not found',
    5: 'Project not found',
    6: 'Payment method unavailable for project',
    7: 'Payout method unavailable for project',
    8: 'Invalid user_data parameter',
    9: 'Insufficient balance for payout',
    10: 'Transaction not found',
    11: 'Payment unavailable for this source',
  };

  private generateSign(
    method: string,
    params: Record<string, string | number>,
  ): string {
    const sortedKeys = Object.keys(params).sort();
    const paramsString = sortedKeys
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    const signString = `${method}${paramsString}${this.API_KEY}`;

    this.logger.debug(
      `1payment sign input: "${method}${paramsString}" + API_KEY(${this.API_KEY.length} chars)`,
    );
    this.logger.debug(
      `1payment sign string bytes (hex, no key): ${Buffer.from(method + paramsString).toString('hex')}`,
    );

    const hash = crypto.createHash('md5').update(signString).digest('hex');
    this.logger.debug(`1payment sign result: ${hash}`);

    return hash;
  }

  async createPayment(
    params: Sbp2CreatePaymentParams,
  ): Promise<Sbp2CreatePaymentResponse> {
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(
        `Invalid SBP2 amount: ${params.amount} (must be a positive number)`,
      );
    }

    if (!this.PARTNER_ID || !this.PROJECT_ID || !this.API_KEY) {
      throw new Error(
        'SBP2 provider not configured: missing SBP2_PARTNER_ID, SBP2_PROJECT_ID, or SBP2_API_KEY',
      );
    }

    const roundedAmount = Math.round(amount * 100) / 100;

    const userData = params.order_id;

    const requestParams: Record<string, string | number> = {
      amount: roundedAmount,
      partner_id: this.PARTNER_ID,
      project_id: this.PROJECT_ID,
      shop_url: 'https://t.me/MopsStarsBot',
      user_data: userData,
      user_id: params.user_id,
    };

    const sign = this.generateSign('init_form', requestParams);

    const sortedKeys = Object.keys(requestParams).sort();
    const queryString = sortedKeys
      .map((key) => `${key}=${requestParams[key]}`)
      .join('&');

    const fullUrl = `init_form?${queryString}&sign=${sign}`;

    this.logger.debug(`1payment request URL: ${this.API_URL}${fullUrl}`);

    try {
      const response = await this.client.get(fullUrl);
      const data = response.data;

      if (data?.error_code !== undefined) {
        const errorCode = Number(data.error_code);
        const errorDesc =
          Sbp2Service.ERROR_CODES[errorCode] ||
          `Unknown error code ${errorCode}`;

        this.logger.error(`1payment error_code=${errorCode}: ${errorDesc}`, {
          params: {
            partner_id: this.PARTNER_ID,
            project_id: this.PROJECT_ID,
            amount: roundedAmount,
            user_data: params.order_id,
          },
          sign,
          response: data,
        });

        throw new Error(
          `1payment API error: ${errorDesc} (error_code=${errorCode})`,
        );
      }

      const paymentUrl = data?.url;

      if (!paymentUrl) {
        this.logger.error(`1payment response missing url field`, data);
        throw new Error(
          'Invalid response from 1payment API: missing payment URL',
        );
      }

      this.logger.log(
        `1payment form created: user_data=${params.order_id}, amount=${roundedAmount}, url=${paymentUrl}`,
      );

      return {
        id: params.order_id,
        url: paymentUrl,
      };
    } catch (error: any) {
      if (error.response) {
        const status = error.response?.status;
        const responseData = error.response?.data;
        const apiMessage =
          typeof responseData === 'object'
            ? JSON.stringify(responseData)
            : String(responseData ?? '');
        this.logger.error(`1payment HTTP error (${status}): ${apiMessage}`, {
          requestParams: {
            partner_id: this.PARTNER_ID,
            project_id: this.PROJECT_ID,
            amount: roundedAmount,
            user_data: params.order_id,
          },
          responseData,
        });
        throw new Error(
          `Failed to create SBP2 payment (HTTP ${status}): ${apiMessage}`.trim(),
        );
      }

      if (error.message?.includes('1payment')) {
        throw error;
      }

      this.logger.error(`1payment network error: ${error.message}`);
      throw new Error(`Failed to create SBP2 payment: ${error.message}`);
    }
  }

  async getTransactionStatus(paymentId: string): Promise<string> {
    try {
      const requestParams: Record<string, string | number> = {
        partner_id: this.PARTNER_ID,
        project_id: this.PROJECT_ID,
        user_data: paymentId,
      };

      const sign = this.generateSign('status_payment', requestParams);
      const sortedKeys = Object.keys(requestParams).sort();
      const queryString = sortedKeys
        .map((key) => `${key}=${requestParams[key]}`)
        .join('&');

      const response = await this.client.get(
        `status_payment?${queryString}&sign=${sign}`,
      );
      const data = response.data;

      if (data?.error_code !== undefined && Number(data.error_code) !== 0) {
        return 'UNKNOWN';
      }

      const status = Number(data?.status);
      if (status === 3) return 'SUCCESS';
      if (status === 4) return 'FAILED';
      if (status === 2) return 'PENDING';
      return 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }

  async checkPaymentStatus(paymentId: string): Promise<boolean> {
    if (!this.PARTNER_ID || !this.PROJECT_ID || !this.API_KEY) {
      throw new Error(
        'SBP2 provider not configured: missing SBP2_PARTNER_ID, SBP2_PROJECT_ID, or SBP2_API_KEY',
      );
    }

    const requestParams: Record<string, string | number> = {
      partner_id: this.PARTNER_ID,
      project_id: this.PROJECT_ID,
      user_data: paymentId,
    };

    const sign = this.generateSign('status_payment', requestParams);

    const sortedKeys = Object.keys(requestParams).sort();
    const queryString = sortedKeys
      .map((key) => `${key}=${requestParams[key]}`)
      .join('&');

    const fullUrl = `status_payment?${queryString}&sign=${sign}`;

    this.logger.debug(`1payment status check URL: ${this.API_URL}${fullUrl}`);

    try {
      const response = await this.client.get(fullUrl);
      const data = response.data;

      if (data?.error_code !== undefined) {
        const errorCode = Number(data.error_code);
        if (errorCode === 10) {
          this.logger.debug(
            `1payment status check: payment ${paymentId} not found (error_code=10)`,
          );
          return false;
        }
        const errorDesc =
          Sbp2Service.ERROR_CODES[errorCode] ||
          `Unknown error code ${errorCode}`;
        throw new Error(
          `1payment status check error: ${errorDesc} (error_code=${errorCode})`,
        );
      }

      const status = Number(data?.status);
      this.logger.debug(
        `1payment status check for ${paymentId}: status=${status} (${data?.status_description})`,
      );

      return status === 3;
    } catch (error: any) {
      if (error.response) {
        const httpStatus = error.response?.status;
        const responseData = error.response?.data;
        const errorCode = Number(responseData?.error_code);

        if (errorCode === 10) {
          this.logger.debug(
            `1payment status check: payment ${paymentId} not found`,
          );
          return false;
        }

        const apiMessage =
          typeof responseData === 'object'
            ? JSON.stringify(responseData)
            : String(responseData ?? '');
        this.logger.error(
          `1payment status check HTTP error (${httpStatus}) for ${paymentId}: ${apiMessage}`,
        );
        throw new Error(
          `Failed to check SBP2 payment status (HTTP ${httpStatus}): ${apiMessage}`.trim(),
        );
      }

      if (error.message?.includes('1payment')) {
        throw error;
      }

      this.logger.error(
        `1payment status check network error for ${paymentId}: ${error.message}`,
      );
      throw new Error(`Failed to check SBP2 payment status: ${error.message}`);
    }
  }

  verifyWebhookSignature(
    payload: Record<string, any>,
    _signature: string,
  ): boolean {
    if (payload.project_id && String(payload.project_id) !== this.PROJECT_ID) {
      this.logger.warn(
        `1payment webhook project_id mismatch: expected ${this.PROJECT_ID}, got ${payload.project_id}`,
      );
      return false;
    }

    return true;
  }
}
