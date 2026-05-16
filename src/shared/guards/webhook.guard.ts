import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';

interface WebhookRequest extends Request {
  webhookVerified?: boolean;
  webhookProvider?: string;
  rawBody?: Buffer;
}

@Injectable()
export class WebhookGuard implements CanActivate {
  private readonly logger = new Logger(WebhookGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebhookRequest>();
    const path = request.path;

    try {
      if (path.includes('/freekassa/')) {
        await this.verifyFreekassaWebhook(request);
      } else if (path.includes('/heleket/')) {
        await this.verifyHeleketWebhook(request);
      } else {
        this.logger.warn(`Unknown webhook path: ${path}`);
        return false;
      }

      return true;
    } catch {
      throw new UnauthorizedException('Webhook verification failed');
    }
  }

  private async verifyFreekassaWebhook(request: WebhookRequest): Promise<void> {
    const body = request.body;

    if (!body || typeof body !== 'object') {
      this.logger.error('Freekassa webhook: empty or invalid body');
      throw new UnauthorizedException('Invalid request body');
    }

    const merchantId = String(body.MERCHANT_ID ?? '').trim();
    const amountRaw = body.AMOUNT;
    const amount =
      amountRaw !== undefined && amountRaw !== null
        ? String(amountRaw).trim().replace(',', '.')
        : '';
    const orderId = String(body.MERCHANT_ORDER_ID ?? '').trim();
    const sign = String(body.SIGN ?? '').trim();

    if (!merchantId || !amount || !orderId || !sign) {
      this.logger.error('Freekassa webhook: missing required fields');
      throw new UnauthorizedException('Missing required fields');
    }

    const expectedMerchantId = process.env.FREEKASSA_MERCHANT_ID || '';
    if (expectedMerchantId && merchantId !== expectedMerchantId) {
      throw new UnauthorizedException('Invalid merchant ID');
    }

    const secret2 = process.env.FREEKASSA_SECRET2 || '';
    if (!secret2) {
      this.logger.error('FREEKASSA_SECRET2 is not configured');
      throw new UnauthorizedException('Invalid configuration');
    }

    const raw = `${merchantId}:${amount}:${secret2}:${orderId}`;
    const expectedSign = crypto
      .createHash('md5')
      .update(raw)
      .digest('hex');

    if (expectedSign.toLowerCase() !== sign.toLowerCase()) {
      this.logger.error(
        `Freekassa webhook: signature mismatch for order ${orderId} (check FREEKASSA_SECRET2)`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    request.webhookVerified = true;
    request.webhookProvider = 'freekassa';
  }

  private async verifyHeleketWebhook(request: WebhookRequest): Promise<void> {
    const body = request.body;

    if (!body || typeof body !== 'object') {
      this.logger.error('Heleket webhook: empty or invalid body');
      throw new UnauthorizedException('Invalid request body');
    }

    const receivedSign = body.sign;

    if (!receivedSign) {
      this.logger.error('Heleket webhook: missing sign in body');
      throw new UnauthorizedException('Missing signature');
    }

    const merchantIdRaw =
      request.headers['merchant'] ||
      request.headers['Merchant'] ||
      request.headers['MERCHANT'] ||
      request.headers['x-merchant-id'];
    const merchantId = Array.isArray(merchantIdRaw)
      ? merchantIdRaw[0]
      : merchantIdRaw;

    const expectedMerchantId = process.env.HELEKET_MERCHANT_ID;

    if (expectedMerchantId && merchantId && merchantId !== expectedMerchantId) {
      throw new UnauthorizedException('Invalid merchant ID');
    }

    const isValidSignature = this.verifyHeleketSignature(body, receivedSign);

    if (!isValidSignature) {
      this.logger.error(
        `Heleket webhook signature mismatch. Received sign: ${receivedSign?.substring(0, 8)}...`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    request.webhookVerified = true;
    request.webhookProvider = 'heleket';
  }

  private verifyHeleketSignature(
    body: Record<string, any>,
    receivedSign: string,
  ): boolean {
    try {
      const apiKey = process.env.HELEKET_API_KEY || '';

      if (!apiKey) {
        this.logger.error('HELEKET_API_KEY is not configured');
        return false;
      }

      const dataWithoutSign = { ...body };
      delete dataWithoutSign.sign;

      const jsonString = JSON.stringify(dataWithoutSign).replace(/\//g, '\\/');

      const base64Data = Buffer.from(jsonString).toString('base64');
      const signData = base64Data + apiKey;
      const expectedSign = crypto
        .createHash('md5')
        .update(signData)
        .digest('hex');

      const isValid = expectedSign.toLowerCase() === receivedSign.toLowerCase();

      if (!isValid) {
        this.logger.debug(
          `Heleket signature debug: ` +
            `expected=${expectedSign.substring(0, 8)}..., ` +
            `received=${receivedSign.substring(0, 8)}..., ` +
            `json_length=${jsonString.length}`,
        );
      }

      return isValid;
    } catch (error: any) {
      this.logger.error(`Error verifying Heleket signature: ${error.message}`);
      return false;
    }
  }
}
