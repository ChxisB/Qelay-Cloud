import type { Codec, IdGenerator } from '@qelay-cloud/core';
import { parseSealKey } from '@qelay-cloud/core';
import { createMsgpackCodec } from '../codec';
import type { Database } from '../connection/connect';
import { ConnectionConfigError } from '../errors';
import { createUuidV7 } from '../ids';
import type { Random } from './backoff';
import { NO_JITTER } from './backoff';
import type { StoreContext, TerminalHook } from './context';
import type { EventRecorder } from './events';
import { flowTerminalHook } from './flowTerminal';
import { journalRecorder } from './journal';
import { requestedLeaseMs } from './leaseRules';
import { MAX_PAYLOAD_DEPTH, MAX_PAYLOAD_NODES } from './payloadShape';
import { MAX_BATCH, MAX_PAYLOAD_BYTES } from './prepare';
import { requestedRingCoverMs } from './ringCover';
import type { StoreSettingsOptions } from './settings';
import { resolveSettings } from './settings';

export interface PostgresStoreOptions extends StoreSettingsOptions {
  /** The store owns it: `close` closes it. Open one per store, with `openDatabase`. */
  readonly db: Database;
  /** The tenant of every row. Several namespaces share one schema without seeing each other. */
  readonly namespace: string;
  /**
   * The longest delay the transport can hold a bell for, from its `maxDeliverDelayMs`. A delayed
   * job whose delay fits is returned with a ring; any other is rung by the tick nearer its time.
   * Default 0: only claimable jobs are rung.
   */
  readonly ringWindowMs?: number;
  /**
   * Enqueue rings a queue at most once per this many ms while it has a claimable job that was rung
   * inside the window: the other new jobs are recorded as rung and get no bell. A worker claims a
   * batch and claims again while the queue has more, so the one bell wakes it; the tick's re-ring
   * finds what it missed. It saves a publish and a `markRung` write per job under a standing
   * backlog. Use it when every consumer is this package's worker (an older worker claims once per
   * bell and would wait for the re-ring). Default 0: every claimable job is rung.
   */
  readonly ringCoverMs?: number;
  readonly codec?: Codec;
  /** Overrides the UUIDv7 generator. Tests and the model harness inject one to replay ids. */
  readonly ids?: IdGenerator;
  /** Receives the events of each operation inside its transaction. Default: the journal (`store.events`). */
  readonly recorder?: EventRecorder;
  readonly maxPayloadBytes?: number;
  /** Values and object keys one payload or result may hold once decoded. Default 20,000. */
  readonly maxPayloadNodes?: number;
  /** Deepest nesting of a payload or result. Default 64. */
  readonly maxPayloadDepth?: number;
  /** How long a lease lasts from a claim or a heartbeat. A job's own timeouts can shorten it. Default 30,000. */
  readonly leaseMs?: number;
  /**
   * Randomises a retry delay by up to plus or minus 20% (fixed backoff) or 50% (exponential), as
   * upstream always does. Off by default: the delay is then exactly the documented formula.
   */
  readonly jitter?: boolean;
  /** The jitter's randomness, a number in [0, 1). The model harness injects a seeded one. Default `Math.random`. */
  readonly random?: Random;
  /**
   * Runs inside the transaction of every job that completes or fails for good. The default settles flow
   * parents (`flowTerminal.ts`); a harness may replace it.
   */
  readonly onTerminal?: TerminalHook;
  /**
   * Seals webhook secrets (AES-256-GCM): 32 bytes, or the text `parseSealKey` takes (64 hex digits or
   * base64). The database never holds it. Without one a webhook can only be unsigned, and a sealed
   * secret already stored cannot be opened, so its deliveries fail instead of going out unsigned.
   */
  readonly webhookKey?: Uint8Array | string;
}

/** Upstream's default lock TTL. */
export const DEFAULT_LEASE_MS = 30_000;

/** What every store operation runs against: the options with their defaults filled in. */
export function createStoreContext(options: PostgresStoreOptions): StoreContext {
  if (options.namespace === '' || options.namespace.includes('\0')) {
    throw new ConnectionConfigError('namespace must be a non-empty string without NUL');
  }
  const ids = options.ids;
  const uuid = createUuidV7();
  const codec = options.codec ?? createMsgpackCodec();
  const ctx: StoreContext = {
    db: options.db,
    namespace: options.namespace,
    codec,
    nextId: ids ? () => ids.next() : (now) => uuid.next(now),
    recorder: options.recorder ?? journalRecorder({ namespace: options.namespace, codec }),
    ringWindowMs: Math.max(0, options.ringWindowMs ?? 0),
    ringCoverMs: requestedRingCoverMs(options.ringCoverMs),
    limits: {
      maxBatch: MAX_BATCH,
      maxPayloadBytes: options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES,
      maxPayloadNodes: options.maxPayloadNodes ?? MAX_PAYLOAD_NODES,
      maxPayloadDepth: options.maxPayloadDepth ?? MAX_PAYLOAD_DEPTH,
    },
    leaseMs: requestedLeaseMs(options.leaseMs, DEFAULT_LEASE_MS),
    backoff: {
      jitter: options.jitter ?? NO_JITTER.jitter,
      random: options.random ?? NO_JITTER.random,
    },
    onTerminal: options.onTerminal ?? flowTerminalHook(() => ctx),
    webhookKey:
      typeof options.webhookKey === 'string'
        ? parseSealKey(options.webhookKey, 'webhookKey')
        : (options.webhookKey ?? null),
    ...resolveSettings(options),
  };
  return ctx;
}
