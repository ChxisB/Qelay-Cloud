/**
 * What the sender holds per destination, a host and a port, whatever webhooks point at it: how many
 * requests are in flight to it, and whether it has been failing.
 *
 * - **Concurrency.** At most `concurrency` requests at once. One that cannot get a slot waits, and
 *   gives up (`'busy'`) when its attempt's time is spent; the wait is inside the attempt, so the claim's
 *   lease still outlasts it.
 * - **Circuit breaker.** After `failures` failed attempts in a row the destination is `'open'` for
 *   `cooldownMs`: attempts to it are refused at once, without a connection, so a dead receiver costs the
 *   sender no sockets and no timeouts. After the cooldown one attempt goes through as a probe: a good
 *   answer closes the breaker, a bad one opens it for another cooldown. A refused attempt is recorded
 *   as a failed one (the store has no way to hand a claim back), so it counts toward the delivery's
 *   attempts as the attempt it replaced would have.
 *
 * A failed attempt is a connection that did not complete, a timeout, a 5xx or a 429. Any other answer
 * means the receiver is up and speaking, whatever it thinks of the delivery.
 *
 * State is in memory and per process: several senders each learn that a destination is down for
 * themselves. It is one entry per destination that has a request in flight or a failure on record; a
 * namespace has at most 100 webhooks, so it stays small.
 */

export interface DestinationLimits {
  /** Requests in flight to one destination. */
  readonly concurrency: number;
  /** Failed attempts in a row that open the breaker. 0 turns the breaker off. */
  readonly failures: number;
  readonly cooldownMs: number;
}

export interface Entry {
  /** Ends the request. `healthy` false counts toward the breaker. */
  leave(healthy: boolean): void;
}

export type Refusal = 'busy' | 'open';

interface State {
  inflight: number;
  waiting: Array<() => void>;
  failed: number;
  openUntil: number;
  probing: boolean;
}

export class Destinations {
  readonly #limits: DestinationLimits;
  readonly #now: () => number;
  readonly #states = new Map<string, State>();

  constructor(limits: DestinationLimits, now: () => number = () => performance.now()) {
    this.#limits = limits;
    this.#now = now;
  }

  /** A slot to send in, or why there is none. Waits for a slot at most `waitMs`. */
  async enter(key: string, waitMs: number): Promise<Entry | Refusal> {
    const state = this.#states.get(key) ?? this.#add(key);
    if (state.inflight < this.#limits.concurrency) {
      state.inflight += 1;
    } else {
      const got = await new Promise<boolean>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          state.waiting = state.waiting.filter((other) => other !== waiter);
          resolve(false);
        }, waitMs);
        state.waiting.push(waiter);
      });
      if (!got) {
        this.#tidy(key, state);
        return 'busy';
      }
      // A slot was handed over by `leave`, and `inflight` already counts it.
    }
    if (this.#limits.failures > 0 && state.failed >= this.#limits.failures) {
      if (this.#now() < state.openUntil || state.probing) {
        this.#free(key, state);
        return 'open';
      }
      state.probing = true;
    }
    return {
      leave: (healthy) => {
        state.probing = false;
        state.failed = healthy ? 0 : state.failed + 1;
        if (!healthy && this.#limits.failures > 0 && state.failed >= this.#limits.failures) {
          state.openUntil = this.#now() + this.#limits.cooldownMs;
        }
        this.#free(key, state);
      },
    };
  }

  #add(key: string): State {
    const state: State = { inflight: 0, waiting: [], failed: 0, openUntil: 0, probing: false };
    this.#states.set(key, state);
    return state;
  }

  /** Gives the slot to the next one waiting, or frees it. */
  #free(key: string, state: State): void {
    const next = state.waiting.shift();
    if (next === undefined) state.inflight -= 1;
    else next();
    this.#tidy(key, state);
  }

  #tidy(key: string, state: State): void {
    if (state.inflight === 0 && state.waiting.length === 0 && state.failed === 0) {
      this.#states.delete(key);
    }
  }
}
