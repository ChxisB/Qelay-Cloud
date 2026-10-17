import type { OperatorOptions, Outcome } from '@qelay-cloud/core';
import { StoreError, UnsupportedOptionError, validateJobOptions } from '@qelay-cloud/core';
import { PayloadTooLargeError } from '../errors';
import type { StoreContext } from './context';
import { assertVersion, checkedVersion, lockRow } from './operator';
import type { Envelope } from './prepare';
import { normalizeProgress } from './progress';
import { runTransaction } from './retry';
import { effectiveState, initialState, isLiveState, ringFor } from './state';

/**
 * Edits of a job that is not finished: its data, the time a delayed job is due, and an active job's
 * progress. Each locks the row, reads the database time once after the lock and decides from the
 * state a reader would report at that instant, as the operator actions do (`operator.ts`). Adapted
 * from Qelay's `updateJobData`, `changeJobDelay` and `updateJobProgress` (see docs/PORTING.md). A
 * change that does not apply (a finished job, an unknown id) is reported, never thrown; a value that
 * is invalid throws, whatever the job's state.
 */

/**
 * Replaces the job's `data`, keeping its name, retry settings and everything else. Allowed for every
 * job that is not finished, an active one included: its lease is not touched, and the worker that
 * holds it keeps the data it was handed. False and no change for a finished job or an unknown id.
 * Data the codec cannot encode is a `StoreError`, and data that makes the payload too large a
 * `PayloadTooLargeError`; the job keeps its data either way.
 */
export async function updateJobData(
  ctx: StoreContext,
  id: string,
  data: unknown,
  options?: OperatorOptions
): Promise<boolean> {
  const expected = checkedVersion(options);
  return ctx.db.run('updateData', (sql) =>
    runTransaction(sql, async (tx) => {
      const [row] = await tx<
        Array<{
          queue: string;
          state: string;
          payload: Uint8Array;
          priority: number;
          run_at: number | string | bigint;
          version: number | string | bigint;
        }>
      >`
        SELECT queue, state, payload, priority, run_at, version FROM qcloud_jobs
        WHERE namespace = ${ctx.namespace} AND id = ${id}
        FOR UPDATE`;
      if (row) assertVersion(id, row, expected);
      if (!row || !isLiveState(row.state)) return false;
      const envelope = ctx.codec.decode(row.payload) as Envelope;
      let payload: Uint8Array;
      try {
        payload = ctx.codec.encode({ ...envelope, data });
      } catch (error) {
        throw new StoreError(`the data of job ${id} cannot be encoded`, { cause: error });
      }
      if (payload.byteLength > ctx.limits.maxPayloadBytes) {
        throw new PayloadTooLargeError(payload.byteLength, ctx.limits.maxPayloadBytes, 0);
      }
      const now = await ctx.db.time.now(tx);
      await tx`
        UPDATE qcloud_jobs SET payload = ${payload}, version = version + 1
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      const state = effectiveState(row.state, Number(row.run_at), row.priority, now);
      await ctx.recorder.record(tx, [{ type: 'updated', queue: row.queue, jobId: id, state }], now);
      return true;
    })
  );
}

/**
 * Moves a delayed job to `now + delayMs`, clears its bell and returns a new one when the new time is
 * inside the ring window; otherwise the tick rings it nearer its time. A delay of 0 makes it claimable
 * now, as `promote` does. `ok: false` and no change for any other state, including a delayed job
 * whose time has already come. A delay that is not a finite non-negative number, or is over 365 days,
 * throws.
 */
export async function changeJobDelay(
  ctx: StoreContext,
  id: string,
  delayMs: number,
  options?: OperatorOptions
): Promise<Outcome> {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new UnsupportedOptionError('delay', 'must be a finite number of at least 0');
  }
  validateJobOptions({ delay: delayMs });
  const delay = Math.floor(delayMs);
  const expected = checkedVersion(options);
  return ctx.db.run('changeDelay', (sql) =>
    runTransaction(sql, async (tx) => {
      const row = await lockRow(tx, ctx, id, expected);
      const now = await ctx.db.time.now(tx);
      if (row?.state !== 'delayed' || Number(row.run_at) <= now) return { ok: false, rings: [] };
      const runAt = now + delay;
      const state = initialState(runAt, now, row.priority);
      await tx`
        UPDATE qcloud_jobs SET state = ${state}, run_at = ${runAt}, rung_at = NULL, version = version + 1
        WHERE namespace = ${ctx.namespace} AND id = ${id}`;
      const type = state === 'delayed' ? 'updated' : 'promoted';
      await ctx.recorder.record(tx, [{ type, queue: row.queue, jobId: id, state }], now);
      const ring = ringFor(ctx.namespace, row.queue, id, runAt, now, ctx.ringWindowMs);
      return { ok: true, rings: ring ? [ring] : [] };
    })
  );
}

/**
 * Stores the progress of an active job (`normalizeProgress`: it never throws) and journals it. False
 * and no change for any other state or an unknown id. It does not bump `version`: a worker reporting
 * progress must not fence an operator's edit made against the version it read, or the other way
 * round, and progress is not a decision anyone takes a version for.
 */
export async function updateJobProgress(
  ctx: StoreContext,
  id: string,
  progress: unknown,
  message?: string
): Promise<boolean> {
  const stored = normalizeProgress(progress, message);
  return ctx.db.run('updateProgress', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const [row] = await tx<Array<{ queue: string }>>`
        UPDATE qcloud_jobs SET progress = ${stored.progress}, progress_message = ${stored.message ?? null}
        WHERE namespace = ${ctx.namespace} AND id = ${id} AND state = 'active'
        RETURNING queue`;
      if (!row) return false;
      await ctx.recorder.record(
        tx,
        [
          {
            type: 'progress',
            queue: row.queue,
            jobId: id,
            state: 'active',
            progress: stored.progress,
          },
        ],
        now
      );
      return true;
    })
  );
}
