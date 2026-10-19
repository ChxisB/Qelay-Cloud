/**
 * Job vocabulary shared by the store, the transports, the SDK and the Control API.
 * No I/O and no runtime dependencies live in this package.
 */

export type JobState =
  | 'waiting'
  | 'prioritized'
  | 'delayed'
  | 'waiting-children'
  | 'active'
  | 'completed'
  | 'failed';

export const JOB_STATES: readonly JobState[] = [
  'waiting',
  'prioritized',
  'delayed',
  'waiting-children',
  'active',
  'completed',
  'failed',
];

/** A doorbell. `jobId` is a hint and never a claim: bells are fungible. */
export interface Bell {
  readonly namespace: string;
  readonly queue: string;
  readonly jobId?: string;
}

/**
 * A bell the caller should ring. `dueInMs` is measured on the database clock at the call that
 * returned it (0 when due now), so no absolute time crosses the store and transport boundary.
 */
export interface Ring {
  readonly bell: Bell;
  readonly dueInMs: number;
}

/** What the caller reports back after ringing one bell: the broker took it, to deliver after this delay. */
export interface RungEntry {
  readonly jobId: string;
  readonly deliverAfterMs: number;
}

/** Upstream's `BackoffOptions` (`../qelay/src/client/types/options.ts`). */
export interface BackoffOptions {
  readonly type: 'fixed' | 'exponential';
  readonly delay: number;
  /** Upper bound for one retry delay in ms (0 to 86,400,000). Defaults to 1 hour. */
  readonly maxDelay?: number;
}

export interface DeduplicationOptions {
  readonly id: string;
  /** Milliseconds the key stays reserved. No expiry when unset. */
  readonly ttl?: number;
  /** Reset the TTL on a duplicate instead of rejecting it. */
  readonly extend?: boolean;
  /** Replace the live job's data on a duplicate instead of rejecting it. */
  readonly replace?: boolean;
}

export interface GroupJobOptions {
  readonly id: string | number;
  /** Maximum number of pending jobs admitted for this group. */
  readonly maxSize?: number;
  /** Intra-group priority from 0 to 2,097,151; lower values run first. */
  readonly priority?: number;
}

/**
 * Job options in the supported subset of Qelay's `JobOptions` (D6), under upstream's names.
 * Anything else is refused by `validateJobOptions` with `UnsupportedOptionError`.
 */
export interface JobOptions {
  /** Higher runs first. 0 means unprioritized. */
  readonly priority?: number;
  /** Newest first at equal priority. */
  readonly lifo?: boolean;
  /** Milliseconds before the job is ready (at most 365 days); a negative delay is treated as 0. */
  readonly delay?: number;
  /** Total tries including the first. Default 1. */
  readonly attempts?: number;
  readonly backoff?: number | BackoffOptions;
  /** Milliseconds a handler may run before the lease is treated as lost. */
  readonly timeout?: number;
  /** Milliseconds without a heartbeat before the job counts as stalled. */
  readonly stallTimeout?: number;
  /** Custom job id. A live job with this id deduplicates; a finished one is replaced. */
  readonly jobId?: string;
  readonly deduplication?: DeduplicationOptions;
  readonly group?: GroupJobOptions;
  /** Age and count retention are unsupported upstream too. */
  readonly removeOnComplete?: boolean;
  readonly removeOnFail?: boolean;
}

export interface NewJob {
  readonly queue: string;
  /** Opaque to the store: encoded by the codec and returned as given. */
  readonly data: unknown;
  readonly name?: string;
  readonly options?: JobOptions;
  /**
   * A W3C `traceparent` of the span that added the job (at most 256 characters). The store keeps it
   * with the job and returns it on every claim; it reads nothing from it. Set by the SDK when
   * tracing is on, never by an operator.
   */
  readonly trace?: string;
}

export interface EnqueuedJob {
  readonly id: string;
  /** False when a live job with the same custom id or dedup key was returned instead. */
  readonly created: boolean;
  readonly state: JobState;
  /**
   * Present when the job is claimable now or inside the delay window. The caller rings it. Absent for a job
   * that the store's `ringCoverMs` records as rung by a recent bell of its queue.
   */
  readonly ring: Ring | null;
}

/** Proof of holding a job. A write with a stale token is refused, never applied. */
export interface Lease {
  readonly jobId: string;
  readonly token: string;
  readonly owner: string;
}

/**
 * Defaults a claim applies to the queue's groups. A group's own override (its pause, concurrency
 * or rate limit in `qcloud_group_state`) wins over these.
 */
