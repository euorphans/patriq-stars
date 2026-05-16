import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;

    const whitelist = this.getWhitelist(path);

    if (whitelist.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          `SECURITY: IP whitelist not configured for ${path}. ` +
            `Blocking all requests. Set HELEKET_IP_WHITELIST (Freekassa uses built-in FK IPs if FREEKASSA_IP_WHITELIST is empty).`,
        );
        throw new ServiceUnavailableException(
          'Payment webhook not configured properly',
        );
      }

      this.logger.warn(
        `IP whitelist not configured for ${path}. Allowing in development mode.`,
      );
      return true;
    }

    const clientIp = this.getClientIp(request);

    const isAllowed = this.isIpAllowed(clientIp, whitelist);

    if (!isAllowed) {
      this.logger.error(
        `Payment webhook blocked: IP ${clientIp} not in whitelist for ${path}`,
      );
      throw new ForbiddenException('Access denied: IP not whitelisted');
    }

    return true;
  }

  private getClientIp(request: Request): string {
    const cfIp = request.headers['cf-connecting-ip'] as string;
    if (cfIp) {
      return cfIp;
    }

    const xForwardedFor = request.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const ips = Array.isArray(xForwardedFor)
        ? xForwardedFor[0]
        : xForwardedFor;
      return ips.split(',')[0].trim();
    }

    const xRealIp = request.headers['x-real-ip'] as string;
    if (xRealIp) {
      return xRealIp;
    }

    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private getWhitelist(path: string): string[] {
    if (path.includes('/freekassa/')) {
      const env = process.env.FREEKASSA_IP_WHITELIST || '';
      if (env) {
        return env.split(',').map((ip) => ip.trim()).filter(Boolean);
      }
      // Официальные IP оповещений Freekassa (docs.freekassa.ru §1.4)
      return [
        '168.119.157.136',
        '168.119.60.227',
        '178.154.197.79',
        '51.250.54.238',
      ];
    }

    if (path.includes('/heleket/')) {
      const env = process.env.HELEKET_IP_WHITELIST || '';
      return env ? env.split(',').map((ip) => ip.trim()) : [];
    }

    const env = process.env.WEBHOOK_IP_WHITELIST || '';
    return env ? env.split(',').map((ip) => ip.trim()) : [];
  }

  private isIpAllowed(ip: string, whitelist: string[]): boolean {
    if (whitelist.includes(ip)) {
      return true;
    }

    for (const allowed of whitelist) {
      if (allowed.includes('/')) {
        if (this.isIpInCidr(ip, allowed)) {
          return true;
        }
      }
    }

    return false;
  }

  private isIpInCidr(ip: string, cidr: string): boolean {
    try {
      const [range, bits] = cidr.split('/');
      const mask = ~(2 ** (32 - parseInt(bits)) - 1);

      const ipNum = this.ipToNumber(ip);
      const rangeNum = this.ipToNumber(range);

      return (ipNum & mask) === (rangeNum & mask);
    } catch {
      return false;
    }
  }

  private ipToNumber(ip: string): number {
    return ip.split('.').reduce((acc, octet) => {
      return (acc << 8) + parseInt(octet);
    }, 0);
  }
}
