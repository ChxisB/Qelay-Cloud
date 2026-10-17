import type { Bell } from './jobs';

/**
 * The doorbell seam. A transport only tells a worker "something is claimable"; Postgres decides
 * what runs. Settled at the Phase 0 gate (DESIGN.md section 5, `docs/spikes/06-phase0-gate.md`).
 */

export interface RingItem {
  readonly bell: Bell;
  /** Relative delay, rounded up and never down. Refused above `capabilities.maxDeliverDelayMs`. */
  readonly deliverAfterMs?: number;
}

export type RingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'delay-too-long' | 'rejected' | 'unreachable' };

export interface Delivery {
  /**
   * Null when the body is not a bell. A consumer nacks it and counts it, and does not ack it: the broker's
   * redelivery limit moves it to the dead-letter queue, where it is a metric, and an ack would delete the
   * only evidence that something foreign is writing to the queue.
   */
  readonly bell: Bell | null;
  /** The broker's delivery count, if it keeps one (`capabilities.attemptCount`). */
  readonly attempt: number | null;
  /** Acknowledge after the claim attempt, never after the job has run. Safe to call twice. */
  ack(): Promise<void>;
  /** Return the bell. `retryInMs` is a hint, rounded to `capabilities.retryGranularityMs`. */
  nack(retryInMs?: number): Promise<void>;
}

export interface TransportCapabilities {
  /** SQS 900_000, Pub/Sub 0, local unbounded (`Number.POSITIVE_INFINITY`). */
  readonly maxDeliverDelayMs: number;
  /** SQS 10, Pub/Sub 1_000. */
  readonly maxRingBatch: number;
  readonly attemptCount: 'approximate' | 'none';
  /** SQS 1_000. Retry hints are rounded up to a multiple of this. */
  readonly retryGranularityMs: number;
}

export interface TransportStats {
  /** Null means the broker does not report it. A null is never read as zero. */
  readonly depth: number | null;
  readonly inFlight: number | null;
  readonly delayed: number | null;
  readonly oldestAgeMs: number | null;
  readonly deadLetterDepth: number | null;
  /** Where the numbers came from, for example `cloud-monitoring` or `sqs-attributes`. */
  readonly source: string;
  /** Epoch milliseconds the numbers describe. */
  readonly observedAt: number;
  /** How stale the numbers can be by design. Dashboards show it. */
  readonly maxStalenessMs: number;
}

export interface Subscription {
  /** Tells the transport that capacity changed, so it can pull or stop pulling. */
  refresh(): void;
  /** Stops pulling and waits for in-flight handlers, then releases the subscription. */
  close(): Promise<void>;
}

export interface SubscribeOptions {
  /** How many deliveries the worker can take right now. Demand-driven: the transport asks. */
  readonly capacity: () => number;
}

export interface DeliveryTransport {
  readonly capabilities: TransportCapabilities;

  /**
   * Rings each item and returns one result per item, in order. A batch can half-succeed, and
   * the caller reports only the bells the broker took to `StateStore.markRung`. Ringing the same
   * bell twice is harmless: bells are fungible and a claim of nothing is a no-op. Routes by
   * `bell.queue`; one cloud queue per Qelay queue.
   */
  ring(items: readonly RingItem[]): Promise<RingResult[]>;

  /**
   * Starts delivering bells for `queue` to `handler`, at most `opts.capacity()` at a time. The
   * transport holds each bell while the handler runs and redelivers it when neither `ack` nor
   * `nack` was called. At-least-once: the handler must tolerate duplicates.
   */
  subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    opts: SubscribeOptions
  ): Subscription;

  /** Broker-side depth and age for a Qelay queue, with its freshness. */
  stats(queue: string): Promise<TransportStats>;

  close(): Promise<void>;
}

/** A doorbell the broker gave up on: it was delivered too often without being acknowledged. */
export interface DeadLetter {
  /** Null when the body is not a bell. */
  readonly bell: Bell | null;
  /** How many times the broker delivered it before it gave up, if it says. */
  readonly deliveryCount: number | null;
  /** Epoch milliseconds the broker moved it to the dead-letter queue, if it says. */
  readonly deadLetteredAt: number | null;
}

/**
 * Optional: a transport that has a doorbell dead-letter queue can show what is in it without
 * consuming it. The Control API's poison-doorbell panel is read-only, so a peek must leave every
 * bell where it is (a bell the broker holds back for a moment is returned at once). Redrive is not
 * part of this: it is a runbook step.
 */
export interface DeadLetterPeek {
  /** At most `limit` dead-lettered bells of a Qelay queue, oldest first where the broker keeps an order. */
  peekDeadLetters(queue: string, limit: number): Promise<DeadLetter[]>;
}

export const canPeekDeadLetters = (
  transport: DeliveryTransport
): transport is DeliveryTransport & DeadLetterPeek =>
  typeof (transport as Partial<DeadLetterPeek>).peekDeadLetters === 'function';

/**
 * What a transport with a dead-letter queue may add to its stats: the age of the oldest bell in it.
 * It is separate from `TransportStats` so the settled shape stays as it is; a transport that has
 * nothing to add leaves it out, and `deadLetterOldestAgeMs` reads that as null (unknown), never zero.
 */
export interface DeadLetterAge {
  readonly deadLetterOldestAgeMs?: number | null;
}

export const deadLetterOldestAgeMs = (stats: TransportStats): number | null =>
  (stats as TransportStats & DeadLetterAge).deadLetterOldestAgeMs ?? null;
