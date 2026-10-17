import type { Clock } from '@qelay-cloud/core';
import type { RateLimitSettings } from '../config';

interface Bucket {
  tokens: number;
  at: number;
}

const MAX_BUCKETS = 10_000;

export type Take = { readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number };

/**
 * A token bucket per principal, held in this process's memory: with N instances a caller can make N
 * times the rate, and a restart forgets every bucket. It is a brake on a runaway client or a stolen
 * token, not a quota. Idle buckets are dropped, and the table is bounded.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  constructor(
    private readonly settings: RateLimitSettings,
    private readonly clock: Clock
  ) {}

  take(key: string): Take {
    const now = this.clock.now();
    const { burst, perSecond } = this.settings;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      this.#makeRoom(now);
      bucket = { tokens: burst, at: now };
      this.#buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
      bucket.at = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond)) };
  }

  get size(): number {
    return this.#buckets.size;
  }

  #makeRoom(now: number): void {
    if (this.#buckets.size < MAX_BUCKETS) return;
    const { burst, perSecond } = this.settings;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + ((now - bucket.at) / 1000) * perSecond >= burst)
        this.#buckets.delete(key);
    }
    if (this.#buckets.size >= MAX_BUCKETS) {
      const oldest = this.#buckets.keys().next();
      if (!oldest.done) this.#buckets.delete(oldest.value);
    }
  }
}
