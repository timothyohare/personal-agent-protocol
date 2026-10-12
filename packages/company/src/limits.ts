// DPoP nonces (spec 4.3) and a simple fixed-window rate limiter (spec 4.2 `rate_limited`, T-19).
import { rid } from "poppy-core";

export class NonceManager {
  readonly required: boolean;
  private readonly rotateMs: number;
  private readonly now: () => number;
  private current = rid();
  private rotatedAt: number;

  constructor(required: boolean, rotateMs = 5 * 60_000, now: () => number = Date.now) {
    this.required = required;
    this.rotateMs = rotateMs;
    this.now = now;
    this.rotatedAt = now();
  }

  /** The nonce a proof must carry right now (rotating it when due), or undefined if nonces are off. */
  expected(): string | undefined {
    if (!this.required) return undefined;
    if (this.now() - this.rotatedAt >= this.rotateMs) {
      this.current = rid();
      this.rotatedAt = this.now();
    }
    return this.current;
  }
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns 0 if allowed, or the seconds to wait before retrying. */
  hit(key: string): number {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count > this.limit ? Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) : 0;
  }
}
