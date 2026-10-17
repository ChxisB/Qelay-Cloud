import type { Clock } from '@qelay-cloud/core';

interface Entry {
  readonly at: number;
  readonly value: Promise<unknown>;
}

/** The request header that skips the cache: the answer is read fresh (and replaces the cached one). */
export const CACHE_BYPASS_HEADER = 'x-qelay-cache';

/** True when the caller sent `x-qelay-cache: bypass`. */
export const wantsFresh = (request: Request): boolean =>
  request.headers.get(CACHE_BYPASS_HEADER)?.toLowerCase() === 'bypass';

/**
 * A few answers kept for a short time by this process, so a panel polling every second costs the
 * database one read per `ttlMs` and not one per request. It is not shared between processes (each
 * instance has its own, so a stale answer is at most `ttlMs` old everywhere) and it belongs to one
 * store, which is one namespace: nothing here is ever served across namespaces. Concurrent misses
 * share one read. A failed read is not kept. With `ttlMs` 0 nothing is kept at all.
 */
export class TtlCache {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock
  ) {}

  get<T>(key: string, load: () => Promise<T>, bypass = false): Promise<T> {
    if (this.ttlMs === 0) return load();
    const now = this.clock.now();
    const kept = this.#entries.get(key);
    if (!bypass && kept !== undefined && now - kept.at < this.ttlMs) {
      return kept.value as Promise<T>;
    }
    const value = load();
    const entry: Entry = { at: now, value };
    this.#entries.set(key, entry);
    value.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return value;
  }
}
