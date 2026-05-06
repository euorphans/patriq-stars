import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface FragmentAccountCredentials {
  id: string;
  name: string;
  stel_ssid: string;
  stel_token: string;
  stel_ton_token: string;
  stel_hash?: string | null;
}

interface RecipientInfo {
  recipient: string;
  name?: string;
  photo?: string;
  isPremium?: boolean;
}

interface InitBuyResponse {
  req_id?: string;
  error?: string;
  [key: string]: any;
}

interface GetBuyLinkResponse {
  link?: string;
  [key: string]: any;
}

export class FragmentApiError extends Error {
  constructor(
    message: string,
    public readonly errorType:
      | 'ALREADY_PREMIUM'
      | 'USER_NOT_FOUND'
      | 'GIFTS_CLOSED'
      | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'FragmentApiError';
  }
}

@Injectable()
export class FragmentService {
  private readonly logger = new Logger(FragmentService.name);
  private readonly FRAGMENT_API_URL: string;
  private readonly client: AxiosInstance;

  constructor() {
    this.FRAGMENT_API_URL = process.env.FRAGMENT_API_URL || '';

    this.client = axios.create({
      timeout: 10000,
    });
  }

  private buildCookies(
    account: FragmentAccountCredentials,
  ): Record<string, string> {
    return {
      stel_ssid: account.stel_ssid,
      stel_token: account.stel_token,
      stel_ton_token: account.stel_ton_token,
    };
  }