export interface GroupPullOptions {
  /** Most jobs of one group that may be active at once. */
  readonly concurrency?: number;
  /** Most jobs of one group that may be claimed in each window of `duration` ms. */
  readonly limit?: { readonly max: number; readonly duration: number };
  /** A group id: claim only that group. `null`: claim no grouped job. Unset: claim any. */
  readonly affinity?: string | null;
}

export interface ClaimOptions {
  /** Lease length in ms. Default: the store's. The job's stall and processing timeouts can shorten it. */
  readonly leaseMs?: number;
  readonly group?: GroupPullOptions;
}

/** A fixed-window rate limit on claims from one queue. */
export interface RateLimit {
  readonly max: number;
  /** Window length in ms. Default 1,000. */
  readonly durationMs?: number;
  /** The limit lifts itself this many ms after it is set. Default: it stays until changed. */
  readonly ttlMs?: number;
}

export interface ClaimedJob {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
  /** Tries counted so far. A claim does not count one. */
  readonly attempts: number;
  readonly lease: Lease;
  /** Database clock, epoch milliseconds. */
  readonly leaseUntil: number;
  /** The `traceparent` the job was added with, if tracing was on then. */
  readonly trace?: string;
}

export interface JobRecord {
  readonly id: string;
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
  readonly state: JobState;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: number;
  readonly createdAt: number;
  /** Set while the job is active. */
  readonly lease: { readonly owner: string; readonly until: number } | null;
}

export interface DlqEntry {
  readonly jobId: string;
  readonly queue: string;
  readonly attempts: number;
  readonly failedAt: number;
  readonly reason: string;
}

export interface FailureInfo {
  readonly message: string;
  readonly stack?: string;
  /** Skip the remaining attempts and go straight to the DLQ. */
  readonly unrecoverable: boolean;
}

/** Result of a lease-guarded write. `ok: false` means the lease was lost and nothing changed. */
export interface Outcome {
  readonly ok: boolean;
  readonly rings: readonly Ring[];
}

export interface TickBudget {
  /** Wall-clock budget for the whole tick. */
  readonly maxDurationMs: number;
  /** Cap on re-rings per queue, so a backlog does not ring once per job on every tick. */
  readonly maxRingsPerQueue: number;
  /**
   * Cap on the re-rings of jobs that already had a bell, per queue, apart from the first rings of
   * jobs that never had one. A worker claims again while a queue has more, so a standing backlog
   * needs a bell or two per interval, not `maxRingsPerQueue`. Default: `maxRingsPerQueue`.
   */
  readonly maxStaleRingsPerQueue?: number;
  /** Cap on the work done in one pass: recovered jobs, promoted jobs, cron firings. */
  readonly maxItems: number;
  /**
   * Skip the retention steps (DLQ, workers, webhook deliveries, events, completions, metric
   * buckets). A loop that ticks every second sets it between upkeep rounds: those steps free
   * space, so they gain nothing from running each second. Recovery, crons, promotion, expiry and
   * the ring query always run. Default false.
   */
  readonly skipUpkeep?: boolean;
  /**
   * A claimable job whose last bell is at least this old is rung again. Must not exceed the tick
   * interval, or a lost bell is found later than the documented bound. The store cannot check it
   * against an interval it does not know, so the tick's configuration does. Default 5,000.
   */
  readonly reRingAfterMs?: number;
  /** A job created this recently with no bell yet is left alone: its publish may be in flight. Default 2,000. */
  readonly ringGraceMs?: number;
  /**
   * How far ahead a delayed job is rung, clamped to the transport's window (the store's
   * `ringWindowMs`). At least one tick interval plus the worst tick lateness, or a job due between
   * two ticks is rung late. Default: the transport's window.
   */
  readonly ringWindowMs?: number;
}

export interface TickReport {
  readonly recovered: number;
  readonly promoted: number;
  readonly cronFired: number;
  readonly expired: number;
  readonly rings: readonly Ring[];
  /** True when a cap stopped the pass early and another tick would find more to do. */
  readonly moreWork: boolean;
  /**
   * Milliseconds each step of the pass took, by step name (`recover`, `crons`, `promote`, `expire`,
   * `retention`, `events`, `completions`, `ringQuery`). A step that was skipped is absent. For telemetry.
   */
  readonly stepMs?: Readonly<Record<string, number>>;
}

export type StateCounts = Readonly<Record<JobState, number>>;

/**
 * What an operator action may be fenced by. `expectedVersion` is the job's `version` as the caller
 * read it; when the job has moved on, the action throws `JobVersionError` and changes nothing. A
 * claim, a heartbeat, a finish and every operator edit bump the version.
 */
export interface OperatorOptions {
  readonly expectedVersion?: number;
}

export interface JobQuery {
  readonly queue: string;
  readonly states?: readonly JobState[];
  readonly limit: number;
  /** Opaque cursor from a previous page. */
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}
