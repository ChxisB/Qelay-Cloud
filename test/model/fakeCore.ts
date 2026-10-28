import type { Row } from './fakeRows';
import { stateOfRow } from './fakeRows';
import { QueueLimits } from './limits';
import type { DlqEntry, EnqueuedJob, JobState, Lease, NewJob, Ring, StoreEnv } from './store';

/**
 * The state and the steps of `FakeStore`. Planted-bug variants (`targets.ts`) override one
 * protected step each, so each step stays small and has one job.
 */
export class FakeCore {
  protected readonly rows = new Map<string, Row>();
  /** Separate from the rows, like a DLQ table, so retiring a job must clear it too. */
  protected readonly dlq = new Map<string, DlqEntry>();
  protected readonly paused = new Set<string>();
  protected readonly limits = new QueueLimits();
  #ids = 0;
  #tokens = 0;

  constructor(protected readonly env: StoreEnv) {}

  protected now(): number {
    return this.env.clock.now();
  }

  protected nextToken(): string {
    return `token-${++this.#tokens}`;
  }

  protected insert(job: NewJob): EnqueuedJob {
    const options = job.options ?? {};
    const customId = options.jobId;
    const existing = customId === undefined ? undefined : this.rows.get(customId);
    if (existing && (existing.status === 'pending' || existing.status === 'active')) {
      return { id: existing.id, created: false, state: this.stateOf(existing), ring: null };
    }
    if (existing) this.retire(existing);
    const now = this.now();
    const backoff = options.backoff;
    const row: Row = {
      id: customId ?? `job-${String(++this.#ids).padStart(8, '0')}`,
      queue: job.queue,
      name: job.name ?? 'default',
      createdAt: now,
      data: job.data,
      lifo: options.lifo ?? false,
      maxAttempts: options.attempts ?? 1,
      backoffMs: typeof backoff === 'number' ? backoff : (backoff?.delay ?? 0),
      priority: options.priority ?? 0,
      runAt: now + Math.max(0, options.delay ?? 0),
      attempts: 0,
      status: 'pending',
      leaseToken: null,
      leaseOwner: null,
      leaseUntil: null,
      leaseRenewals: 0,
      rungAt: null,
    };
    this.rows.set(row.id, row);
    // The store never rings. It returns the bell with its delay, and the caller reports it back.
    return {
      id: row.id,
      created: true,
      state: this.stateOf(row),
      ring: this.ring(row, now),
    };
  }

  /** Reusing a finished custom id drops the old job and its DLQ entry. */
  protected retire(row: Row): void {
    this.rows.delete(row.id);
    this.dlq.delete(row.id);
  }

  protected stateOf(row: Row): JobState {
    return stateOfRow(row, this.now());
  }

  protected isReady(row: Row, now: number): boolean {
    return row.status === 'pending' && row.runAt <= now;
  }

  protected isClaimCandidate(row: Row, queue: string, now: number): boolean {
    return row.queue === queue && this.isReady(row, now);
  }

  /** Jobs of the queue holding an unexpired lease: what a concurrency limit counts. */
  protected activeCount(queue: string, now: number): number {
    return [...this.rows.values()].filter(
      (row) => row.queue === queue && row.status === 'active' && (row.leaseUntil ?? 0) > now
    ).length;
  }

  /** How many jobs a claim of `n` may take under the queue's limits. */
  protected limitRoom(queue: string, n: number, now: number): number {
    return this.limits.room(queue, n, this.activeCount(queue, now));
  }

  /** The lease fence: active, same token, and the lease has not expired. */
  protected held(lease: Lease): Row | null {
    const row = this.rows.get(lease.jobId);
    const live =
      row?.status === 'active' &&
      row.leaseToken === lease.token &&
      (row.leaseUntil ?? 0) > this.now();
    return live ? row : null;
  }

  /** An expired lease counts as an attempt. */
  protected recover(row: Row, now: number): void {
    row.attempts += 1;
    if (row.attempts >= row.maxAttempts) this.toDlq(row, 'lease expired', now);
    else this.retry(row, now);
  }

  protected isReRingDue(row: Row, now: number): boolean {
    return row.rungAt === null || row.rungAt <= now - this.env.reRingAfterMs;
  }

  protected retry(row: Row, now: number): void {
    this.endLease(row, 'pending');
    row.runAt = now + row.backoffMs;
    row.rungAt = null;
  }

  protected toDlq(row: Row, reason: string, now: number): void {
    this.endLease(row, 'failed');
    this.dlq.set(row.id, {
      jobId: row.id,
      queue: row.queue,
      attempts: row.attempts,
      failedAt: now,
      reason,
    });
  }

  /** `retry-dlq`: a dead-lettered job is pending again with no attempt used, and its DLQ entry is gone. */
  protected reopen(row: Row, now: number): void {
    this.endLease(row, 'pending');
    row.attempts = 0;
    row.runAt = now;
    row.rungAt = null;
    this.dlq.delete(row.id);
  }

  protected endLease(row: Row, status: Row['status']): void {
    row.status = status;
    row.leaseToken = null;
    row.leaseOwner = null;
    row.leaseUntil = null;
  }

  /** A limit changed: bells that were due and spent on a claim that got nothing must ring again. */
  protected clearDueBells(queue: string, now: number): void {
    for (const row of this.rows.values()) {
      if (row.queue === queue && row.status === 'pending' && (row.rungAt ?? now + 1) <= now) {
        row.rungAt = null;
      }
    }
  }

  /** The ring for a claimable job, with `dueInMs` 0. Setting `rungAt` is `markRung`'s job. */
  protected ringIfReady(row: Row, now: number): Ring[] {
    if (!this.isReady(row, now)) return [];
    return [this.ring(row, now)];
  }

  /** The bell for a pending job, due now or after its remaining delay. */
  protected ring(row: Row, now: number): Ring {
    return {
      bell: { namespace: this.env.namespace, queue: row.queue, jobId: row.id },
      dueInMs: Math.max(0, row.runAt - now),
    };
  }
}
