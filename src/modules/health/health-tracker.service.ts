import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthTrackerService {
  private recentErrors: number[] = [];
  private readonly ERROR_WINDOW_MS = 60_000;
  private readonly MAX_ERRORS_PER_WINDOW = 15;

  recordError(): void {
    const now = Date.now();
    this.recentErrors.push(now);
    this.recentErrors = this.recentErrors.filter(
      (t) => now - t < this.ERROR_WINDOW_MS,
    );
  }

  isHealthy(): boolean {
    const now = Date.now();
    const recent = this.recentErrors.filter(
      (t) => now - t < this.ERROR_WINDOW_MS,
    );
    return recent.length < this.MAX_ERRORS_PER_WINDOW;
  }

  getErrorCount(): number {
    const now = Date.now();
    return this.recentErrors.filter((t) => now - t < this.ERROR_WINDOW_MS)
      .length;
  }
}
