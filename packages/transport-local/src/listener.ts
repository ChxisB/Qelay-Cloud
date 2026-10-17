import type { SQL } from 'bun';
import type { LocalDatabase } from './types';
import type { Decoded } from './wire';
import { decode, encodeHeartbeat } from './wire';

export interface ListenerOptions {
  readonly db: LocalDatabase;
  readonly channel: string;
  /** How often a heartbeat goes out, and so how long an unheard one takes to be noticed (twice this). */
  readonly heartbeatMs: number;
  /** The first wait before a failed connection is tried again; it doubles up to `maxRetryMs`. */
  readonly retryMs: number;
  readonly maxRetryMs: number;
  readonly onBell: (bell: Extract<Decoded, { kind: 'bell' }>) => void;
  /**
   * The connection was (re)established or replaced. `NOTIFY` has no replay, so whatever was sent
   * while it was down is gone: the caller polls once, now, rather than wait for its next turn.
   */
  readonly onGap: () => void;
}

/**
 * One dedicated `LISTEN` connection, kept alive. Bun's driver quietly re-establishes a killed
 * connection but says nothing when it does, and a notification sent in the gap is lost, so the
 * link sends itself a heartbeat through the pool and replaces the connection when one is not heard
 * within a period. Nothing here is needed for correctness (the poll loop finds every claimable
 * job on its own): it keeps the wake-up fast and tells the caller when a gap may have happened.
 */
export class ListenerLink {
  readonly #options: ListenerOptions;
  readonly #instance = crypto.randomUUID();
  #sql: SQL | null;
  #sent = 0;
  #heard = 0;
  #closed = false;
  #wake: (() => void) | null = null;
  #listening = false;
  #reconnects = 0;
  readonly #first: Promise<void>;

  /** Throws what `openListener` throws: the caller treats that as "no `LISTEN` here, poll only". */
  constructor(options: ListenerOptions) {
    this.#options = options;
    this.#sql = options.db.openListener();
    this.#first = new Promise<void>((resolve) => {
      void this.#loop(resolve);
    });
  }

  /** Resolves once the first connection is listening, or has failed (it is then retried). */
  get ready(): Promise<void> {
    return this.#first;
  }

  get listening(): boolean {
    return this.#listening;
  }

  /** How many times the connection was lost and re-established, each a possible gap in the wake-ups. */
  get reconnects(): number {
    return this.#reconnects;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#wake?.();
    await this.#drop();
  }

  async #loop(firstDone: () => void): Promise<void> {
    let retryMs = this.#options.retryMs;
    let reconnect = false;
    while (!this.#closed) {
      try {
        this.#sql ??= this.#options.db.openListener();
        const sql = this.#sql;
        await sql.listen(this.#options.channel, (payload: string) => this.#receive(payload));
        this.#listening = true;
        retryMs = this.#options.retryMs;
        firstDone();
        if (reconnect) {
          this.#reconnects += 1;
          this.#options.onGap();
        }
        await this.#watch();
      } catch {
        // Connecting failed: wait and try again.
      }
      this.#listening = false;
      firstDone();
      await this.#drop();
      if (this.#closed) break;
      reconnect = true;
      await this.#sleep(retryMs);
      retryMs = Math.min(retryMs * 2, this.#options.maxRetryMs);
    }
    firstDone();
  }

  /** Returns when a heartbeat was not heard in time, or the link was closed. */
  async #watch(): Promise<void> {
    const { db, channel, heartbeatMs } = this.#options;
    while (!this.#closed) {
      if (this.#heard < this.#sent) return;
      this.#sent += 1;
      const payload = encodeHeartbeat(this.#instance, this.#sent);
      db.run('transportHeartbeat', (sql) => sql.notify(channel, payload)).catch(() => {});
      await this.#sleep(heartbeatMs);
    }
  }

  #receive(payload: string): void {
    const decoded = decode(payload);
    if (decoded === null) return;
    if (decoded.kind === 'heartbeat') {
      if (decoded.instance === this.#instance)
        this.#heard = Math.max(this.#heard, decoded.sequence);
      return;
    }
    this.#options.onBell(decoded);
  }

  async #drop(): Promise<void> {
    const sql = this.#sql;
    this.#sql = null;
    this.#sent = 0;
    this.#heard = 0;
    if (sql) await sql.close({ timeout: 0 }).catch(() => {});
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = done;
    });
  }
}
