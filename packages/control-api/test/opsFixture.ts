import type {
  DeadLetter,
  DeadLetterPeek,
  DeliveryTransport,
  RingItem,
  TransportCapabilities,
  TransportStats,
} from '@qelay-cloud/core';
import { DEV_TOKEN } from './support';

export const CAPABILITIES: TransportCapabilities = {
  maxDeliverDelayMs: 0,
  maxRingBatch: 10,
  attemptCount: 'approximate',
  retryGranularityMs: 1_000,
};

export interface StubTransport extends DeliveryTransport, Partial<DeadLetterPeek> {
  /** What `stats` answers for each queue; a function throws to model a broker that is down. */
  answer: (queue: string) => TransportStats | Promise<TransportStats>;
  readonly statsCalls: string[];
  readonly peeks: Array<{ queue: string; limit: number }>;
}

/** A transport whose numbers a test sets. It rings nothing and never delivers. */
export function stubTransport(
  answer: StubTransport['answer'],
  options: { peek?: (queue: string, limit: number) => Promise<DeadLetter[]> } = {}
): StubTransport {
  const stub: StubTransport = {
    capabilities: CAPABILITIES,
    answer,
    statsCalls: [],
    peeks: [],
    ring: async (items: readonly RingItem[]) => items.map(() => ({ ok: true as const })),
    subscribe: () => ({ refresh() {}, close: async () => {} }),
    stats: async (queue) => {
      stub.statsCalls.push(queue);
      return stub.answer(queue);
    },
    close: async () => {},
  };
  const { peek } = options;
  if (peek !== undefined) {
    stub.peekDeadLetters = async (queue, limit) => {
      stub.peeks.push({ queue, limit });
      return peek(queue, limit);
    };
  }
  return stub;
}

export const reading = (now: number, extra: Partial<TransportStats> = {}): TransportStats => ({
  depth: 5,
  inFlight: null,
  delayed: 0,
  oldestAgeMs: 12_000,
  deadLetterDepth: 2,
  source: 'cloud-monitoring',
  observedAt: now - 120_000,
  maxStalenessMs: 330_000,
  ...extra,
});

export const NOTHING: Pick<
  TransportStats,
  'depth' | 'inFlight' | 'delayed' | 'oldestAgeMs' | 'deadLetterDepth'
> = { depth: null, inFlight: null, delayed: null, oldestAgeMs: null, deadLetterDepth: null };

/** Every string in a JSON value, keys included, for a search for something that must not be there. */
export function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      strings(item, into);
    }
  }
  return into;
}

export const SECRETS = [DEV_TOKEN, 'postgres://', 'password', 'secret'];
