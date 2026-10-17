import type { Delivery } from '../../../packages/core/src';
import type { FaultCounts } from './faultCounts';

type Handler = (delivery: Delivery) => Promise<void>;

interface Held {
  readonly delivery: Delivery;
  readonly handler: Handler;
  readonly done: { resolve(): void; reject(error: unknown): void };
}

interface Group {
  readonly size: number;
  readonly held: Held[];
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The delivery side of `FaultyTransport`: what happens between the broker handing a bell over and the
 * worker's handler seeing it. Each fault is a count of the next deliveries it applies to.
 */
export class DeliveryFaults {
  #dropAcks = 0;
  #duplicates = 0;
  #delays: number[] = [];
  #reorderSize = 0;
  #reorderMaxWaitMs = 1_000;
  #group: Group | null = null;

  constructor(private readonly counts: FaultCounts) {}

  dropAck(n: number): void {
    this.#dropAcks += n;
  }

  duplicate(n: number): void {
    this.#duplicates += n;
  }

  delay(ms: number, n: number): void {
    for (let i = 0; i < n; i += 1) this.#delays.push(ms);
  }

  reorder(size: number, maxWaitMs: number): void {
    this.#reorderSize = size;
    this.#reorderMaxWaitMs = maxWaitMs;
  }

  clear(): void {
    this.#dropAcks = 0;
    this.#duplicates = 0;
    this.#delays = [];
    this.#reorderSize = 0;
  }

  stop(): void {
    if (this.#group) clearTimeout(this.#group.timer);
    this.#group = null;
  }

  async run(original: Delivery, handler: Handler): Promise<void> {
    let delivery = original;
    if (this.#dropAcks > 0) {
      this.#dropAcks -= 1;
      // The handler believes it acknowledged; the broker never heard, so the bell comes back.
      delivery = {
        bell: original.bell,
        attempt: original.attempt,
        nack: (retryInMs) => original.nack(retryInMs),
        ack: async () => {
          this.counts.acksDropped += 1;
        },
      };
    }
    const delay = this.#delays.shift();
    if (delay !== undefined) {
      this.counts.deliveriesDelayed += 1;
      await Bun.sleep(delay);
    }
    if (this.#reorderSize > 0 || this.#group !== null) return this.#hold(delivery, handler);
    await handler(delivery);
    if (this.#duplicates > 0) {
      this.#duplicates -= 1;
      this.counts.deliveriesDuplicated += 1;
      await handler(delivery);
    }
  }

  /** Collects deliveries until the group is complete, then runs them back to front. */
  #hold(delivery: Delivery, handler: Handler): Promise<void> {
    if (this.#group === null) {
      const size = this.#reorderSize;
      this.#reorderSize = 0;
      this.#group = {
        size,
        held: [],
        timer: setTimeout(() => this.#release(), this.#reorderMaxWaitMs),
      };
    }
    const group = this.#group;
    return new Promise<void>((resolve, reject) => {
      group.held.push({ delivery, handler, done: { resolve, reject } });
      if (group.held.length >= group.size) this.#release();
    });
  }

  #release(): void {
    const group = this.#group;
    if (group === null) return;
    this.#group = null;
    clearTimeout(group.timer);
    if (group.held.length > 1) this.counts.deliveriesReordered += group.held.length;
    for (const held of group.held.toReversed()) {
      held.handler(held.delivery).then(held.done.resolve, held.done.reject);
    }
  }
}
