import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import { RedisLockService } from '@/shared/services/redis/redis-lock.service';
import {
  FragmentScreenshotService,
  FragmentSnapshotView,
  SnapshotRow,
} from '@/shared/services/fragment/fragment-screenshot.service';

const SCREENSHOT_PAYMENT_SELECT = {
  id: true,
  order_number: true,
  product_type: true,
  fragment_queue: {
    where: { status: 'COMPLETED' as const },
    select: {
      username: true,
      stars: true,
      ton: true,
      premium: true,
      ton_amount: true,
      updated_at: true,
      fragment_account_id: true,
    },
    orderBy: { updated_at: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.PaymentSelect;

type ScreenshotPaymentRow = Prisma.PaymentGetPayload<{
  select: typeof SCREENSHOT_PAYMENT_SELECT;
}>;

@Injectable()
export class ScreenshotQueueService {
  private readonly logger = new Logger(ScreenshotQueueService.name);

  private readonly LOCK_ID = 'screenshot-queue-processor';
  private readonly LOCK_TTL_SECONDS = 120;
  private readonly BATCH_SIZE = 10;
  private readonly CONTEXT_ROWS = 9;

  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly screenshotService: FragmentScreenshotService,
  ) {}

  @Cron('*/30 * * * * *')
  async processScreenshotQueue(): Promise<void> {
    if (this.isProcessing) return;

    const acquired = await this.redisLock.acquireLock(
      this.LOCK_ID,
      this.LOCK_TTL_SECONDS,
    );
    if (!acquired) return;

    this.isProcessing = true;

    try {
      const payments = await this.prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          fragment_screenshot: null,
          created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          fragment_queue: { some: { status: 'COMPLETED' } },
        },
        select: SCREENSHOT_PAYMENT_SELECT,
        orderBy: { created_at: 'asc' },
        take: this.BATCH_SIZE,
      });

      if (payments.length === 0) return;

      this.logger.log(`Processing ${payments.length} pending screenshot(s)`);

      await Promise.all(
        payments.map((payment) => this.tryCaptureFragmentScreenshot(payment)),
      );

      await this.redisLock.extendLock(this.LOCK_ID, this.LOCK_TTL_SECONDS);
    } catch (error: any) {
      this.logger.error(`Screenshot queue error: ${error.message}`);
    } finally {
      this.isProcessing = false;
      await this.redisLock.releaseLock(this.LOCK_ID);
    }
  }

  private async tryCaptureFragmentScreenshot(
    payment: ScreenshotPaymentRow,
  ): Promise<'captured' | 'skipped'> {
    const queueItem = payment.fragment_queue[0];
    if (!queueItem?.username) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { fragment_screenshot: 'skipped' },
      });
      return 'skipped';
    }

    const view: FragmentSnapshotView =
      payment.product_type === 'PREMIUM'
        ? 'premium'
        : payment.product_type === 'TON'
          ? 'ton'
          : 'stars';

    const hasProduct =
      (view === 'stars' && queueItem.stars != null && queueItem.stars > 0) ||
      (view === 'premium' &&
        queueItem.premium != null &&
        queueItem.premium > 0) ||
      (view === 'ton' && queueItem.ton != null && queueItem.ton > 0);

    if (!hasProduct) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { fragment_screenshot: 'skipped' },
      });
      return 'skipped';
    }

    const contextRows = await this.fetchContextRows(
      payment.id,
      queueItem.fragment_account_id,
      queueItem.updated_at,
      view,
    );

    const stored = await this.screenshotService.captureOrderSnapshot({
      view,
      paymentId: payment.id,
      orderNumber: payment.order_number,
      recipientUsername: queueItem.username,
      starsAmount: queueItem.stars ?? 0,
      premiumMonths: queueItem.premium ?? null,
      tonProductAmount: queueItem.ton ?? null,
      amountTon: queueItem.ton_amount ?? null,
      txHash: null,
      completedAt: queueItem.updated_at,
      contextRows,
    });

    return stored ? 'captured' : 'skipped';
  }

  private async fetchContextRows(
    excludePaymentId: string,
    fragmentAccountId: string | null,
    aroundDate: Date,
    view: FragmentSnapshotView,
  ): Promise<SnapshotRow[]> {
    const half = Math.floor(this.CONTEXT_ROWS / 2);

    const where: Record<string, unknown> = {
      status: 'COMPLETED',
      payment_id: { not: excludePaymentId },
    };
    if (fragmentAccountId) {
      where.fragment_account_id = fragmentAccountId;
    }
    if (view === 'premium') {
      where.premium = { not: null };
    } else if (view === 'ton') {
      where.ton = { not: null };
    } else {
      where.stars = { not: null };
    }

    const select = {
      username: true,
      stars: true,
      ton: true,
      premium: true,
      ton_amount: true,
      updated_at: true,
    };

    const newer = await this.prisma.fragmentQueue.findMany({
      where: { ...where, updated_at: { gt: aroundDate } },
      select,
      orderBy: { updated_at: 'asc' },
      take: half,
    });

    const older = await this.prisma.fragmentQueue.findMany({
      where: { ...where, updated_at: { lt: aroundDate } },
      select,
      orderBy: { updated_at: 'desc' },
      take: this.CONTEXT_ROWS - newer.length,
    });

    const toRow = (item: {
      username: string;
      stars: number | null;
      ton: number | null;
      premium: number | null;
      ton_amount: number | null;
      updated_at: Date;
    }): SnapshotRow => ({
      username: item.username,
      stars: item.stars ?? 0,
      premiumMonths: item.premium,
      tonAmount: item.ton,
      amountTon: item.ton_amount,
      completedAt: item.updated_at,
    });

    return [...newer.reverse().map(toRow), ...older.map(toRow)];
  }
}
