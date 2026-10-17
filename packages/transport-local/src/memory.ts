import type {
  Bell,
  Clock,
  Delivery,
  DeliveryTransport,
  RingItem,
  RingResult,
  SubscribeOptions,
  Subscription,
  TransportCapabilities,
  TransportStats,
} from '@qelay-cloud/core';
import { systemClock } from '@qelay-cloud/core';

interface Entry {
  readonly bell: Bell;
  readonly rungAt: number;
  visibleAt: number;
  inFlight: boolean;
}

interface Subscriber {
  readonly queue: string;
  readonly handler: (delivery: Delivery) => Promise<void>;
  readonly capacity: () => number;
  closed: boolean;
}

export interface BufferedBells {
  readonly ready: number;
  readonly inFlight: number;
  readonly delayed: number;
  /** When the oldest deliverable bell was rung, null when none is deliverable. */
  readonly oldestRungAt: number | null;
}

export interface MemoryTransportOptions {
  readonly clock?: Clock;
  readonly capabilities?: Partial<TransportCapabilities>;
  /** Chooses which deliverable bell goes next, given how many there are. Default: the oldest. */
  readonly pick?: (deliverable: number) => number;
  /** How long a bell stays hidden when its handler returns without `ack` or `nack`. Default 30 s. */
  readonly visibilityTimeoutMs?: number;
}

/**
 * In-process `DeliveryTransport` for unit tests and the model harness. Deterministic: bells move
 * only when a call moves them, and time comes from the injected `Clock`. Fault controls are
 * one-shot counters so a test (or a shrunk model history) states exactly which ring is faulted.
 */
export class MemoryTransport implements DeliveryTransport {
  readonly capabilities: TransportCapabilities;
  readonly #clock: Clock;
  readonly #pick: (deliverable: number) => number;
  readonly #visibilityTimeoutMs: number;
  readonly #entries = new Map<string, Entry[]>();
  readonly #subscribers = new Set<Subscriber>();
  readonly #running = new Set<Promise<void>>();
  #drop = 0;
  #duplicate = 0;
  #lags: number[] = [];
  #failures: { match: (item: RingItem) => boolean; reason: 'rejected' | 'unreachable' }[] = [];
  #closed = false;

