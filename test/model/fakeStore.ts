import type { JobQuery, Page, RateLimit, RungEntry, StateCounts } from '@qelay-cloud/core';
import { FakeCore } from './fakeCore';
import { claimOrder, countStates, toRecord } from './fakeRows';
import type {
  ClaimedJob,
  DlqEntry,
  EnqueuedJob,
  FailureInfo,
  JobRecord,
  JobState,
  Lease,
  NewJob,
  Outcome,
  Ring,
  StateStore,
  TickReport,
} from './store';
import type { TickBudget } from './store';

const REFUSED: Outcome = { ok: false, rings: [] };

/** In-memory `StateStore` that proves the harness: rows, a lease fence, an ORDER BY like `claimSelection`.
 * The state and the steps live in `FakeCore`; planted-bug variants (`targets.ts`) override one step each. */
export class FakeStore extends FakeCore implements StateStore {
  async enqueue(jobs: readonly NewJob[]): Promise<EnqueuedJob[]> {
    return jobs.map((job) => this.insert(job));
  }

  async claim(queue: string, owner: string, n: number): Promise<ClaimedJob[]> {
    const now = this.now();
    this.limits.refresh(queue, now);
    if (this.paused.has(queue)) return [];
    const picked = [...this.rows.values()]
      .filter((row) => this.isClaimCandidate(row, queue, now))
      .sort(claimOrder)
      .slice(0, this.limitRoom(queue, n, now));
    this.limits.took(queue, picked.length);
    return picked.map((row) => {
      row.status = 'active';
      row.leaseToken = this.nextToken();
      row.leaseOwner = owner;
      row.leaseUntil = now + this.env.lockTtlMs;
      row.leaseRenewals = 0;
      return {
        id: row.id,
        queue: row.queue,
        name: row.name,
        data: row.data,
        attempts: row.attempts,
        lease: { jobId: row.id, token: row.leaseToken, owner },
        leaseUntil: row.leaseUntil,
      };
    });
  }

  async heartbeat(lease: Lease): Promise<boolean> {
    const row = this.held(lease);
    if (!row) return false;
    row.leaseUntil = this.now() + this.env.lockTtlMs;
    row.leaseRenewals += 1;
    return true;
  }

  async release(lease: Lease): Promise<Outcome> {
    const row = this.held(lease);
    if (!row) return REFUSED;
    this.endLease(row, 'pending');
    row.rungAt = null;
    return { ok: true, rings: this.ringIfReady(row, this.now()) };
  }

  async complete(lease: Lease, _result: unknown): Promise<Outcome> {
    const row = this.held(lease);
    if (!row) return REFUSED;
    this.endLease(row, 'completed');
    return { ok: true, rings: [] };
  }

  async completeMany(
    items: ReadonlyArray<{ readonly lease: Lease; readonly result: unknown }>
  ): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    for (const { lease, result } of items) outcomes.push(await this.complete(lease, result));
    return outcomes;
  }

  async fail(lease: Lease, error: FailureInfo): Promise<Outcome> {
    const row = this.held(lease);
    if (!row) return REFUSED;
    row.attempts += 1;
    const now = this.now();
    if (error.unrecoverable || row.attempts >= row.maxAttempts) {
      this.toDlq(row, error.message, now);
      return { ok: true, rings: [] };
    }
    this.retry(row, now);
    return { ok: true, rings: this.ringIfReady(row, now) };
  }

  async tick(_budget: TickBudget): Promise<TickReport> {
    const now = this.now();
    const expired = [...this.rows.values()].filter(
      (row) => row.status === 'active' && (row.leaseUntil ?? 0) <= now
    );
    for (const row of expired) this.recover(row, now);
    const rings: Ring[] = [];
    for (const row of this.rows.values()) {
      if (this.isReady(row, now) && !this.paused.has(row.queue) && this.isReRingDue(row, now)) {
        rings.push(...this.ringIfReady(row, now));
      }
    }
    return {
      recovered: expired.length,
      promoted: 0,
      cronFired: 0,
      expired: 0,
      rings,
      moreWork: false,
    };
  }

  async markRung(rung: readonly RungEntry[]): Promise<void> {
    const now = this.now();
    for (const entry of rung) {
      const row = this.rows.get(entry.jobId);
      if (row?.status === 'pending') row.rungAt = now + entry.deliverAfterMs;
    }
  }

  async pause(queue: string): Promise<void> {
    this.paused.add(queue);
  }

  async resume(queue: string): Promise<void> {
    this.paused.delete(queue);
    for (const row of this.rows.values()) {
      if (row.queue === queue && row.status === 'pending') row.rungAt = null;
    }
  }

  async setRateLimit(queue: string, limit: RateLimit | null): Promise<void> {
    const now = this.now();
    this.limits.setRate(
      queue,
      limit && { max: limit.max, durationMs: limit.durationMs ?? 1000 },
      now
    );
    this.clearDueBells(queue, now);
  }

  async setConcurrencyLimit(queue: string, limit: number | null): Promise<void> {
    this.limits.setConcurrency(queue, limit);
    this.clearDueBells(queue, this.now());
  }

  async promote(id: string): Promise<Outcome> {
    const row = this.rows.get(id);
    const now = this.now();
    if (row?.status !== 'pending' || row.runAt <= now) return REFUSED;
    row.runAt = now;
    return { ok: true, rings: this.ringIfReady(row, now) };
  }

  async changePriority(id: string, priority: number): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'pending') return false;
    row.priority = priority;
    return true;
  }

  async cancel(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.status !== 'pending') return false;
    this.rows.delete(id);
    return true;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const row = this.rows.get(id);
    return row ? toRecord(row, this.now()) : null;
  }

  async listDlq(queue: string): Promise<DlqEntry[]> {
    return [...this.dlq.values()].filter((entry) => entry.queue === queue);
  }

  async listJobs(query: JobQuery): Promise<Page<JobRecord>> {
    const now = this.now();
    const wanted = query.states ? new Set<JobState>(query.states) : null;
    const items = [...this.rows.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row) => toRecord(row, now))
      .filter((job) => job.queue === query.queue && (!wanted || wanted.has(job.state)));
    return { items: items.slice(0, query.limit), next: null };
  }

  async counts(queue: string): Promise<StateCounts> {
    return countStates(this.rows.values(), queue, this.now());
  }

  async close(_options?: { readonly timeout?: number }): Promise<void> {}
}
