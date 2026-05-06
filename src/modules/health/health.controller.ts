import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import { TonWalletService } from '@/shared/services/ton-wallet/ton-wallet.service';
import { HealthTrackerService } from './health-tracker.service';
import { EventLoopMonitorService } from './event-loop-monitor.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisLockService,
    private readonly tonWallet: TonWalletService,
    private readonly healthTracker: HealthTrackerService,
    private readonly eventLoopMonitor: EventLoopMonitorService,
  ) {}

  @Get('live')
  liveness(@Res() res: Response) {
    const lagMs = this.eventLoopMonitor.getLagMs();
    const status = lagMs < 2000 ? 'ok' : 'degraded';
    const statusCode =
      lagMs < 2000 ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status,
      event_loop_lag_ms: lagMs,
      timestamp: new Date().toISOString(),
    });
  }

  @Get('ready')
  async readiness(@Res() res: Response) {
    const checks: Record<string, boolean> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      checks.postgres = false;
    }

    checks.redis = this.redis.isAvailable();
    checks.toncenter = this.tonWallet.isToncenterConfigured();
    checks.bot_healthy = this.healthTracker.isHealthy();
    checks.event_loop_ok = !this.eventLoopMonitor.isOverloaded();

    const allHealthy =
      checks.postgres &&
      checks.redis &&
      checks.bot_healthy &&
      checks.event_loop_ok;

    const statusCode = allHealthy
      ? HttpStatus.OK
      : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
      errors_last_minute: this.healthTracker.getErrorCount(),
      event_loop: this.eventLoopMonitor.getStats(),
      timestamp: new Date().toISOString(),
    });
  }

  @Get('queue')
  async queueStats(@Res() res: Response) {
    try {
      const now = Date.now();
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(now - 60 * 60 * 1000);

      const [pending, processing, failed, completed24h, deliveryLatencyRows] =
        await Promise.all([
          this.prisma.fragmentQueue.count({ where: { status: 'PENDING' } }),
          this.prisma.fragmentQueue.count({ where: { status: 'PROCESSING' } }),
          this.prisma.fragmentQueue.count({
            where: {
              status: 'FAILED',
              updated_at: { gte: oneDayAgo },
            },
          }),
          this.prisma.fragmentQueue.count({
            where: {
              status: 'COMPLETED',
              updated_at: { gte: oneDayAgo },
            },
          }),
          this.prisma.$queryRaw<
            Array<{
              p50_ms: number;
              p90_ms: number;
              p99_ms: number;
              avg_ms: number;
              max_ms: number;
              sample_count: number;
            }>
          >`
          SELECT
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fq.updated_at - fq.created_at)) * 1000), 0)::float AS p50_ms,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fq.updated_at - fq.created_at)) * 1000), 0)::float AS p90_ms,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (fq.updated_at - fq.created_at)) * 1000), 0)::float AS p99_ms,
            COALESCE(AVG(EXTRACT(EPOCH FROM (fq.updated_at - fq.created_at)) * 1000), 0)::float AS avg_ms,
            COALESCE(MAX(EXTRACT(EPOCH FROM (fq.updated_at - fq.created_at)) * 1000), 0)::float AS max_ms,
            COUNT(*)::int AS sample_count
          FROM fragment_queue fq
          WHERE fq.status = 'COMPLETED'
            AND fq.updated_at >= ${oneHourAgo}
        `,
        ]);

      let walletBalance: string | null = null;
      try {
        walletBalance = await this.tonWallet.getBalance();
      } catch {}

      const latency = deliveryLatencyRows[0];

      return res.status(HttpStatus.OK).json({
        queue: {
          pending,
          processing,
          failed_24h: failed,
          completed_24h: completed24h,
        },
        delivery_latency_1h: {
          p50_ms: Math.round(latency?.p50_ms || 0),
          p90_ms: Math.round(latency?.p90_ms || 0),
          p99_ms: Math.round(latency?.p99_ms || 0),
          avg_ms: Math.round(latency?.avg_ms || 0),
          max_ms: Math.round(latency?.max_ms || 0),
          sample_count: latency?.sample_count || 0,
        },
        wallet: {
          balance_ton: walletBalance
            ? parseFloat(walletBalance).toFixed(4)
            : 'unavailable',
          toncenter_configured: this.tonWallet.isToncenterConfigured(),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  @Get('startup')
  async startup(@Res() res: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return res
        .status(HttpStatus.OK)
        .json({ status: 'started', timestamp: new Date().toISOString() });
    } catch {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'starting', timestamp: new Date().toISOString() });
    }
  }
}
