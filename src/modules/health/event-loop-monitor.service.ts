import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as v8 from 'v8';

@Injectable()
export class EventLoopMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopMonitorService.name);

  private histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private samplerInterval: NodeJS.Timeout | null = null;

  private currentLagMs = 0;
  private peakLagMs = 0;
  private readonly LAG_WARNING_MS = 200;
  private readonly LAG_CRITICAL_MS = 500;
  private readonly OVERLOADED_THRESHOLD_MS = 1000;

  private memoryUsagePercent = 0;
  private readonly MEMORY_CRITICAL_PERCENT = 85;

  onModuleInit() {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();

    this.samplerInterval = setInterval(() => this.sample(), 5_000);
    this.samplerInterval.unref();
  }

  onModuleDestroy() {
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
    if (this.samplerInterval) {
      clearInterval(this.samplerInterval);
      this.samplerInterval = null;
    }
  }

  private sample() {
    if (!this.histogram) return;

    const p99 = this.histogram.percentile(99) / 1e6;
    const max = this.histogram.max / 1e6;
    this.currentLagMs = Math.round(p99);
    this.peakLagMs = Math.max(this.peakLagMs, Math.round(max));
    this.histogram.reset();

    const heapStats = v8.getHeapStatistics();
    this.memoryUsagePercent = Math.round(
      (heapStats.used_heap_size / heapStats.heap_size_limit) * 100,
    );

    if (this.currentLagMs > this.LAG_CRITICAL_MS) {
      this.logger.error(
        `CRITICAL event loop lag: ${this.currentLagMs}ms (peak: ${this.peakLagMs}ms), heap: ${this.memoryUsagePercent}%`,
      );
    } else if (this.currentLagMs > this.LAG_WARNING_MS) {
      this.logger.warn(
        `High event loop lag: ${this.currentLagMs}ms, heap: ${this.memoryUsagePercent}%`,
      );
    }
  }

  isOverloaded(): boolean {
    return (
      this.currentLagMs > this.OVERLOADED_THRESHOLD_MS ||
      this.memoryUsagePercent > this.MEMORY_CRITICAL_PERCENT
    );
  }

  getLagMs(): number {
    return this.currentLagMs;
  }

  getPeakLagMs(): number {
    return this.peakLagMs;
  }

  getMemoryPercent(): number {
    return this.memoryUsagePercent;
  }

  getStats() {
    const mem = process.memoryUsage();
    return {
      event_loop_lag_ms: this.currentLagMs,
      event_loop_peak_ms: this.peakLagMs,
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      heap_percent: this.memoryUsagePercent,
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      overloaded: this.isOverloaded(),
    };
  }

  resetPeak() {
    this.peakLagMs = 0;
  }
}
