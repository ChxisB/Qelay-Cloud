import type { CheckState, SchemaState } from './types';

export type { SchemaState };

/**
 * The JSON of `GET /transport`, `GET /transport/dead-letters` and `GET /deployment`: the pages that
 * say whether the doorbell path and the deployment are healthy. Two rules hold throughout:
 *
 * - **null is "unknown", never zero.** A number the service could not read is null, and the panel
 *   shows it as unknown. A count of zero means the thing was read and there was none.
 * - **Every figure that comes from a broker or a metrics service says how old it is** (`freshness`),
 *   because cloud queue metrics lag by minutes and must not be read as real time.
 *
 * Nothing here is a secret: no connection string, token or credential is ever part of a response.
 */

/** How old a reading is, and where it came from. */
export interface Freshness {
  /** Epoch ms the numbers describe, or null when they could not be read. */
  readonly observedAt: number | null;
  /** Milliseconds between `observedAt` and this response; null with `observedAt`. */
  readonly ageMs: number | null;
  /** The most the numbers can lag by design (a metrics pipeline's delay). 0 when they are exact. */
  readonly maxStalenessMs: number;
  /** For example `cloud-monitoring`, `postgres-counts`, `memory`, `unavailable`. */
  readonly source: string;
}

/** One queue as the store sees it, to be read against the broker's numbers for the same queue. */
export interface DoorbellHealthRow {
  readonly queue: string;
  /** Jobs a worker could claim now. Counted up to `countCap`. */
  readonly claimable: number;
  /** Claimable jobs with no bell on record, past the enqueue grace: waiting for the tick. */
  readonly notRung: number;
  /** Claimable jobs whose last bell is old enough that the tick rings them again. */
  readonly reRingDue: number;
  readonly oldestNotRungAgeMs: number | null;
  readonly paused: boolean;
  /** Outside its run window: the tick does not ring it, and its jobs are held on purpose. */
  readonly windowClosed: boolean;
  /** A count stopped at the cap: read it as "this many or more". */
  readonly capped: boolean;
}

/** One queue as the broker reports it. */
export interface TransportQueueStats {
  readonly queue: string;
  /** Bells waiting at the broker. */
  readonly doorbellDepth: number | null;
  /** Bells taken and not yet acknowledged. Null where the broker does not count them. */
  readonly inFlight: number | null;
  /** Bells held back for a later time. Null where the broker does not count them. */
  readonly delayed: number | null;
  /** Age of the oldest bell nobody has taken. */
  readonly oldestUndeliveredAgeMs: number | null;
  /**
   * Bells in the broker's dead-letter queue. Null on a transport that has none (see
   * `TransportResponse.deadLetter.supported`) as well as when it could not be read.
   */
  readonly deadLetterDepth: number | null;
  readonly deadLetterOldestAgeMs: number | null;
  /** The broker's numbers are no fresher than this. */
  readonly freshness: Freshness;
  /** The store's side of the same queue, from the database's clock: how many of its jobs await a bell. */
  readonly store: DoorbellHealthRow;
}

export interface TransportResponse {
  readonly ok: true;
  readonly transport: {
    readonly name: string;
    readonly maxDeliverDelayMs: number | null;
    readonly ordering: 'none' | 'best-effort';
    /** The broker documents its counts as approximate (SQS): show them as estimates. */
    readonly approximateCounts: boolean;
  };
  /** Whether the broker has a dead-letter queue of bells. The local transports do not. */
  readonly deadLetter: { readonly supported: boolean };
  /** Queues with pending jobs first, then the rest by name, at most the configured cap. */
  readonly queues: readonly TransportQueueStats[];
  /** More queues exist than this response covers. */
  readonly truncated: boolean;
  readonly timestamp: number;
}

export interface DeadLetterItem {
  /** The job the poison bell rang for, or null when the bell could not be decoded. */
  readonly jobId: string | null;
  readonly queue: string;
  /** How often the broker delivered it before giving up; null when it did not say. */
  readonly deliveryCount: number | null;
  readonly deadLetteredAt: number | null;
  readonly ageMs: number | null;
  /** The job still exists, so the job inspector can open it. */
  readonly jobExists: boolean;
}

/**
 * `GET /transport/dead-letters?queue=`: a sample of the poison bells of one queue, read without being
 * consumed. `available` false says why in `reason`, and then `items` is empty and means nothing.
 */
export interface DeadLettersResponse {
  readonly ok: true;
  readonly queue: string;
  readonly available: boolean;
  readonly reason: 'not_supported' | 'unreachable' | null;
  readonly items: readonly DeadLetterItem[];
  readonly timestamp: number;
}

export type TickState = 'ok' | 'late' | 'stale' | 'never' | 'unknown';
export type WarningSeverity = 'warning' | 'critical';

export interface DeploymentWarning {
  /** Stable: the panel and alerts branch on it. */
  readonly code: string;
  readonly severity: WarningSeverity;
  readonly message: string;
}

export interface DeploymentResponse {
  readonly ok: true;
  readonly version: string;
  /** The commit this build came from, as the deployer declared it. */
  readonly commit: string | null;
  readonly production: boolean;
  /** Whether the static development token is enabled (never its value). */
  readonly devToken: boolean;
  readonly schema: {
    /** The highest migration the database records. */
    readonly current: number | null;
    /** The highest migration this build knows. */
    readonly expected: number;
    readonly state: SchemaState;
  };
  readonly database: {
    readonly state: CheckState;
    /** Round trip of a trivial query, ms. */
    readonly latencyMs: number | null;
  };
  readonly transport: { readonly name: string; readonly state: CheckState };
  readonly connections: {
    readonly inUse: number | null;
    readonly maxConnections: number | null;
    /**
     * What the declared fleet needs of the database (`budget()` of task 05), or null when the
     * deployer did not declare a fleet. `mode` says whether it counts a pooler.
     */
    readonly needed: number | null;
    readonly mode: 'direct' | 'pooled' | null;
  };
  readonly tick: {
    readonly state: TickState;
    readonly lastSuccessAt: number | null;
    readonly lastFailureAt: number | null;
    readonly ageMs: number | null;
    /** The age at which the tick is "late" (amber) and "stale" (red). */
    readonly lateAfterMs: number;
    readonly staleAfterMs: number;
  };
  readonly workers: {
    readonly total: number | null;
    readonly active: number | null;
  };
  readonly doorbells: {
    /** Claimable jobs with no bell, summed over the queues scanned; null when not read. */
    readonly notRung: number | null;
    readonly oldestNotRungAgeMs: number | null;
    readonly queuesScanned: number | null;
    /** More queues have pending jobs than were scanned, or a count stopped at its cap. */
    readonly partial: boolean;
  };
  readonly warnings: readonly DeploymentWarning[];
  readonly timestamp: number;
}
