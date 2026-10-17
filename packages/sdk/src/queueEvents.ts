import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { EventCursor, PostgresStore } from '@qelay-cloud/store-postgres';
import { JOURNAL_START } from '@qelay-cloud/store-postgres';
import { asError, errorMessage } from './errorText';
import type { Logger, Metrics } from './options';
import { checkQueueName, rejectLegacyOptions } from './options';
import type { EventStart, QueueEventListeners } from './queueEventTypes';
import { mapJournalEvent } from './queueEventTypes';
import type { StoreSource } from './runtime';
import { openStore } from './runtime';
import { emitIsolated, TypedEmitter } from './typedEmitter';

export interface QueueEventsOptions extends StoreSource {
  /**
   * Where to start: `'now'` (default) sees only what happens from here on, `'beginning'` reads
   * everything the journal still holds, and an `EventCursor` resumes where a reader stopped (take it
   * from `queueEvents.cursor`).
   */
  readonly start?: EventStart;
  /** Milliseconds between reads while the queue is quiet. Default 250. A busy queue is read back to back. */
  readonly pollInterval?: number;
  /** Read from the constructor on. Default true; with false call `run()`. */
  readonly autorun?: boolean;
  /** Events per read, 1 to 5,000. Default 1,000. */
  readonly batchSize?: number;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

const DEFAULT_POLL_MS = 250;
/** A quiet queue is read less often, up to this many times the poll interval. */
const IDLE_BACKOFF = 8;
const ERROR_RETRY_MIN_MS = 1000;
const ERROR_RETRY_MAX_MS = 10_000;

function isCursor(value: unknown): value is EventCursor {
  const cursor = value as EventCursor;
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger(cursor.commitSeq) &&
    Number.isSafeInteger(cursor.eventId) &&
    cursor.commitSeq >= 0 &&
    cursor.eventId >= 0
  );
}

/**
 * The stream of what happens to the jobs of one queue, read from the event journal (`qcloud_events`)
 * that `PostgresStore` writes in the same transaction as each change. Qelay's `QueueEvents`, with
 * these differences (docs/compat.md):
 *
 * - It polls. The journal sends no notification, so an event arrives within `pollInterval` (default
 *   250 ms, up to 8× that on a quiet queue).
 * - Nothing is lost or repeated: the reader follows commit order, so a transaction that committed
 *   late is still delivered, and `cursor` is exact after every event, so a stopped reader resumes
 *   from a stored cursor with no gap and no duplicate.
 * - Retention can delete events a reader was too slow to read. It emits `gap` and goes on from the
 *   oldest event left; reload what you show from the jobs.
 * - `completed` carries no return value; read it with `queue.getJob(jobId)`.
 *
 * ```ts
 * const events = new QueueEvents('telemetry', { databaseUrl });
 * events.on('completed', ({ jobId }) => console.log('done', jobId));
 * await events.close();
 * ```
 */
export class QueueEvents extends TypedEmitter<QueueEventListeners> {
  readonly name: string;
  readonly #store: PostgresStore;
  readonly #owned: boolean;
  readonly #pollMs: number;
  readonly #batch: number;
  readonly #warn: (message: string, context?: Record<string, unknown>) => void;
  #cursor: EventCursor | null;
  #loop: Promise<void> | null = null;
  #ready = Promise.withResolvers<void>();
  #readySettled = false;
  #closing: Promise<void> | null = null;
  #stopped = false;
  #wake: (() => void) | null = null;

