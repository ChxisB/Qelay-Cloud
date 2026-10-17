import type { OperatorOptions } from '@qelay-cloud/core';
import { FlowProtectedError, JobStateError, UnsupportedOptionError } from '@qelay-cloud/core';
import { cleanLimit } from './clean';
import type { StoreContext } from './context';
import { PROTECTED_BY_OUTSIDE_CONSUMER, protectedIds } from './flowGuard';
import { lockQueueExclusive } from './locks';
import { checkedVersion, lockRow } from './operator';
import { identifier } from './prepare';
import { deleteJobRows, removeEach } from './remove';
import { runTransaction } from './retry';
import { effectiveState } from './state';

/**
 * Deleting one job and deleting a whole queue. Adapted from Qelay's `deleteLiveJob` and
 * `queueDestruction.ts` (see docs/PORTING.md). Both refuse what a live flow parent still waits on;
 * `remove` also refuses an active job, and `obliterate` refuses one unless it is forced. `remove`
 * takes `expectedVersion`; the Control API (task 31) fences `remove` with it and `obliterate` with a
 * typed confirmation of the queue's name.
 */

/** What `remove` did. Only `removed` changed anything. */
export type RemoveResult = 'removed' | 'active' | 'protected' | 'not-found';

export interface ObliterateOptions {
  /** At most this many jobs per call. Default 1,000, at most 10,000. */
  readonly limit?: number;
  /** Delete the queue's active jobs too. Their workers' next heartbeat or finish finds no job. */
  readonly force?: boolean;
}

export interface ObliterateReport {
  /** Jobs deleted by this call. */
  readonly removed: number;
  /** False when jobs are left: call again. The queue's other rows go with the last batch. */
  readonly done: boolean;
}

/**
 * The journal id of a queue-level event. A queue event belongs to no job, but an event row names
 * one, so it names the queue with a prefix no job id can collide with in practice.
 */
export const queueEventId = (queue: string): string => `__queue__:${queue}`;

/**
 * Deletes one job in any state but active, with its logs, flow failures and dependencies. A job a
 * live flow consumer depends on is `protected` and stays. A flow parent is deletable: its dependency
 * rows go with it, so its children are no longer protected.
 */
export async function removeJob(
  ctx: StoreContext,
  id: string,
  options?: OperatorOptions
): Promise<RemoveResult> {
  const expected = checkedVersion(options);
  return ctx.db.run('remove', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockRow(tx, ctx, id, expected);
      if (!row) return 'not-found';
      if (row.state === 'active') return 'active';
      if ((await protectedIds(tx, ctx.namespace, [id])).size > 0) return 'protected';
      const now = await ctx.db.time.now(tx);
      const state = effectiveState(row.state, Number(row.run_at), row.priority, now);
      await removeEach(tx, ctx, [{ id, queue: row.queue, state }], null, now);
      return 'removed';
    })
  );
}

/**
 * A batch of the queue's jobs, locked. The order is the one `qcloud_jobs_state_idx` holds, so the read
 * walks that queue's entries and stops at the limit, however many queues the namespace has.
 */
export const QUEUE_JOBS = `
  SELECT id, state FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2
  ORDER BY state, created_at, id
  LIMIT $3
  FOR UPDATE`;

/** One active job of the queue, read from the same index. */
export const ACTIVE_JOB = `
  SELECT id FROM qcloud_jobs
  WHERE namespace = $1 AND queue = $2 AND state = 'active'
  ORDER BY created_at, id
  LIMIT 1`;

/**
 * The tables that hold one row or a few per queue, deleted with the last batch, and the index that
 * serves each delete (`schema.planned.ts` checks it).
 */
export const QUEUE_ROWS: readonly (readonly [table: string, index: string])[] = [
  ['qcloud_completions', 'qcloud_completions_queue_idx'],
  ['qcloud_group_state', 'qcloud_group_state_rotation_idx'],
  ['qcloud_queue_state', 'qcloud_queue_state_pkey'],
  ['qcloud_metric_buckets', 'qcloud_metric_buckets_pkey'],
  ['qcloud_metric_totals', 'qcloud_metric_totals_pkey'],
];

/**
 * Deletes a queue: its jobs in bounded batches, then (with the last batch) its completion records,
 * group and queue state (pause, limits, configuration) and metrics, and journals `obliterated`. The
 * queue's event history is not deleted: retention ages it out (`eventRetention.ts`).
 *
 * It takes the queue's lifecycle lock exclusively, so an enqueue in flight finishes first and a new
 * one waits. Refused, with nothing deleted: a job of the queue that a live flow parent in another
 * queue waits on (`FlowProtectedError`: remove or finish the parent first), and an active job unless
 * `force` is set (`JobStateError`). A flow wholly inside the queue goes with it. An unknown queue is
 * `{removed: 0, done: true}` and journals nothing.
 */
export async function obliterateQueue(
  ctx: StoreContext,
  queueName: string,
  options: ObliterateOptions = {}
): Promise<ObliterateReport> {
  const queue = identifier('queue', queueName);
  if (queue.length === 0) throw new UnsupportedOptionError('queue', 'must not be empty');
  const limit = cleanLimit(options.limit);
  const force = options.force === true;
  return ctx.db.run('obliterate', (sql) =>
    runTransaction(sql, async (tx) => {
      await lockQueueExclusive(tx, ctx.namespace, queue);
      const [outside] = await tx.unsafe<Array<{ id: string | null }>>(
        PROTECTED_BY_OUTSIDE_CONSUMER,
        [ctx.namespace, queue]
      );
      if (outside?.id) {
        throw new FlowProtectedError(
          `queue ${queue}`,
          `job ${outside.id} is awaited by a live flow parent in another queue`
        );
      }
      if (!force) {
        const [active] = await tx.unsafe<Array<{ id: string }>>(ACTIVE_JOB, [ctx.namespace, queue]);
        if (active) throw new JobStateError(active.id, 'active', 'deleted with its queue');
      }
      const found = await tx.unsafe<Array<{ id: string; state: string }>>(QUEUE_JOBS, [
        ctx.namespace,
        queue,
        limit + 1,
      ]);
      const batch = found.slice(0, limit);
      // Locking the rows waits for a claim in flight, so a job that turned active meanwhile is seen.
      const raced = batch.find((job) => job.state === 'active');
      if (!force && raced) throw new JobStateError(raced.id, 'active', 'deleted with its queue');
      const ids = batch.map((job) => job.id);
      await deleteJobRows(tx, ctx.namespace, ids);
      if (ids.length > 0) {
        const list = tx.array(ids, 'TEXT');
        await tx`
          DELETE FROM qcloud_repeat_links
          WHERE namespace = ${ctx.namespace} AND (original_id = ANY(${list}) OR successor_id = ANY(${list}))`;
      }
      const done = found.length <= limit;
      if (!done) return { removed: ids.length, done };
      let rows = ids.length;
      for (const [table] of QUEUE_ROWS) {
        const deleted = await tx.unsafe<unknown[]>(
          `DELETE FROM ${table} WHERE namespace = $1 AND queue = $2 RETURNING 1`,
          [ctx.namespace, queue]
        );
        rows += deleted.length;
      }
      if (rows > 0) {
        const now = await ctx.db.time.now(tx);
        await ctx.recorder.record(
          tx,
          [{ type: 'obliterated', queue, jobId: queueEventId(queue), state: null }],
          now
        );
      }
      return { removed: ids.length, done };
    })
  );
}
