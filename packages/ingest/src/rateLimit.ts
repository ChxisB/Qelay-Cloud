/**
 * A fixed-minute counter per key. Keys are source ids the store knows (at most `MAX_SOURCES`) and one global key, so the
 * map stays small without a bound of its own.
 *
 * shortcut: the count is per process, so N instances take N times the rate; upgrade to a shared counter if that matters
 * (the edge's own limit is the first line, see the runbook).
 */
export class MinuteLimiter {
  private window = -1;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now
  ) {}

  /** 0 when the call may go on; otherwise the seconds until the minute ends (the `Retry-After`). */
  take(key: string): number {
    const at = this.now();
    const window = Math.floor(at / 60_000);
    if (window !== this.window) {
      this.window = window;
      this.counts.clear();
    }
    const seen = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, seen);
    return seen <= this.limit ? 0 : Math.max(1, Math.ceil(((window + 1) * 60_000 - at) / 1000));
  }
}
