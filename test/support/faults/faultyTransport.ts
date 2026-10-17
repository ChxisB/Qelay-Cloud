import type {
  DeadLetterPeek,
  Delivery,
  DeliveryTransport,
  RingItem,
  RingResult,
  SubscribeOptions,
  Subscription,
  TransportCapabilities,
  TransportStats,
} from '../../../packages/core/src';
import { canPeekDeadLetters } from '../../../packages/core/src';
import { DeliveryFaults } from './deliveryFaults';
import type { FaultCounts } from './faultCounts';
import { newFaultCounts } from './faultCounts';
import type { RingFault } from './vocabulary';

export type { FaultCounts } from './faultCounts';

interface Planned {
  readonly fault: RingFault;
  readonly lateMs: number;
}

interface ItemFailure {
  readonly match: (item: RingItem) => boolean;
  readonly reason: 'rejected' | 'unreachable';
}

/**
 * Wraps any `DeliveryTransport` at the boundary and makes the broker misbehave on request: drop,
 * duplicate, delay or reorder a `ring` and a delivery, fail individual items of a batch, lose an ack.
 * Nothing is injected unless asked for, and each fault names how many calls it applies to.
 *
 * It works the same over memory, Postgres, Pub/Sub and SQS, so a fault scenario is written once. The
 * faults are real time (a late bell is a timer), which is what the contract suite and the scenarios
 * run on; the model harness, which runs on virtual time, uses the same `RingFault` words.
 */
export class FaultyTransport implements DeliveryTransport {
  readonly counts: FaultCounts = newFaultCounts();
  /**
   * Ring calls that reached the broker (`delivered`) and those made to throw (`failed`), and what a
   * subscriber was handed: every delivery (`received`) and those that carry a bell (`receivedBells`),
   * the rest being wake-ups and malformed bodies. What the scenarios assert on.
   */
  readonly calls = { delivered: 0, failed: 0, received: 0, receivedBells: 0 };
  /** Present when the wrapped transport can list its dead letters. */
  readonly peekDeadLetters?: DeadLetterPeek['peekDeadLetters'];

  readonly #inner: DeliveryTransport;
  readonly #defaultLateMs: number;
  readonly #planned: Planned[] = [];
  readonly #itemFailures: ItemFailure[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #deliveries = new DeliveryFaults(this.counts);
  #throws = 0;
  #reorderRings = 0;

  constructor(inner: DeliveryTransport, options: { readonly lateMs?: number } = {}) {
    this.#inner = inner;
    this.#defaultLateMs = options.lateMs ?? 400;
    if (canPeekDeadLetters(inner)) {
      this.peekDeadLetters = (queue, limit) => inner.peekDeadLetters(queue, limit);
    }
  }

  get inner(): DeliveryTransport {
    return this.#inner;
  }

  get capabilities(): TransportCapabilities {
    return this.#inner.capabilities;
  }

  // Ring faults ---------------------------------------------------------------------------------

  /** The next `n` `ring` calls throw, as an unreachable broker does. */
  failNext(n = 1): void {
    this.#throws += n;
  }

  /** The next ring is applied as `fault`. `late` holds the bells for `lateMs` before the broker has them. */
  inject(fault: RingFault, lateMs = this.#defaultLateMs): void {
    this.#planned.push({ fault, lateMs });
  }

  /** The next `n` rings are reported `ok` and lost. */
  dropNext(n = 1): void {
    for (let i = 0; i < n; i += 1) this.inject('drop');
  }

  /** The next `n` rings reach the broker twice. */
  duplicateNext(n = 1): void {
    for (let i = 0; i < n; i += 1) this.inject('duplicate');
  }

  /** The next `n` rings are reported `ok` at once and reach the broker `ms` later. */
  delayNext(ms: number, n = 1): void {
    for (let i = 0; i < n; i += 1) this.inject('late', ms);
  }

  /** The next `n` rings hand their items to the broker in reverse order. */
  reorderNext(n = 1): void {
    this.#reorderRings += n;
  }

