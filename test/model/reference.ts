import { QueueLimits } from './limits';
import type { Cause, ModelJob, ModelLease } from './model';
import { allows, assertTransition, compareClaimOrder, ModelError, stateOf } from './model';
import type { JobState } from './store';

export interface JobSpec {
  readonly queue: string;
  readonly priority: number;
  readonly lifo: boolean;
  readonly delayMs: number;
  readonly maxAttempts: number;
}

/** What enqueueing a custom id must do: return the live job, or admit `generation`. */
export interface EnqueuePlan {
  readonly live: ModelJob | null;
  readonly generation: number;
}

/**
 * The reference queue: what every store must report after each command. Backoff is 0, so a
 * retry is due at once (upstream's backoff jitter would make replays nondeterministic).
 * Attempts count on fail and on lease recovery, never on claim. The stall limit is not
 * modelled: with `maxAttempts <= 3` and every stall counting an attempt, the attempt limit
 * always fires first.
 */
export class QueueModel {
  readonly jobs = new Map<string, ModelJob>();
  /** Ids whose last generation was cancelled: the store must not know them. */
  readonly cancelled = new Set<string>();
  readonly paused = new Set<string>();
  readonly limits = new QueueLimits();
  /** Leases live workers hold. */
  readonly held: ModelLease[] = [];
  /** Leases nobody should use: crashed workers, rejected renewals, finished jobs. */
  readonly spent: ModelLease[] = [];
  readonly #generations = new Map<string, number>();
  #seq = 0;
  #leaseNo = 0;

  constructor(readonly lockTtlMs: number) {}

  planEnqueue(customId: string | null): EnqueuePlan {
    if (customId === null) return { live: null, generation: 1 };
    const current = this.jobs.get(customId);
    if (current && (current.phase === 'pending' || current.phase === 'active')) {
      return { live: current, generation: current.generation };
    }
    return { live: null, generation: (this.#generations.get(customId) ?? 0) + 1 };
  }

  add(id: string, custom: boolean, spec: JobSpec, generation: number, now: number): ModelJob {
    const previous = this.jobs.get(id);
    if (previous) this.#move(previous, 'retire', now, () => 'removed');
    this.cancelled.delete(id);
    if (custom) this.#generations.set(id, generation);
    const job: ModelJob = {
      id,
      queue: spec.queue,
      generation,
      seq: this.#seq++,
      custom,
      lifo: spec.lifo,
      maxAttempts: spec.maxAttempts,
      priority: spec.priority,
      runAt: now + spec.delayMs,
      attempts: 0,
      phase: 'pending',
      leaseNo: null,
      leaseOwner: null,
      leaseUntil: 0,
    };
    this.jobs.set(id, job);
    return job;
  }

  /** Jobs a claim on `queue` may take now, unordered. Empty while the queue is paused. */
  claimable(queue: string, now: number): ModelJob[] {
    if (this.paused.has(queue)) return [];
    return [...this.jobs.values()].filter(
      (job) => job.queue === queue && allows('claim', stateOf(job, now))
    );
  }

  /** Most jobs a claim of `n` may take under the queue's rate and concurrency limits. */
  capacity(queue: string, n: number, now: number): number {
    const active = [...this.jobs.values()].filter(
      (job) => job.queue === queue && job.phase === 'active' && now < job.leaseUntil
    ).length;
    return this.limits.room(queue, n, active);
  }

  /** The best claimable job of `queue`, or undefined. */
  next(queue: string, now: number): ModelJob | undefined {
    return this.claimable(queue, now).sort(compareClaimOrder)[0];
  }

  claim(job: ModelJob, worker: string, now: number): ModelLease {
    const lease: ModelLease = {
      no: this.#leaseNo++,
      jobId: job.id,
      generation: job.generation,
      worker,
    };
    this.#move(job, 'claim', now, () => {
      job.phase = 'active';
      job.leaseNo = lease.no;
      job.leaseOwner = worker;
      job.leaseUntil = now + this.lockTtlMs;
    });
    this.held.push(lease);
    return lease;
  }

