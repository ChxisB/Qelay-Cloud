import type { Ring } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';

/** Default for `reRingAfterMs`: no more than the shortest tick interval (the in-process tick's 5 s). */
export const DEFAULT_RE_RING_AFTER_MS = 5_000;
/** Default for `graceMs`: longer than a publish normally takes, shorter than a tick. */
export const DEFAULT_RING_GRACE_MS = 2_000;
/** Default for `perQueueCap`. */
export const DEFAULT_RINGS_PER_QUEUE = 100;

export interface RingQuery {
  /**
   * A claimable job whose last bell is at least this old is rung again (`rung_at <= now -
   * reRingAfterMs`). Bells are fungible, so this age, not whether `rung_at` is null, is what bounds
   * how long a claimable job can go without a bell. It must not exceed the tick interval: a lost
   * bell is found by the first tick after it turns this old, and a longer threshold than the
   * interval stretches the bound to threshold plus interval. The tick's configuration (task 20)
   * validates it against the interval it knows; the store cannot.
   */
  readonly reRingAfterMs?: number;
  /**
   * A job created less than this long ago, with no bell yet, is left alone: its publish may still
   * be in flight. It protects a fresh enqueue. A retried or released job has no timestamp of its
   * own to measure from, so a tick that runs between its operation and its `markRung` can ring it
   * again: a second bell for one job, which is harmless because bells are fungible.
   */
  readonly graceMs?: number;
  /** Most rings returned per queue, so a backlog is not one bell per waiting job on every tick. */
  readonly perQueueCap?: number;
  /** Most of those per queue that are re-rings (a bell at least `reRingAfterMs` old). Default `perQueueCap`. */
  readonly staleCap?: number;
  /**
   * How far ahead a delayed job is rung: one whose `run_at` is within this of now is returned with
   * `dueInMs`. Clamped to the transport's window (`ringWindowMs` of the store), so a transport that
   * cannot delay delivery gets a delayed job only once it is due. Should be at least one tick
   * interval plus the worst lateness of a tick, or a job due between two ticks is rung late.
   */
  readonly windowMs?: number;
}

export interface ResolvedRingQuery {
  readonly reRingAfterMs: number;
  readonly graceMs: number;
  readonly perQueueCap: number;
  readonly staleCap: number;
  readonly windowMs: number;
}

function nonNegative(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new UnsupportedOptionError(name, 'must be a non-negative number of milliseconds');
  }
  return Math.floor(value);
}

/** Applies the defaults and the transport clamp, and rejects values no tick could use. */
export function resolveRingQuery(ctx: StoreContext, query: RingQuery = {}): ResolvedRingQuery {
  const perQueueCap = query.perQueueCap ?? DEFAULT_RINGS_PER_QUEUE;
  if (!Number.isSafeInteger(perQueueCap) || perQueueCap < 1) {
    throw new UnsupportedOptionError('perQueueCap', 'must be a positive integer');
  }
  const staleCap = query.staleCap ?? perQueueCap;
  if (!Number.isSafeInteger(staleCap) || staleCap < 1) {
    throw new UnsupportedOptionError('staleCap', 'must be a positive integer');
  }
  const requested = nonNegative('windowMs', query.windowMs, ctx.ringWindowMs);
  return {
    reRingAfterMs: nonNegative('reRingAfterMs', query.reRingAfterMs, DEFAULT_RE_RING_AFTER_MS),
    graceMs: nonNegative('graceMs', query.graceMs, DEFAULT_RING_GRACE_MS),
    perQueueCap,
    staleCap,
    windowMs: Math.min(requested, ctx.ringWindowMs),
  };
}

interface CandidateRow {
  readonly id: string;
  readonly queue: string;
  readonly run_at: number | string | bigint;
}

