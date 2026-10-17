import { describe, expect, test } from 'bun:test';
import type {
  Bell,
  Clock,
  Delivery,
  DeliveryTransport,
  Ring,
  RingItem,
  RingResult,
  RungEntry,
  StateStore,
  TransportCapabilities,
  TransportStats,
} from './index';

/**
 * Type-level checks that the interfaces match the shapes settled at the Phase 0 gate
 * (DESIGN.md section 5). Each assertion fails `tsc`, not just the test, if a shape drifts.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | undefined {
  return undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

assertType<Equals<Mutable<Bell>, { namespace: string; queue: string; jobId?: string }>>();
assertType<Equals<Mutable<RingItem>, { bell: Bell; deliverAfterMs?: number }>>();
assertType<Equals<Mutable<Ring>, { bell: Bell; dueInMs: number }>>();
assertType<Equals<Mutable<RungEntry>, { jobId: string; deliverAfterMs: number }>>();
assertType<Equals<Clock, { now(): number }>>();
assertType<
  Equals<
    RingResult,
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: 'delay-too-long' | 'rejected' | 'unreachable' }
  >
>();
assertType<
  Equals<
    Mutable<TransportCapabilities>,
    {
      maxDeliverDelayMs: number;
      maxRingBatch: number;
      attemptCount: 'approximate' | 'none';
      retryGranularityMs: number;
    }
  >
>();
assertType<
  Equals<
    Delivery,
    {
      readonly bell: Bell | null;
      readonly attempt: number | null;
      ack(): Promise<void>;
      nack(retryInMs?: number): Promise<void>;
    }
  >
>();
assertType<
  Equals<
    Mutable<TransportStats>,
    {
      depth: number | null;
      inFlight: number | null;
      delayed: number | null;
      oldestAgeMs: number | null;
      deadLetterDepth: number | null;
      source: string;
      observedAt: number;
      maxStalenessMs: number;
    }
  >
>();

/** The sketch gives `ring` one result per item and `subscribe` a demand-driven capacity. */
type Subscribe = DeliveryTransport['subscribe'];
assertType<Equals<Parameters<Subscribe>[2], { readonly capacity: () => number }>>();
assertType<Equals<ReturnType<DeliveryTransport['ring']>, Promise<RingResult[]>>>();
assertType<Equals<Parameters<StateStore['markRung']>[0], readonly RungEntry[]>>();

/** `StateStore` takes no `now` anywhere and `tick` takes a budget. */
type TakesNow = {
  [K in keyof StateStore]: Parameters<StateStore[K]> extends readonly [
    ...unknown[],
    { now: number },
  ]
    ? K
    : never;
}[keyof StateStore];
assertType<Equals<TakesNow, never>>();

describe('interfaces', () => {
  test('the type-level assertions above compiled', () => {
    expect(true).toBe(true);
  });

  test('a minimal transport and store satisfy the interfaces', () => {
    const transport: DeliveryTransport = {
      capabilities: {
        maxDeliverDelayMs: 0,
        maxRingBatch: 1_000,
        attemptCount: 'none',
        retryGranularityMs: 1,
      },
      ring: async (items) => items.map(() => ({ ok: true as const })),
      subscribe: () => ({ refresh() {}, close: async () => {} }),
      stats: async () => ({
        depth: null,
        inFlight: null,
        delayed: null,
        oldestAgeMs: null,
        deadLetterDepth: null,
        source: 'test',
        observedAt: 0,
        maxStalenessMs: 0,
      }),
      close: async () => {},
    };
    expect(transport.capabilities.maxRingBatch).toBe(1_000);
  });
});