  constructor(name: string, options: QueueEventsOptions) {
    super();
    rejectLegacyOptions(options);
    this.name = checkQueueName(name);
    const start = options.start ?? 'now';
    if (start !== 'now' && start !== 'beginning' && !isCursor(start)) {
      throw new UnsupportedOptionError(
        'start',
        "must be 'now', 'beginning' or an EventCursor { commitSeq, eventId }"
      );
    }
    const pollMs = options.pollInterval ?? DEFAULT_POLL_MS;
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 3_600_000) {
      throw new UnsupportedOptionError('pollInterval', 'must be an integer from 1 to 3,600,000');
    }
    const batch = options.batchSize ?? 1000;
    if (!Number.isInteger(batch) || batch < 1 || batch > 5000) {
      throw new UnsupportedOptionError('batchSize', 'must be an integer from 1 to 5,000');
    }
    const { store, owned } = openStore(options, 0);
    this.#store = store;
    this.#owned = owned;
    this.#pollMs = pollMs;
    this.#batch = batch;
    this.#cursor = start === 'beginning' ? JOURNAL_START : isCursor(start) ? start : null;
    this.#warn = (message, context) => {
      try {
        options.logger?.warn(message, context);
      } catch {
        // A broken logger must not stop the stream.
      }
    };
    if (options.autorun ?? true) this.run();
  }

  /**
   * Where the reader stands: everything up to and including the last event it emitted is consumed.
   * Null until the start position is known (`start: 'now'` reads it from the database first).
   * Persist it and pass it as `start` to resume.
   */
  get cursor(): EventCursor | null {
    return this.#cursor;
  }

  /** Starts reading. Does nothing when it already runs or is closing. */
  run(): void {
    if (this.#loop !== null || this.#closing !== null) return;
    this.#ready.promise.catch(() => {});
    this.#loop = this.#read();
  }

  /**
   * Resolves once the reader is positioned and the database has answered: from then on every event
   * after the start is seen. Rejects with the first read error; the reader keeps retrying on its own.
   */
  async waitUntilReady(): Promise<void> {
    if (this.#loop === null) this.run();
    await this.#ready.promise;
  }

  /** Stops reading and closes the store when this reader opened it. Idempotent; never throws. */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  /** The same as `close`, for code written against Qelay's `disconnect`. */
  disconnect(): Promise<void> {
    return this.close();
  }

  #markReady(error?: Error): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    if (error === undefined) this.#ready.resolve();
    else this.#ready.reject(error);
  }

  async #read(): Promise<void> {
    let quiet = 0;
    let failures = 0;
    while (!this.#stopped) {
      try {
        if (this.#cursor === null) {
          // Taken once and kept; a failed attempt is retried, never skipped past.
          this.#cursor = await this.#store.events.baseline();
          if (this.#stopped) return;
          this.#markReady();
        }
        const busy = await this.#readOnce();
        this.#markReady();
        failures = 0;
        quiet = busy ? 0 : Math.min(quiet + 1, IDLE_BACKOFF);
        if (!busy) await this.#nap(this.#pollMs * Math.max(1, quiet));
      } catch (caught) {
        if (this.#stopped) return;
        const error = asError(caught);
        failures += 1;
        this.#markReady(error);
        this.#warn('queue events read failed', { queue: this.name, error: error.message });
        if (this.listenerCount('error') > 0) this.#emitSafe('error', error);
        await this.#nap(Math.min(ERROR_RETRY_MIN_MS * 2 ** (failures - 1), ERROR_RETRY_MAX_MS));
      }
    }
  }

  /** One page. True when more is waiting, so the next read follows at once. */
  async #readOnce(): Promise<boolean> {
    const from = this.#cursor;
    if (from === null) return false;
    const page = await this.#store.events.read(from, { limit: this.#batch, queue: this.name });
    if (this.#stopped) return false;
    if (page.gap) this.#emitSafe('gap');
    for (const event of page.events) {
      const mapped = mapJournalEvent(event);
      if (mapped !== null) this.#emitSafe(mapped.name, mapped.payload);
      // Exact after every event: a reader closed inside a listener resumes after this one.
      this.#cursor = { commitSeq: event.commitSeq, eventId: event.id };
      if (this.#stopped) return false;
    }
    this.#cursor = page.cursor;
    return page.more;
  }

  /** Sleeps, but wakes early when the reader closes. */
  #nap(ms: number): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(wake, ms);
      function wake(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = wake;
    });
  }

  #emitSafe(event: string, ...args: unknown[]): void {
    emitIsolated(this, event, args, (error) =>
      this.#warn('queue events listener threw', { event, error: errorMessage(error) })
    );
  }

  async #shutdown(): Promise<void> {
    this.#stopped = true;
    this.#wake?.();
    try {
      await this.#loop;
    } catch {
      // The loop reports its own errors.
    }
    if (this.#owned) await this.#store.close({ timeout: 5000 }).catch(() => {});
  }
}
