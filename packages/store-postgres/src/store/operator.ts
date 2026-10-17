import type { JobState, OperatorOptions, Outcome } from '@qelay-cloud/core';
import { JobVersionError, UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { releaseDeleted } from './flowResolve';
import { priorityColumn } from './prepare';
import { deleteJobRows } from './remove';
import { runTransaction } from './retry';
import { initialState, ringFor } from './state';

/**
 * Operator actions on one job: make a delayed job due now, change a pending job's priority, cancel
 * a job that has not run. Adapted from Qelay's `mutations.ts`, `terminal.ts` and `promotion.ts` (see
 * docs/PORTING.md). Each locks the row, reads the database time once after the lock, and decides
 * from the state a reader would report at that instant: a stored `delayed` row past its `run_at` is
 * already claimable, so `promote` refuses it, exactly as it refuses a job that is waiting.
 */

export interface OperatorRow {
  readonly queue: string;
  readonly state: string;
  readonly priority: number;
  readonly run_at: number | string | bigint;
  readonly version: number | string | bigint;
  readonly parent_id: string | null;
}

/** `expectedVersion` must be a non-negative safe integer, whatever the job's state. */
export function checkedVersion(options: OperatorOptions | undefined): number | undefined {
  const expected = options?.expectedVersion;
  if (expected === undefined) return undefined;
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new UnsupportedOptionError('expectedVersion', 'must be an integer from 0');
  }
  return expected;
}

/**
 * The fence of an operator action: called with the locked row, before the state is looked at, so a
 * caller that read the job earlier always learns that it moved, whatever state it is in now. Throws
 * `JobVersionError`; the transaction rolls back and nothing was changed.
 */
export function assertVersion(
  id: string,
  row: { readonly version: number | string | bigint },
  expected: number | undefined
): void {
  if (expected === undefined) return;
  const actual = Number(row.version);
  if (actual !== expected) throw new JobVersionError(id, expected, actual);
}

export async function lockRow(
  tx: TransactionSQL,
  ctx: StoreContext,
  id: string,
  expectedVersion?: number
): Promise<OperatorRow | null> {
  const [row] = await tx<OperatorRow[]>`
    SELECT queue, state, priority, run_at, version, parent_id FROM qcloud_jobs
    WHERE namespace = ${ctx.namespace} AND id = ${id}
    FOR UPDATE`;
  if (row === undefined) return null;
  assertVersion(id, row, expectedVersion);
  return row;
}

/**
 * Makes a delayed job due now: `run_at = now`, state `waiting` or `prioritized`, `rung_at` cleared,
 * and the bell returned for the caller to ring. `ok: false` and no change for any other state,
 * including a delayed job whose time has already come.
 */
export async function promoteJob(
  ctx: StoreContext,
  id: string,
  options?: OperatorOptions
): Promise<Outcome> {
  const expected = checkedVersion(options);
  return ctx.db.run('promote', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockRow(tx, ctx, id, expected);
      const now = await ctx.db.time.now(tx);
      if (row?.state !== 'delayed' || Number(row.run_at) <= now) return { ok: false, rings: [] };
      const state = initialState(now, now, row.priority);
      await tx`
        UPDATE qcloud_jobs
        SET state = ${state}, run_at = ${now}, rung_at = NULL, version = version + 1
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      await ctx.recorder.record(
        tx,
        [{ type: 'promoted', queue: row.queue, jobId: id, state }],
        now
      );
      const ring = ringFor(ctx.namespace, row.queue, id, now, now, ctx.ringWindowMs);
      return { ok: true, rings: ring ? [ring] : [] };
    })
  );
}

/**
 * Sets the priority of a waiting, prioritized or delayed job. A job whose priority becomes 0 is
 * `waiting` and one above 0 is `prioritized`; a delayed job stays delayed until its time. Its bell,
 * if any, stays valid: the job is no more or less claimable than before. False and no change for any
 * other state or an unknown id. A priority that is not a non-negative integer throws, as it would at
 * enqueue, whatever the job's state.
 */
export async function changePriority(
  ctx: StoreContext,
  id: string,
  priority: number,
  options?: OperatorOptions
): Promise<boolean> {
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0) {
    throw new UnsupportedOptionError('priority', 'must be an integer from 0');
  }
  const expected = checkedVersion(options);
  const column = priorityColumn(priority);
  return ctx.db.run('changePriority', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockRow(tx, ctx, id, expected);
      if (!row || !['waiting', 'prioritized', 'delayed'].includes(row.state)) return false;
      const now = await ctx.db.time.now(tx);
      const state = initialState(Number(row.run_at), now, column);
      await tx`
        UPDATE qcloud_jobs SET priority = ${column}, state = ${state}, version = version + 1
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      await ctx.recorder.record(
        tx,
        [{ type: 'priority', queue: row.queue, jobId: id, state }],
        now
      );
      return true;
    })
  );
}

/**
 * Deletes a waiting, prioritized, delayed or waiting-children job with its logs, flow failures and
 * dependencies, and journals it as removed. False and no change for an active or finished job or an
 * unknown id. In a flow:
 * - a child is cancelled like any job and its parent stops waiting for it: the parent is released if that
 *   was the last child it waited for. The release returns no ring (this action returns none); the tick
 *   rings the released parent on its next pass.
 * - a parent is cancelled with its dependency rows. Its children keep running as plain jobs; when they
 *   finish they find no parent waiting and change nothing.
 */
export async function cancelJob(
  ctx: StoreContext,
  id: string,
  options?: OperatorOptions
): Promise<boolean> {
  const expected = checkedVersion(options);
  return ctx.db.run('cancel', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockRow(tx, ctx, id, expected);
      if (!row || !['waiting', 'prioritized', 'delayed', 'waiting-children'].includes(row.state)) {
        return false;
      }
      const now = await ctx.db.time.now(tx);
      await deleteJobRows(tx, ctx.namespace, [id]);
      await ctx.recorder.record(
        tx,
        [
          {
            type: 'removed',
            queue: row.queue,
            jobId: id,
            state: row.state as JobState,
            removed: true,
          },
        ],
        now
      );
      await releaseDeleted(ctx, tx, [{ id, parentId: row.parent_id }], now);
      return true;
    })
  );
}
