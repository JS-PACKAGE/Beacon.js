import { performance } from 'node:perf_hooks';

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(private readonly capacity: number, private readonly windowMs: number) {
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('Invalid rate bucket');
    this.tokens = capacity;
    this.updatedAt = performance.now();
  }

  take(now = performance.now()): boolean {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.capacity / this.windowMs);
    this.updatedAt = Math.max(now, this.updatedAt);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
