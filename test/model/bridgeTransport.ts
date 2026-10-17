import type {
  Delivery,
  DeliveryTransport,
  RingItem,
  RingResult,
  TransportStats,
} from '@qelay-cloud/core';
import type { Doorbell } from './store';
import type { WorkerBridge } from './workers';
import { MAX_DELIVER_DELAY_MS } from './world';

/** What a bell sent to a worker ended as. */
export type BellEnd = 'ack' | 'nack';

/**
 * The transport of one bridged worker. The harness hands it the bells (`deliver`), as a broker
 * would, and rings that the worker makes land in the harness's `FaultyDoorbells`. It offers more
 * bells than the worker has slots on purpose: the worker must nack what it has no room for.
 */
export class BridgeTransport implements DeliveryTransport {
  readonly capabilities = {
    maxDeliverDelayMs: MAX_DELIVER_DELAY_MS,
    maxRingBatch: 1_000,
    attemptCount: 'none',
    retryGranularityMs: 1,
  } as const;
  #handler: ((delivery: Delivery) => Promise<void>) | null = null;

  constructor(private readonly bridge: WorkerBridge) {}

  async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    return this.bridge.ring(items);
  }

  subscribe(_queue: string, handler: (delivery: Delivery) => Promise<void>) {
    this.#handler = handler;
    return {
      refresh: () => {},
      close: async () => {
        this.#handler = null;
      },
    };
  }

  async stats(): Promise<TransportStats> {
    return {
      depth: null,
      inFlight: null,
      delayed: null,
      oldestAgeMs: null,
      deadLetterDepth: null,
      source: 'model-harness',
      observedAt: 0,
      maxStalenessMs: 0,
    };
  }

  async close(): Promise<void> {}

  /** Hands one bell to the worker and says whether it was acknowledged or returned. */
  async deliver(bell: Doorbell): Promise<BellEnd> {
    const handler = this.#handler;
    if (handler === null) return 'nack';
    let end: BellEnd = 'nack';
    const delivery: Delivery = {
      bell,
      attempt: null,
      ack: async () => {
        end = 'ack';
      },
      nack: async () => {
        end = 'nack';
      },
    };
    await handler(delivery);
    return end;
  }
}
