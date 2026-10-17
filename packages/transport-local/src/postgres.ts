import type {
  Delivery,
  DeliveryTransport,
  RingItem,
  RingResult,
  SubscribeOptions,
  Subscription,
  TransportCapabilities,
  TransportStats,
} from '@qelay-cloud/core';
import { ListenerLink } from './listener';
import { MemoryTransport } from './memory';
import { QueuePoller } from './poller';
import type { LocalDatabase, QueueSource } from './types';
import type { Decoded } from './wire';
import { encodeBell } from './wire';

export const DEFAULT_CHANNEL = 'qcloud_jobs_changed';

export interface PostgresTransportOptions {
  readonly db: LocalDatabase;
  readonly source: QueueSource;
  /** The tenant this transport serves: it rings, and delivers, only bells of this namespace. */
  readonly namespace: string;
  /** The `NOTIFY` channel. Every transport on one database must use the same. Default `qcloud_jobs_changed`. */
  readonly channel?: string;
  /** How often each subscription looks at the database. The delay and retry precision. Default 1,000. */
  readonly pollIntervalMs?: number;
  /** A bell nobody settled comes back after this. Default 30,000. */
  readonly visibilityTimeoutMs?: number;
  /** Most deliverable bells kept per queue. A bell past it is dropped: the poll finds the job. Default 1,000. */
  readonly maxBufferedBells?: number;
  /** How often the `LISTEN` connection is checked. Default 5,000. */
  readonly heartbeatMs?: number;
  /** Randomness of the poll jitter, in [0, 1). Default `Math.random`. */
  readonly random?: () => number;
}

export const MAX_RING_BATCH = 1_000;

/**
 * `DeliveryTransport` on Postgres alone: `NOTIFY` as the wake-up and a poll loop as the safety net.
 * There is no broker. Each `ring` is a notification that reaches every listener of the database; a
 * listener keeps the bells of the queues it serves in memory (so a delayed bell is held until it is
 * due, and an unsettled one comes back), and a poll loop asks the store whether the queue has
 * anything claimable and rings a bell with no job id when it does. The job rows stay the truth: a
 * lost bell costs at most one poll interval.
 *
 * `LISTEN` needs a direct connection. Without one (a pooled connection and no `listenUrl`) the
 * transport runs on the poll loop alone, see `mode`.
 */
export class PostgresLocalTransport implements DeliveryTransport {
  readonly capabilities: TransportCapabilities;
  readonly #options: PostgresTransportOptions;
  readonly #channel: string;
  readonly #pollIntervalMs: number;
  readonly #maxBuffered: number;
  readonly #buffer: MemoryTransport;
  readonly #pollers = new Set<QueuePoller>();
  readonly #queues = new Map<string, number>();
  #link: ListenerLink | null = null;
  #pollOnlyReason: string | null = null;
  #started = false;
  #closed = false;

