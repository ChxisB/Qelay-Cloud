import type { Bell, DeliveryTransport } from '@qelay-cloud/core';

/** Behaviours a broker may not have at all; a harness that lacks one says why, and the suite skips it. */
export type OptionalBehaviour = 'poison' | 'outage';

/** A network failure between a transport and its broker, for the "reconnect" test. */
export interface Outage {
  /** Cuts every connection and refuses new ones. */
  sever(): void | Promise<void>;
  /** The broker is reachable again. */
  restore(): void | Promise<void>;
}

export interface TransportHarness {
  readonly transport: DeliveryTransport;
  /** How long a bell that was neither acked nor nacked can take to come back. */
  readonly redeliveryAfterMs: number;
  /** Moves time forward (a manual clock, or a real sleep), then lets due bells deliver. */
  advance(ms: number): Promise<void>;
  /** Gives the transport the time it needs to deliver everything deliverable right now. */
  settle(): Promise<void>;
  /**
   * For a transport whose `stats` read a store, not its own bells: puts `count` claimable jobs of
   * the queue where `stats` looks. Without it the suite rings bells and expects them counted.
   */
  backlog?(queue: string, count: number): Promise<void>;
  /**
   * Puts a body that is not a bell into the queue, straight at the broker, the way a stray publisher or
   * a bug would. Present when the broker has somewhere to put what nobody can handle.
   */
  poison?(queue: string): Promise<void>;
  /** The longest a bell that is nacked every time takes to reach the dead-letter queue. */
  readonly deadLetterAfterMs?: number;
  /** Present when the transport talks to its broker over a network that the harness can cut. */
  readonly outage?: Outage;
  close(): Promise<void>;
}

export type HarnessFactory = () => Promise<TransportHarness>;

export function bell(queue: string, jobId: string): Bell {
  return { namespace: 'contract', queue, jobId };
}

export interface ContractOptions {
  /**
   * Per-test timeout in ms. Bun's default is 5 s, which a transport that has to wait for a real
   * redelivery (the Pub/Sub emulator) can reach on a cold start: a test that times out keeps
   * running and tears down the environment under the next one.
   */
  readonly timeoutMs?: number;
  /**
   * Behaviours this transport has no broker for, and why. A skipped test says the reason in its title,
   * and `docs/transports.md` lists it, so a gap is read in the matrix rather than found by its absence.
   */
  readonly skips?: Partial<Record<OptionalBehaviour, string>>;
}