  /**
   * Items for which `match` is true are not forwarded and answered with `reason`, the rest go through:
   * a batch the broker half takes. Stays until `clearFaults`.
   */
  failItems(
    match: (item: RingItem) => boolean,
    reason: 'rejected' | 'unreachable' = 'rejected'
  ): void {
    this.#itemFailures.push({ match, reason });
  }

  // Delivery faults -----------------------------------------------------------------------------

  /** The ack of the next `n` deliveries never reaches the broker: the bell comes back. */
  dropAckNext(n = 1): void {
    this.#deliveries.dropAck(n);
  }

  /** The handler gets each of the next `n` deliveries twice, one after the other. */
  duplicateDeliveryNext(n = 1): void {
    this.#deliveries.duplicate(n);
  }

  /** The handler gets each of the next `n` deliveries `ms` late. */
  delayDeliveryNext(ms: number, n = 1): void {
    this.#deliveries.delay(ms, n);
  }

  /**
   * The next `size` deliveries are held until all have arrived (or `maxWaitMs`), then handed to the
   * handler in reverse arrival order. Needs capacity for `size` at once, or it waits the full time.
   */
  reorderDeliveriesNext(size: number, maxWaitMs = 1_000): void {
    this.#deliveries.reorder(size, maxWaitMs);
  }

  clearFaults(): void {
    this.#throws = 0;
    this.#reorderRings = 0;
    this.#planned.length = 0;
    this.#itemFailures.length = 0;
    this.#deliveries.clear();
  }

  // DeliveryTransport ---------------------------------------------------------------------------

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    if (this.#throws > 0) {
      this.#throws -= 1;
      this.counts.thrown += 1;
      this.calls.failed += 1;
      throw new Error('broker unreachable (made to fail by the test)');
    }
    const plan = this.#planned.shift() ?? { fault: 'ok' as const, lateMs: 0 };
    const results: RingResult[] = items.map(() => ({ ok: true }));
    const forwarded: Array<{ item: RingItem; index: number }> = [];
    items.forEach((item, index) => {
      const failure = this.#itemFailures.find((candidate) => candidate.match(item));
      if (failure === undefined) {
        forwarded.push({ item, index });
        return;
      }
      results[index] = { ok: false, reason: failure.reason };
      this.counts.itemsFailed += 1;
    });
    if (forwarded.length === 0) return results;

    if (plan.fault === 'drop') {
      this.counts.dropped += 1;
      return results;
    }
    let batch = forwarded;
    if (this.#reorderRings > 0) {
      this.#reorderRings -= 1;
      this.counts.reordered += 1;
      batch = forwarded.toReversed();
    }
    const payload = batch.map((entry) => entry.item);
    if (plan.fault === 'late') {
      this.counts.late += 1;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        void this.#forward(payload).catch(() => {});
      }, plan.lateMs);
      this.#timers.add(timer);
      return results;
    }
    if (plan.fault === 'duplicate') {
      this.counts.duplicated += 1;
      await this.#forward(payload).catch(() => {});
    }
    const answers = await this.#forward(payload);
    batch.forEach((entry, position) => {
      results[entry.index] = answers[position] ?? { ok: false, reason: 'unreachable' };
    });
    return results;
  }

  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    options: SubscribeOptions
  ): Subscription {
    return this.#inner.subscribe(
      queue,
      (delivery) => {
        this.calls.received += 1;
        if (delivery.bell !== null) this.calls.receivedBells += 1;
        return this.#deliveries.run(delivery, handler);
      },
      options
    );
  }

  stats(queue: string): Promise<TransportStats> {
    return this.#inner.stats(queue);
  }

  /** Stops every pending late ring and held delivery, and leaves the wrapped transport open. */
  release(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#deliveries.stop();
  }

  async close(): Promise<void> {
    this.release();
    return this.#inner.close();
  }

  async #forward(items: readonly RingItem[]): Promise<RingResult[]> {
    this.counts.forwarded += 1;
    this.calls.delivered += 1;
    return this.#inner.ring(items);
  }
}