  /** The fence: the job is active under this lease, and the lease has not expired. */
  isCurrent(lease: ModelLease, now: number): boolean {
    const job = this.jobs.get(lease.jobId);
    return (
      job !== undefined &&
      job.generation === lease.generation &&
      job.phase === 'active' &&
      job.leaseNo === lease.no &&
      now < job.leaseUntil
    );
  }

  renew(lease: ModelLease, now: number): void {
    this.#leased(lease).leaseUntil = now + this.lockTtlMs;
  }

  /** The worker gives the job back: claimable at once, in its old place, with no attempt counted. */
  giveBack(lease: ModelLease, now: number): void {
    const job = this.#leased(lease);
    this.#move(job, 'release', now, () => this.#endLease(job, 'pending'));
  }

  complete(lease: ModelLease, now: number): void {
    const job = this.#leased(lease);
    this.#move(job, 'complete', now, () => this.#endLease(job, 'completed'));
  }

  /** Counts the attempt, then retries or fails the job. Returns the job's new state. */
  fail(lease: ModelLease, unrecoverable: boolean, now: number): JobState {
    return this.#attemptFailed(this.#leased(lease), unrecoverable, 'fail', now);
  }

  /** Lease recovery: every active job whose lease has expired loses an attempt. */
  recoverExpired(now: number): ModelJob[] {
    const expired = [...this.jobs.values()].filter(
      (job) => job.phase === 'active' && job.leaseUntil <= now
    );
    for (const job of expired) this.#attemptFailed(job, false, 'recover', now);
    return expired;
  }

  promote(job: ModelJob, now: number): void {
    this.#move(job, 'promote', now, () => {
      job.runAt = now;
    });
  }

  changePriority(job: ModelJob, priority: number, now: number): void {
    this.#move(job, 'change-priority', now, () => {
      job.priority = priority;
    });
  }

  cancel(job: ModelJob, now: number): void {
    this.#move(job, 'cancel', now, () => 'removed');
    this.jobs.delete(job.id);
    this.cancelled.add(job.id);
  }

  /** Moves a held lease to the spent list: its holder stops using it. */
  release(lease: ModelLease): void {
    const index = this.held.indexOf(lease);
    if (index >= 0) this.held.splice(index, 1);
    if (!this.spent.includes(lease)) this.spent.push(lease);
  }

  /** The worker dies without telling the store. Its leases become zombies. */
  crash(worker: string): number {
    const dropped = this.held.filter((lease) => lease.worker === worker);
    for (const lease of dropped) this.release(lease);
    return dropped.length;
  }

  /** Every id the store must answer for, live, terminal or cancelled, in a stable order. */
  knownIds(): string[] {
    return [...this.jobs.keys(), ...this.cancelled].sort();
  }

  #attemptFailed(
    job: ModelJob,
    unrecoverable: boolean,
    via: 'fail' | 'recover',
    now: number
  ): JobState {
    const exhausted = unrecoverable || job.attempts + 1 >= job.maxAttempts;
    this.#move(job, exhausted ? `${via}-dlq` : `${via}-retry`, now, () => {
      job.attempts += 1;
      if (exhausted) {
        this.#endLease(job, 'failed');
        return;
      }
      this.#endLease(job, 'pending');
      job.runAt = now;
    });
    return stateOf(job, now);
  }

  #endLease(job: ModelJob, phase: ModelJob['phase']): void {
    job.phase = phase;
    job.leaseNo = null;
    job.leaseOwner = null;
    job.leaseUntil = 0;
  }

  #leased(lease: ModelLease): ModelJob {
    const job = this.jobs.get(lease.jobId);
    if (!job || job.leaseNo !== lease.no) throw new ModelError(`lease ${lease.no} is not current`);
    return job;
  }

  /** Applies `change` and checks the move against the transition table. */
  #move(job: ModelJob, cause: Cause, now: number, change: () => 'removed' | void): void {
    const from = stateOf(job, now);
    const removed = change() === 'removed';
    assertTransition(cause, from, removed ? 'removed' : stateOf(job, now));
  }
}
