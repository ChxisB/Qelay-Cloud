export interface PollerOptions {
  readonly intervalMs: number;
  /** Each wait is the interval plus or minus this fraction of it. */
  readonly jitter: number;
  readonly random: () => number;
  /** The worker's room right now. At 0 a turn reads nothing and starts nothing. */
  readonly capacity: () => number;
  /** Runs what the clock has made due in the transport's buffer: a delayed bell, a retry, a timeout. */
  readonly tick: () => void;
  /** True when no bell for the queue is held, ready or being handled: only then is a poke useful. */
  readonly drained: () => boolean;
  /** Whether a claim of the queue could find a job now. */
  readonly hasClaimable: () => Promise<boolean>;
  /** Puts a bell with no job id into the buffer: "there is something, look". */
  readonly poke: () => void;
}

const MAX_BACKOFF_STEPS = 3;

/**
 * The poll loop of one subscription: the fallback that finds work when no notification came (none
 * was sent, it was lost in a reconnect, or there is no `LISTEN` behind a pooler), and the clock
 * that releases delayed bells and retries. Its interval is therefore this transport's delay and
 * retry precision. A failed read backs the next turn off, up to eight times the interval.
 */
export class QueuePoller {
  readonly #options: PollerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #turn: Promise<void> | null = null;
  #again = false;
  #stopped = false;
  #failures = 0;

  constructor(options: PollerOptions) {
    this.#options = options;
  }

  start(): void {
    this.#schedule(0);
  }

  /** Asks for a turn at the next opportunity, however many times it is asked. */
  soon(): void {
    if (this.#stopped) return;
    if (this.#turn) this.#again = true;
    else this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#turn;
  }

  #schedule(ms: number): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#turn = this.#poll().finally(() => {
        this.#turn = null;
        if (this.#stopped) return;
        const delay = this.#again ? 0 : this.#wait();
        this.#again = false;
        this.#schedule(delay);
      });
    }, ms);
  }

  #wait(): number {
    const { intervalMs, jitter, random } = this.#options;
    const spread = 1 + jitter * (2 * random() - 1);
    return Math.max(0, intervalMs * spread * 2 ** Math.min(this.#failures, MAX_BACKOFF_STEPS));
  }

  async #poll(): Promise<void> {
    const { tick, capacity, drained, hasClaimable, poke } = this.#options;
    tick();
    if (capacity() <= 0 || !drained()) return;
    try {
      const claimable = await hasClaimable();
      this.#failures = 0;
      if (claimable && !this.#stopped) poke();
    } catch {
      // The database is out of reach: the next turn is later, and the one after that later still.
      this.#failures += 1;
    }
  }
}