  private getRequestUrl(account: FragmentAccountCredentials): string {
    const base = this.FRAGMENT_API_URL || '';
    const hash = account.stel_hash?.trim();
    if (!hash) return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}hash=${encodeURIComponent(hash)}`;
  }

  private readonly MAX_API_RETRIES = 2;
  private readonly API_RETRY_DELAY_MS = 2000;

  private static isInvalidRecipientFragmentMessage(msg: string): boolean {
    return /username assigned to a user/i.test(msg);
  }

  private static normalizeFragmentErrorMessage(raw: unknown): string {
    if (raw == null) return '';
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('{')) {
        try {
          const o = JSON.parse(s) as { error?: unknown };
          if (o && typeof o === 'object' && 'error' in o) {
            return FragmentService.normalizeFragmentErrorMessage(o.error);
          }
        } catch {
          /* use full string below */
        }
      }
      return raw;
    }
    if (typeof raw === 'object') {
      const o = raw as { error?: unknown };
      if ('error' in o && o.error !== undefined) {
        return FragmentService.normalizeFragmentErrorMessage(o.error);
      }
    }
    return String(raw);
  }

  private static coerceParsedJsonBody(data: unknown): unknown {
    if (typeof data !== 'string') return data;
    const t = data.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return data;
    try {
      return JSON.parse(t);
    } catch {
      return data;
    }
  }

  private isNetworkError(error: any): boolean {
    if (!error.response) return true;
    const status = error.response?.status;
    return status !== undefined && status >= 500;
  }

  private async makeApiRequest(
    account: FragmentAccountCredentials,
    data: Record<string, any>,
    options?: { fullResponse?: boolean },
  ): Promise<any> {
    const cookies = this.buildCookies(account);
    const cookieString = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    const url = this.getRequestUrl(account);

    for (let attempt = 1; attempt <= this.MAX_API_RETRIES; attempt++) {
      try {
        const response = await this.client.post(url, data, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieString,
          },
          transformRequest: [
            (data) => {
              return Object.entries(data)
                .map(
                  ([key, value]) =>
                    `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
                )
                .join('&');
            },
          ],
        });

        const parsedData = FragmentService.coerceParsedJsonBody(response.data);
        if (options?.fullResponse) {
          return {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers as Record<string, string>,
            data: parsedData,
          };
        }
        return parsedData;
      } catch (error: any) {
        const isRetryable = this.isNetworkError(error);

        if (isRetryable && attempt < this.MAX_API_RETRIES) {
          this.logger.warn(
            `Fragment API request failed [account: ${account.name}], retry ${attempt}/${this.MAX_API_RETRIES}: ${error.message || '(empty)'}, status: ${error.response?.status}`,
          );
          await new Promise((r) => setTimeout(r, this.API_RETRY_DELAY_MS));
          continue;
        }

        this.logger.error(
          `Fragment API request failed [account: ${account.name}]: ${error.message || '(empty)'}, status: ${error.response?.status}`,
        );
        if (error.response?.data) {
          this.logger.error(
            `Response data: ${JSON.stringify(error.response.data)}`,
          );
        }
        return null;
      }
    }

    return null;
  }

  async getUser(
    account: FragmentAccountCredentials,
    username: string,
    type: 'stars' | 'premium' | 'ton' = 'stars',
  ): Promise<{ recipient: RecipientInfo | null; info: any }> {
    try {
      let method: string;
      const requestData: Record<string, any> = {
        query: username,
      };

      switch (type) {
        case 'stars':
          method = 'searchStarsRecipient';
          requestData.quantity = '';
          break;
        case 'premium':
          method = 'searchPremiumGiftRecipient';
          requestData.quantity = 3;
          requestData.months = 3;
          break;
        case 'ton':
          method = 'searchAdsTopupRecipient';
          break;
        default:
          throw new Error(`Invalid type: ${type}`);
      }

      requestData.method = method;

      const response = await this.makeApiRequest(account, requestData);

      if (!response) {
        throw new Error('Fragment API unavailable');
      }

      if (!response.found) {
        if (response.error) {
          const errorMsg = FragmentService.normalizeFragmentErrorMessage(
            response.error,
          );

          if (errorMsg.includes('already subscribed to Telegram Premium')) {
            throw new FragmentApiError(errorMsg, 'ALREADY_PREMIUM');
          } else if (
            errorMsg.includes('gifts') ||
            errorMsg.includes('closed')
          ) {
            throw new FragmentApiError(errorMsg, 'GIFTS_CLOSED');
          } else if (
            errorMsg.includes('No Telegram users found') ||
            errorMsg.includes('user not found') ||
            errorMsg.includes('not found') ||
            FragmentService.isInvalidRecipientFragmentMessage(errorMsg)
          ) {
            throw new FragmentApiError(errorMsg, 'USER_NOT_FOUND');
          } else {
            throw new FragmentApiError(errorMsg, 'UNKNOWN');
          }
        }

        return { recipient: null, info: null };
      }

      const recipient = {
        recipient: response.found.recipient || '',
        name: response.found.name,
        photo: response.found.photo,
        isPremium: response.found.is_premium || false,
      };

      return {
        recipient,
        info: {
          name: response.found.name,
          photo: response.found.photo,
          isPremium: response.found.is_premium || false,
        },
      };
    } catch (error: any) {
      if (error instanceof FragmentApiError) {
        throw error;
      }

      if (error.message === 'Fragment API unavailable') {
        throw error;
      }

      this.logger.error(
        `Failed to get user from Fragment [account: ${account.name}]: ${error.message}`,
      );
      return { recipient: null, info: null };
    }
  }

  async initBuy(
    account: FragmentAccountCredentials,
    recipient: string,
    quantity: number,
    type: 'stars' | 'premium' | 'ton' = 'stars',
  ): Promise<InitBuyResponse | null> {
    try {
      let method: string;
      const requestData: Record<string, any> = {
        recipient,
      };

      switch (type) {
        case 'stars':
          method = 'initBuyStarsRequest';
          requestData.quantity = quantity;
          break;
        case 'premium':
          method = 'initGiftPremiumRequest';
          requestData.months = quantity;
          break;
        case 'ton':
          method = 'initAdsTopupRequest';
          requestData.amount = quantity;
          break;
        default:
          throw new Error(`Invalid type: ${type}`);
      }

      requestData.method = method;

      const result = await this.makeApiRequest(account, requestData);

      if (!result) {
        this.logger.error(
          `Fragment API returned null response [account: ${account.name}]`,
        );
        return null;
      }

      if (result.error) {
        const errText = FragmentService.normalizeFragmentErrorMessage(
          result.error,
        );
        this.logger.warn(
          `Fragment API returned error for ${type} [account: ${account.name}]: ${errText}`,
        );
        return { error: errText };
      }

      if (!result.req_id) {
        this.logger.error(
          `Fragment API response missing req_id [account: ${account.name}]: ${JSON.stringify(result)}`,
        );
        return null;
      }

      return result;
    } catch (error: any) {
      this.logger.error(
        `Failed to init buy [account: ${account.name}]: ${error.message}`,
      );
      return null;
    }
  }

  async getBuyLink(
    account: FragmentAccountCredentials,
    reqId: string,
    _showSender: number = 0,
    type: 'stars' | 'premium' | 'ton' = 'stars',
  ): Promise<
    | { success: true; data: GetBuyLinkResponse }
    | { success: false; error: string }
  > {
    try {
      let method: string;

      switch (type) {
        case 'stars':
          method = 'getBuyStarsLink';
          break;
        case 'premium':
          method = 'getGiftPremiumLink';
          break;
        case 'ton':
          method = 'getAdsTopupLink';
          break;
        default:
          throw new Error(`Invalid type: ${type}`);
      }

      const requestData = {
        account: ' ',
        device:
          '{"platform":"mac","appName":"Tonkeeper","appVersion":"3.26.1","maxProtocolVersion":2,"features":["SendTransaction",{"name":"SendTransaction","maxMessages":4}]}',
        transaction: 1,
        id: reqId,
        show_sender: 0,
        method,
      };

      const fullResponse = await this.makeApiRequest(account, requestData, {
        fullResponse: true,
      });

      if (!fullResponse) {
        this.logger.error(
          `Failed to get buy link from Fragment API (no response) [account: ${account.name}] | type: ${type}, reqId: ${reqId}`,
        );
        return { success: false, error: 'No response from Fragment API' };
      }

      this.logger.log(
        `Fragment getBuyLink full response [account: ${account.name}] | type: ${type}, reqId: ${reqId} | ` +
          `status: ${fullResponse.status} ${fullResponse.statusText}, ` +
          `headers: ${JSON.stringify(fullResponse.headers)}, ` +
          `body: ${JSON.stringify(fullResponse.data)}`,
      );

      const response = fullResponse.data;

      if (!response) {
        this.logger.error(
          `Failed to get buy link from Fragment API (no response body) [account: ${account.name}] | type: ${type}, reqId: ${reqId}`,
        );
        return { success: false, error: 'No response from Fragment API' };
      }

      if (response.error) {
        const fragmentError = FragmentService.normalizeFragmentErrorMessage(
          response.error,
        );
        this.logger.error(
          `Fragment API returned error [account: ${account.name}] | type: ${type}, reqId: ${reqId}, ` +
            `fragmentError: "${fragmentError}", fullResponse: ${JSON.stringify(response)}`,
        );
        return { success: false, error: `Fragment: ${fragmentError}` };
      }

      if (!response.ok) {
        this.logger.error(
          `Failed to get buy link from Fragment API (response.ok is falsy) [account: ${account.name}] | type: ${type}, reqId: ${reqId}, ` +
            `response: ${JSON.stringify(response)}`,
        );
        return {
          success: false,
          error: 'Fragment response missing ok',
        };
      }

      return { success: true, data: response };
    } catch (error: any) {
      this.logger.error(
        `Failed to get buy link [account: ${account.name}]: ${error.message} | type: ${type}, reqId: ${reqId}`,
      );
      return {
        success: false,
        error: error.message || 'Request failed',
      };
    }
  }

  static isAccountSpecificError(error: string | undefined): boolean {
    if (!error) return false;
    const lower = error.toLowerCase();
    return (
      lower.includes('unknown error') ||
      lower.includes('need_verify') ||
      lower.includes('wallet verification') ||
      lower.includes('no response from fragment') ||
      lower.includes('failed to initialize purchase') ||
      lower.includes('response missing ok') ||
      lower.includes('request failed')
    );
  }

  async completePurchaseFlow(
    account: FragmentAccountCredentials,
    username: string,
    quantity: number,
    type: 'stars' | 'premium' | 'ton' = 'stars',
  ): Promise<{
    success: boolean;
    recipient?: string;
    userInfo?: any;
    transactionData?: any;
    error?: string;
    accountId?: string;
    latencyMs?: number;

    isAccountError?: boolean;
  }> {
    const flowStart = Date.now();
    let recipient: RecipientInfo | null = null;
    let info: any = null;

    const t0 = Date.now();
    try {
      const result = await this.getUser(account, username, type);
      recipient = result.recipient;
      info = result.info;
    } catch (error: any) {
      const elapsed = Date.now() - flowStart;
      this.logger.warn(
        `[PERF] completePurchaseFlow FAILED at getUser after ${elapsed}ms | account=${account.name} user=${username} type=${type}`,
      );
      if (error instanceof FragmentApiError) {
        if (error.errorType === 'ALREADY_PREMIUM') {
          return {
            success: false,
            error: 'ALREADY_SUBSCRIBED',
            latencyMs: elapsed,
          };
        }
        if (error.errorType === 'GIFTS_CLOSED') {
          return {
            success: false,
            error: 'GIFTS_CLOSED',
            latencyMs: elapsed,
          };
        }
        if (error.errorType === 'USER_NOT_FOUND') {
          return {
            success: false,
            error: 'User not found in Fragment',
            latencyMs: elapsed,
          };
        }
        return {
          success: false,
          error: error.message,
          latencyMs: elapsed,
        };
      }
      return {
        success: false,
        error: error.message || 'Fragment API unavailable',
        latencyMs: elapsed,
      };
    }
    const getUserMs = Date.now() - t0;

    if (!recipient || !recipient.recipient) {
      const elapsed = Date.now() - flowStart;
      return {
        success: false,
        error: 'User not found in Fragment',
        latencyMs: elapsed,
      };
    }

    const t1 = Date.now();
    const initResult = await this.initBuy(
      account,
      recipient.recipient,
      quantity,
      type,
    );
    const initBuyMs = Date.now() - t1;

    if (!initResult) {
      const elapsed = Date.now() - flowStart;
      this.logger.warn(
        `[PERF] completePurchaseFlow FAILED at initBuy after ${elapsed}ms (getUser=${getUserMs}ms, initBuy=${initBuyMs}ms) | account=${account.name} user=${username}`,
      );
      return {
        success: false,
        error: 'Failed to initialize purchase',
        latencyMs: elapsed,
      };
    }

    if (initResult.error) {
      const elapsed = Date.now() - flowStart;
      if (initResult.error.includes('already subscribed')) {
        return {
          success: false,
          error: 'ALREADY_SUBSCRIBED',
          latencyMs: elapsed,
        };
      }
      if (FragmentService.isInvalidRecipientFragmentMessage(initResult.error)) {
        return {
          success: false,
          error: 'User not found in Fragment',
          latencyMs: elapsed,
        };
      }
      return {
        success: false,
        error: initResult.error,
        latencyMs: elapsed,
      };
    }

    if (!initResult.req_id) {
      const elapsed = Date.now() - flowStart;
      return {
        success: false,
        error: 'Failed to initialize purchase',
        latencyMs: elapsed,
      };
    }

    const t2 = Date.now();
    const linkResult = await this.getBuyLink(
      account,
      initResult.req_id,
      0,
      type,
    );
    const getBuyLinkMs = Date.now() - t2;

    const totalMs = Date.now() - flowStart;

    if (linkResult.success === false) {
      const linkErr = linkResult.error || '';
      this.logger.warn(
        `[PERF] completePurchaseFlow FAILED at getBuyLink after ${totalMs}ms (getUser=${getUserMs}ms, initBuy=${initBuyMs}ms, getBuyLink=${getBuyLinkMs}ms) | account=${account.name} user=${username}`,
      );
      if (FragmentService.isInvalidRecipientFragmentMessage(linkErr)) {
        return {
          success: false,
          error: 'User not found in Fragment',
          latencyMs: totalMs,
        };
      }
      return {
        success: false,
        error: linkResult.error,
        latencyMs: totalMs,
      };
    }

    this.logger.log(
      `[PERF] completePurchaseFlow OK ${totalMs}ms (getUser=${getUserMs}ms, initBuy=${initBuyMs}ms, getBuyLink=${getBuyLinkMs}ms) | account=${account.name} user=${username} type=${type} qty=${quantity}`,
    );

    return {
      success: true,
      recipient: recipient.recipient,
      userInfo: info,
      transactionData: linkResult.data,
      accountId: account.id,
      latencyMs: totalMs,
    };
  }

  async checkAccountHealth(
    account: FragmentAccountCredentials,
  ): Promise<{ alive: boolean; error?: string }> {
    try {
      const response = await this.makeApiRequest(account, {
        method: 'searchStarsRecipient',
        query: 'telegram',
        quantity: '',
      });

      if (response === null) {
        return { alive: false, error: 'Нет ответа от Fragment API' };
      }

      if (response.error) {
        const msg = FragmentService.normalizeFragmentErrorMessage(
          response.error,
        );
        if (
          msg.toLowerCase().includes('unauthorized') ||
          msg.toLowerCase().includes('not authorized') ||
          msg.toLowerCase().includes('auth') ||
          msg.toLowerCase().includes('session') ||
          msg.toLowerCase().includes('login')
        ) {
          return { alive: false, error: msg };
        }
      }

      return { alive: true };
    } catch (err: any) {
      return { alive: false, error: err.message || 'Неизвестная ошибка' };
    }
  }
}
