import type { RingFault } from '../support/faults/vocabulary';
import type { Clock, Doorbell } from './store';

// One vocabulary for the model and for `FaultyTransport`, so the same fault means the same thing in both.
export type { RingFault } from '../support/faults/vocabulary';
export { RING_FAULTS } from '../support/faults/vocabulary';

/** Virtual time owned by the harness. It only moves forward, and only when a command moves it. */
export class VirtualClock implements Clock {
  #now: number;

  constructor(start = 1_800_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    if (!(ms >= 0)) throw new Error(`clock cannot move by ${ms} ms`);
    this.#now += ms;
  }

  advanceTo(time: number): void {
    if (time > this.#now) this.#now = time;
  }
}

/**
 * In-memory doorbell transport with injected faults, shaped like Pub/Sub: no per-message delay
 * (`maxDeliverDelayMs: 0`, so the tick rings delayed jobs) and no ordering guarantee (a delivery
 * may take any pending doorbell). A late doorbell is held until `flushLate`.
 */
export class FaultyDoorbells {
  #pending: Doorbell[] = [];
  #late: Doorbell[] = [];

  ring(bells: readonly Doorbell[], fault: RingFault): void {
    for (const bell of bells) {
      if (fault === 'ok') this.#pending.push(bell);
      else if (fault === 'duplicate') this.#pending.push(bell, bell);
      else if (fault === 'late') this.#late.push(bell);
    }
  }

  /** Removes and returns one pending doorbell, chosen by `pick`, or undefined if none is pending. */
  take(pick: number): Doorbell | undefined {
    if (this.#pending.length === 0) return undefined;
    return this.#pending.splice(pick % this.#pending.length, 1)[0];
  }

  /** Delivers every late doorbell: they become pending. */
  flushLate(): number {
    const count = this.#late.length;
    this.#pending.push(...this.#late);
    this.#late = [];
    return count;
  }

  /** Pending doorbells for `queue`. Late doorbells do not count: they may never arrive in time. */
  deliverable(queue: string): number {
    return this.#pending.filter((bell) => bell.queue === queue).length;
  }

  describe(): string {
    const list = (bells: Doorbell[]) => bells.map((bell) => bell.jobId ?? bell.queue).join(' ');
    return `pending [${list(this.#pending)}] late [${list(this.#late)}]`;
  }
}
