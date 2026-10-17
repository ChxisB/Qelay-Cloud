import type {
  ClaimedJob,
  ClaimOptions,
  DlqEntry,
  EnqueuedJob,
  FailureInfo,
  JobQuery,
  JobRecord,
  Lease,
  NewJob,
  OperatorOptions,
  Outcome,
  Page,
  RateLimit,
  RungEntry,
  StateCounts,
  TickBudget,
  TickReport,
} from './jobs';

/**
 * The job-state seam. Postgres is the only implementation; the interface exists so the SDK,
 * the Control API and the tests do not import a database driver, not to support other databases.
 *
 * **Time and randomness.** Time comes from an injected `Clock` (default: the database clock),
 * so no method takes `now`. Backoff jitter and job ids (UUIDv7, so LIFO order is checkable)
 * are injectable.
 *
 * **Failure contract.** A call that hits its deadline throws `OperationDeadlineError`: the
 * outcome is unknown. Every write is guarded by a lease token or a `version`, so the caller may
 * retry it or drop it without a double effect. A lease-guarded write whose lease was lost
 * returns `{ ok: false }` or `false` and changes nothing.
 *
 * **Rings.** A mutation that makes a job claimable returns the rings to ring. The store never
 * rings; the caller rings, then reports the bells the broker took to `markRung`.
 */
export interface StateStore {
  /**
   * Admits jobs in one transaction, preserving order. Idempotent per custom id and dedup key: a
   * live duplicate returns the existing job with `created: false`. Each admitted job that is
   * claimable now or inside the delay window carries a `ring`.
   */
  enqueue(jobs: readonly NewJob[]): Promise<EnqueuedJob[]>;

  /**
   * Records that the broker took these bells: sets `rung_at` to the database time plus
   * `deliverAfterMs`, only where the job is still claimable. One entry per bell. Safe to call
   * twice. A bell the broker did not take is not passed, so its job stays unrung for the tick.
   */
  markRung(rung: readonly RungEntry[]): Promise<void>;

  /**
   * Leases up to `n` claimable jobs of `queue` to `owner`, in claim order. Does not count an
   * attempt. Returns `[]` for a paused queue, an empty queue or a queue at its rate or concurrency
   * limit. Every limit is enforced inside the claim transaction, so concurrent claimers cannot
   * exceed it.
   */
  claim(queue: string, owner: string, n: number, options?: ClaimOptions): Promise<ClaimedJob[]>;

  /**
   * Extends an unexpired lease to the lease length from now (never past the job's timeout).
   * Returns false when the lease was lost, expired or fenced out by a newer claim; nothing changed.
   */
  heartbeat(lease: Lease): Promise<boolean>;

  /**
   * Gives a held job back without counting an attempt: it is claimable again at once, and
   * `rings` carries the bell. `ok: false` when the lease was lost; nothing changed.
   */
  release(lease: Lease): Promise<Outcome>;

  /** Completes the job and promotes flow parents. Guarded by the lease token. Returns rings. */
  complete(lease: Lease, result: unknown): Promise<Outcome>;

  /** Counts the attempt, then retries after the job's backoff or moves it to the DLQ. Guarded by the lease token. */
  fail(lease: Lease, error: FailureInfo): Promise<Outcome>;

  /**
   * One pass of lease recovery, cron, promotion of due delayed jobs, TTL expiry, retention and
   * the re-ring, within `budget`. Idempotent and safe to run concurrently with itself.
   */
  tick(budget: TickBudget): Promise<TickReport>;

  /** Sets (or with `null` clears) the fixed-window rate limit on claims from `queue`. Resets the window. */
  setRateLimit(queue: string, limit: RateLimit | null): Promise<void>;
  /** Sets (or with `null` clears) how many jobs of `queue` may be active at once. */
  setConcurrencyLimit(queue: string, limit: number | null): Promise<void>;

  /** Stops claims on `queue`. Idempotent. Active jobs keep running; the tick stops re-ringing it. */
  pause(queue: string): Promise<void>;
  /** Idempotent. Clears `rung_at` of claimable jobs so the tick rings them again. */
  resume(queue: string): Promise<void>;

  /**
   * Makes a delayed job due now. Returns rings. `ok: false` if it is not delayed. Each of the three
   * operator actions takes `expectedVersion` and throws `JobVersionError` when the job has moved on.
   */
  promote(id: string, options?: OperatorOptions): Promise<Outcome>;
  /** Only for waiting, prioritized or delayed jobs. */
  changePriority(id: string, priority: number, options?: OperatorOptions): Promise<boolean>;
  /** Deletes a waiting, prioritized, delayed or waiting-children job. */
  cancel(id: string, options?: OperatorOptions): Promise<boolean>;

  /** Reads are side-effect free and may be served by a replica. Null when the id is unknown. */
  getJob(id: string): Promise<JobRecord | null>;
  /** Ordered by job id, which sorts in creation order. Pages by an opaque cursor. */
  listJobs(query: JobQuery): Promise<Page<JobRecord>>;
  /** A count per state for one queue. A delayed job whose `run_at` passed counts as ready. */
  counts(queue: string): Promise<StateCounts>;
  /** The queue's DLQ entries: exactly one per failed job, never rewritten. */
  listDlq(queue: string): Promise<DlqEntry[]>;

  /** Releases connections. Waits at most `timeout` ms for in-flight calls. */
  close(options?: { readonly timeout?: number }): Promise<void>;
}