  constructor(options: MemoryTransportOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#pick = options.pick ?? (() => 0);
    this.#visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    this.capabilities = {
      maxDeliverDelayMs: Number.POSITIVE_INFINITY,
      maxRingBatch: 1_000,
      attemptCount: 'none',
      retryGranularityMs: 1,
      ...options.capabilities,
    };
  }

  /** The next `n` accepted rings are reported `ok` and then lost, as a broker can. */
  dropNext(n = 1): void {
    this.#drop += n;
  }

  /** The next `n` accepted rings are delivered twice. */
  duplicateNext(n = 1): void {
    this.#duplicate += n;
  }

  /** The next `n` accepted rings become visible `ms` later than asked, as a slow broker does. */
  delayNext(ms: number, n = 1): void {
    for (let i = 0; i < n; i += 1) this.#lags.push(ms);
  }

  /** The next ring item matching `match` is refused with `reason`, so a batch half-fails. */
  failWhere(
    match: (item: RingItem) => boolean,
    reason: 'rejected' | 'unreachable' = 'unreachable'
  ): void {
    this.#failures.push({ match, reason });
  }

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    const results = items.map((item) => this.#accept(item));
    this.#wake();
    return results;
  }

  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    opts: SubscribeOptions
  ): Subscription {
    const subscriber: Subscriber = { queue, handler, capacity: opts.capacity, closed: false };
    this.#subscribers.add(subscriber);
    this.#wake();
    return {
      refresh: () => this.#wake(),
      close: async () => {
        subscriber.closed = true;
        this.#subscribers.delete(subscriber);
        await this.idle();
      },
    };
  }

  /** The bells held for `queue` right now: deliverable, being handled, and not yet visible. */
  buffered(queue: string): BufferedBells {
    const now = this.#clock.now();
    const entries = this.#entries.get(queue) ?? [];
    const waiting = entries.filter((e) => !e.inFlight);
    const ready = waiting.filter((e) => e.visibleAt <= now);
    return {
      ready: ready.length,
      inFlight: entries.length - waiting.length,
      delayed: waiting.length - ready.length,
      oldestRungAt: ready.length === 0 ? null : Math.min(...ready.map((e) => e.rungAt)),
    };
  }

  async stats(queue: string): Promise<TransportStats> {
    const now = this.#clock.now();
    const held = this.buffered(queue);
    return {
      depth: held.ready,
      inFlight: held.inFlight,
      delayed: held.delayed,
      oldestAgeMs: held.oldestRungAt === null ? null : now - held.oldestRungAt,
      deadLetterDepth: 0,
      source: 'memory',
      observedAt: now,
      maxStalenessMs: 0,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#subscribers.clear();
    await this.idle();
  }

  /** Resolves when no handler is running and nothing more can be delivered right now. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  /** Delivers whatever has become visible since the clock moved. Call after advancing time. */
  tick(): void {
    this.#wake();
  }

  #accept(item: RingItem): RingResult {
    const failed = this.#failures.findIndex((f) => f.match(item));
    if (failed >= 0) {
      const [failure] = this.#failures.splice(failed, 1);
      return { ok: false, reason: failure?.reason ?? 'unreachable' };
    }
    const delay = Math.ceil(item.deliverAfterMs ?? 0);
    if (delay > this.capabilities.maxDeliverDelayMs) return { ok: false, reason: 'delay-too-long' };
    if (this.#drop > 0) {
      this.#drop -= 1;
      return { ok: true };
    }
    const copies = this.#duplicate > 0 ? 2 : 1;
    if (copies === 2) this.#duplicate -= 1;
    const now = this.#clock.now();
    const lag = this.#lags.shift() ?? 0;
    const queue = this.#entries.get(item.bell.queue) ?? [];
    for (let i = 0; i < copies; i += 1) {
      queue.push({ bell: item.bell, rungAt: now, visibleAt: now + delay + lag, inFlight: false });
    }
    this.#entries.set(item.bell.queue, queue);
    return { ok: true };
  }

  #wake(): void {
    if (this.#closed) return;
    for (const subscriber of this.#subscribers) this.#pump(subscriber);
  }

  #pump(subscriber: Subscriber): void {
    const now = this.#clock.now();
    const entries = this.#entries.get(subscriber.queue) ?? [];
    let room = Math.max(0, Math.floor(subscriber.capacity()));
    while (room > 0 && !subscriber.closed) {
      const deliverable = entries.filter((e) => !e.inFlight && e.visibleAt <= now);
      const entry = deliverable[this.#pick(deliverable.length) % Math.max(deliverable.length, 1)];
      if (!entry) return;
      entry.inFlight = true;
      room -= 1;
      this.#run(subscriber, entry, entries);
    }
  }

  #run(subscriber: Subscriber, entry: Entry, entries: Entry[]): void {
    let settled = false;
    const remove = () => {
      const at = entries.indexOf(entry);
      if (at >= 0) entries.splice(at, 1);
    };
    const delivery: Delivery = {
      bell: entry.bell,
      attempt: null,
      ack: async () => {
        settled = true;
        remove();
      },
      nack: async (retryInMs = 0) => {
        settled = true;
        entry.inFlight = false;
        entry.visibleAt = this.#clock.now() + Math.max(0, Math.ceil(retryInMs));
      },
    };
    const run = (async () => {
      try {
        await subscriber.handler(delivery);
      } catch {
        // A thrown handler leaves the bell unsettled, so it comes back: at-least-once.
      }
      if (!settled) {
        entry.inFlight = false;
        entry.visibleAt = this.#clock.now() + this.#visibilityTimeoutMs;
      }
    })().finally(() => {
      this.#running.delete(run);
      this.#wake();
    });
    this.#running.add(run);
  }
}