/**
 * The jobs the tick must ring, as rings. Read-only: the caller rings them and reports the bells
 * the broker took to `markRung`. Per unpaused queue, at most `perQueueCap` of:
 *
 * 1. pending jobs with no bell whose `run_at` is due or inside `windowMs` and that are older than
 *    the grace (index `qcloud_jobs_unrung_idx`, in `run_at` order), with `dueInMs` the wait until
 *    `run_at`; then
 * 2. claimable jobs whose bell is at least `reRingAfterMs` old (index `qcloud_jobs_ring_idx`, oldest
 *    bell first, at most `staleCap`), with `dueInMs` 0. A pre-rung delayed job's `rung_at` is its `run_at`, so it falls
 *    in here only once its time has passed and its bell has not been seen to arrive.
 *
 * Never-rung jobs come first: they have no bell at all. The queues are listed by hopping through
 * the index one queue at a time, so a table with many queues and few candidates costs a probe per
 * queue, and each queue's scan stops at its cap. A paused queue is skipped: its bells would be
 * spent on empty claims, and `resume` clears them so the tick rings the backlog afterwards.
 */
export async function dueForRing(ctx: StoreContext, query?: RingQuery): Promise<Ring[]> {
  const { reRingAfterMs, graceMs, perQueueCap, staleCap, windowMs } = resolveRingQuery(ctx, query);
  return ctx.db.run('dueForRing', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const ns = ctx.namespace;
    const never = await sql<CandidateRow[]>`
      WITH RECURSIVE queues(queue) AS (
        (SELECT queue FROM qcloud_jobs
         WHERE namespace = ${ns} AND state IN ('waiting', 'prioritized', 'delayed')
         ORDER BY queue LIMIT 1)
        UNION ALL
        SELECT (SELECT job.queue FROM qcloud_jobs job
                WHERE job.namespace = ${ns} AND job.state IN ('waiting', 'prioritized', 'delayed')
                  AND job.queue > queues.queue
                ORDER BY job.queue LIMIT 1)
        FROM queues WHERE queues.queue IS NOT NULL
      )
      SELECT candidate.id, candidate.queue, candidate.run_at
      FROM queues
      CROSS JOIN LATERAL (
        SELECT job.id, job.queue, job.run_at FROM qcloud_jobs job
        WHERE job.namespace = ${ns} AND job.queue = queues.queue
          AND job.rung_at IS NULL AND job.state IN ('waiting', 'prioritized', 'delayed')
          AND job.run_at <= ${now + windowMs}
          AND job.created_at <= ${now - graceMs}
        ORDER BY job.run_at, job.id
        LIMIT ${perQueueCap}
      ) candidate
      WHERE queues.queue IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM qcloud_queue_state state
                        WHERE state.namespace = ${ns} AND state.queue = queues.queue AND state.paused)`;
    const stale = await sql<CandidateRow[]>`
      WITH RECURSIVE queues(queue) AS (
        (SELECT queue FROM qcloud_jobs
         WHERE namespace = ${ns} AND state IN ('waiting', 'prioritized', 'delayed')
         ORDER BY queue LIMIT 1)
        UNION ALL
        SELECT (SELECT job.queue FROM qcloud_jobs job
                WHERE job.namespace = ${ns} AND job.state IN ('waiting', 'prioritized', 'delayed')
                  AND job.queue > queues.queue
                ORDER BY job.queue LIMIT 1)
        FROM queues WHERE queues.queue IS NOT NULL
      )
      SELECT candidate.id, candidate.queue, candidate.run_at
      FROM queues
      CROSS JOIN LATERAL (
        SELECT job.id, job.queue, job.run_at FROM qcloud_jobs job
        WHERE job.namespace = ${ns} AND job.queue = queues.queue
          AND job.state IN ('waiting', 'prioritized', 'delayed')
          AND job.rung_at <= ${now - reRingAfterMs}
          AND job.run_at <= ${now}
        ORDER BY job.rung_at, job.id
        LIMIT ${staleCap}
      ) candidate
      WHERE queues.queue IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM qcloud_queue_state state
                        WHERE state.namespace = ${ns} AND state.queue = queues.queue AND state.paused)`;
    const taken = new Map<string, number>();
    const rings: Ring[] = [];
    for (const row of [...never, ...stale]) {
      const count = taken.get(row.queue) ?? 0;
      if (count >= perQueueCap) continue;
      taken.set(row.queue, count + 1);
      rings.push({
        bell: { namespace: ns, queue: row.queue, jobId: row.id },
        dueInMs: Math.max(0, Number(row.run_at) - now),
      });
    }
    return rings;
  });
}