  constructor(options: PostgresTransportOptions) {
    this.#options = options;
    this.#channel = options.channel ?? DEFAULT_CHANNEL;
    this.#pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? 1_000));
    this.#maxBuffered = Math.max(1, Math.floor(options.maxBufferedBells ?? 1_000));
    this.#buffer = new MemoryTransport({
      visibilityTimeoutMs: options.visibilityTimeoutMs ?? 30_000,
    });
    this.capabilities = {
      maxDeliverDelayMs: Number.POSITIVE_INFINITY,
      maxRingBatch: MAX_RING_BATCH,
      attemptCount: 'none',
      retryGranularityMs: this.#pollIntervalMs,
    };
  }

  /** `listen` while a `LISTEN` connection serves wake-ups, `poll` when only the poll loop does. */
  get mode(): 'listen' | 'poll' {
    return this.#link ? 'listen' : 'poll';
  }

  /** Whether the `LISTEN` connection is up right now: false while it is being replaced, and in poll mode. */
  get listening(): boolean {
    return this.#link?.listening ?? false;
  }

  /** How often the `LISTEN` connection was replaced after a loss. Each one may have cost wake-ups; the poll covered them. */
  get listenerReconnects(): number {
    return this.#link?.reconnects ?? 0;
  }

  /** Why there is no `LISTEN` connection, when there is none: set on the first `subscribe`. */
  get pollOnlyReason(): string | null {
    return this.#pollOnlyReason;
  }

  /** Resolves when the `LISTEN` connection is up (or failed, and is being retried), or there is none. */
  async ready(): Promise<void> {
    await this.#link?.ready;
  }

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    const results: RingResult[] = items.map(() => ({ ok: false, reason: 'unreachable' }));
    const sends: { index: number; payload: string }[] = [];
    items.forEach((item, index) => {
      const delay = Math.ceil(item.deliverAfterMs ?? 0);
      const payload =
        item.bell.namespace === this.#options.namespace && Number.isFinite(delay)
          ? encodeBell(item.bell, Math.max(0, delay))
          : null;
      if (payload === null) results[index] = { ok: false, reason: 'rejected' };
      else sends.push({ index, payload });
    });
    if (sends.length === 0 || this.#closed) return results;
    const statement = `SELECT ${sends.map((_, n) => `pg_notify($1, $${n + 2})`).join(', ')}`;
    try {
      await this.#options.db.run('ring', (sql) =>
        sql.unsafe(statement, [this.#channel, ...sends.map((send) => send.payload)])
      );
      for (const { index } of sends) results[index] = { ok: true };
    } catch {
      // The notifications did not go: the items stay `unreachable` and the tick rings them again.
    }
    return results;
  }

  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    opts: SubscribeOptions
  ): Subscription {
    if (this.#closed) return { refresh() {}, close: async () => {} };
    this.#start();
    const inner = this.#buffer.subscribe(queue, handler, opts);
    const poller = new QueuePoller({
      intervalMs: this.#pollIntervalMs,
      jitter: 0.2,
      random: this.#options.random ?? Math.random,
      capacity: opts.capacity,
      tick: () => this.#buffer.tick(),
      drained: () => {
        const held = this.#buffer.buffered(queue);
        return held.ready + held.inFlight === 0;
      },
      hasClaimable: () => this.#options.source.hasClaimable(queue),
      poke: () => void this.#buffer.ring([{ bell: { namespace: this.#options.namespace, queue } }]),
    });
    this.#pollers.add(poller);
    this.#queues.set(queue, (this.#queues.get(queue) ?? 0) + 1);
    poller.start();
    return {
      refresh: () => {
        inner.refresh();
        poller.soon();
      },
      close: async () => {
        this.#pollers.delete(poller);
        const left = (this.#queues.get(queue) ?? 1) - 1;
        if (left > 0) this.#queues.set(queue, left);
        else this.#queues.delete(queue);
        await poller.stop();
        await inner.close();
      },
    };
  }

  /** The database's counts: `depth` is claimable jobs, not bells, because the bells are not stored. */
  async stats(queue: string): Promise<TransportStats> {
    const snapshot = await this.#options.source.snapshot(queue);
    return {
      depth: snapshot.ready,
      inFlight: snapshot.active,
      delayed: snapshot.delayed,
      oldestAgeMs: snapshot.oldestReadyAgeMs,
      deadLetterDepth: snapshot.failed,
      source: 'postgres-counts',
      observedAt: snapshot.observedAt,
      maxStalenessMs: 0,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const pollers = [...this.#pollers];
    this.#pollers.clear();
    this.#queues.clear();
    await Promise.all(pollers.map((poller) => poller.stop()));
    await this.#link?.close();
    await this.#buffer.close();
  }

  /** Opens the `LISTEN` connection on the first subscription: a process that only rings never does. */
  #start(): void {
    if (this.#started) return;
    this.#started = true;
    try {
      this.#link = new ListenerLink({
        db: this.#options.db,
        channel: this.#channel,
        heartbeatMs: this.#options.heartbeatMs ?? 5_000,
        retryMs: Math.min(this.#pollIntervalMs, 1_000),
        maxRetryMs: 30_000,
        onBell: (bell) => this.#receive(bell),
        onGap: () => this.#pollNow(),
      });
    } catch (error) {
      this.#pollOnlyReason = error instanceof Error ? error.message : String(error);
    }
  }

  #pollNow(): void {
    for (const poller of this.#pollers) poller.soon();
  }

  #receive({ bell, delayMs }: Extract<Decoded, { kind: 'bell' }>): void {
    if (this.#closed || bell.namespace !== this.#options.namespace) return;
    if (!this.#queues.has(bell.queue)) return;
    const held = this.#buffer.buffered(bell.queue);
    if (held.ready + held.delayed >= this.#maxBuffered) return;
    void this.#buffer.ring([{ bell, deliverAfterMs: delayMs }]);
  }
}
