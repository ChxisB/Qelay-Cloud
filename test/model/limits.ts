export interface RateSpec {
  readonly max: number;
  readonly durationMs: number;
}

interface Window extends RateSpec {
  startedAt: number;
  count: number;
}

/**
 * A queue's rate and concurrency limits, as a claim sees them. The rate is a fixed window that
 * restarts at the first claim after it ran out (not on a fixed grid), and changing the limit starts
 * a fresh one. The reference model and `FakeStore` share this class on purpose: the Postgres store is
 * the independent implementation, and the model run is what compares the two.
 */
export class QueueLimits {
  readonly #rate = new Map<string, Window>();
  readonly #concurrency = new Map<string, number>();

  setRate(queue: string, spec: RateSpec | null, now: number): void {
    if (spec === null) this.#rate.delete(queue);
    else this.#rate.set(queue, { ...spec, startedAt: now, count: 0 });
  }

  setConcurrency(queue: string, max: number | null): void {
    if (max === null) this.#concurrency.delete(queue);
    else this.#concurrency.set(queue, max);
  }

  /** A claim of `queue` starts. A window that has run out restarts at `now`, with a count of 0. */
  refresh(queue: string, now: number): void {
    const window = this.#rate.get(queue);
    if (window && now >= window.startedAt + window.durationMs) {
      window.startedAt = now;
      window.count = 0;
    }
  }

  /** How many of `n` jobs a claim may take, with `active` jobs of the queue holding an unexpired lease. */
  room(queue: string, n: number, active: number): number {
    const window = this.#rate.get(queue);
    const concurrency = this.#concurrency.get(queue);
    const rateRoom = window ? Math.max(0, window.max - window.count) : n;
    const concurrencyRoom = concurrency === undefined ? n : Math.max(0, concurrency - active);
    return Math.min(n, rateRoom, concurrencyRoom);
  }

  /** `count` jobs were claimed from `queue`. */
  took(queue: string, count: number): void {
    const window = this.#rate.get(queue);
    if (window) window.count += count;
  }
}
