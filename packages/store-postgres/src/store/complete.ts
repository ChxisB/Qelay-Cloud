import type { Lease, Outcome } from '@qelay-cloud/core';
import { StoreError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { lockHeldJob, lockHeldJobs } from './jobRow';
import { isWellFormedLease } from './leaseRules';
import { recordMetrics } from './metrics';
import { overShape } from './payloadShape';
import type { Envelope } from './prepare';
import { deleteJobRows } from './remove';
import { runTransaction } from './retry';

const LOST: Outcome = { ok: false, rings: [] };

/**
 * Completes the job the lease holds. Adapted from Qelay's `completionOutcome.ts` (see
 * docs/PORTING.md). One transaction: lock the row, check the fence (still active, this token, lease
 * not yet due), write the completion record and mark the job `completed` with its result
 * (or delete it when it asked for `removeOnComplete`), journal the event, run the terminal hook,
 * count the metric. If any of it fails nothing is written.
 *
 * A lease that was lost (expired, recovered, claimed again, or the job already completed by an
 * earlier call of this one) returns `{ ok: false }` and changes nothing, so a caller that is told
 * the outcome is unknown can call again.
 */
export async function completeJob(
  ctx: StoreContext,
  lease: Lease,
  result: unknown
): Promise<Outcome> {
  if (!isWellFormedLease(lease)) return LOST;
  const encoded = encodeResult(ctx, lease.jobId, result);
  return ctx.db.run('complete', (sql) =>
    runTransaction(sql, async (tx) => {
      const held = await lockHeldJob(tx, ctx, lease);
      if (!held) return LOST;
      const { row, now } = held;
      const envelope = ctx.codec.decode(row.payload) as Envelope;
      const removed = envelope.removeOnComplete === true;
      await tx`
        INSERT INTO qcloud_completions (namespace, job_id, queue, completed_at, result)
        VALUES (${ctx.namespace}, ${row.id}, ${row.queue}, ${now}, ${encoded})
        ON CONFLICT (namespace, job_id) DO UPDATE SET
          queue = excluded.queue, completed_at = excluded.completed_at, result = excluded.result`;
      if (removed) {
        await deleteJobRows(tx, ctx.namespace, [row.id]);
      } else {
        await tx`
          UPDATE qcloud_jobs
          SET state = 'completed', completed_at = ${now}, result = ${encoded},
              lease_owner = NULL, lease_token = NULL, lease_until = NULL, rung_at = NULL,
              dlq_retry_state = NULL, version = version + 1
          WHERE namespace = ${ctx.namespace} AND id = ${row.id}`;
      }
      await ctx.recorder.record(
        tx,
        [
          {
            type: 'completed',
            queue: row.queue,
            jobId: row.id,
            state: 'completed',
            ...(removed && { removed: true as const }),
          },
        ],
        now
      );
      const rings = await ctx.onTerminal(
        tx,
        [{ jobId: row.id, queue: row.queue, parentId: row.parent_id, outcome: 'completed' }],
        now
      );
      await recordMetrics(tx, ctx, 'completed', new Map([[row.queue, 1]]), now);
      return { ok: true, rings };
    })
  );
}

/**
 * `completeJob` for many leases in one transaction (the SDK's `groupComplete`): the same checks and
 * writes, but each statement runs once for the whole batch, so the transaction costs about as many round
 * trips as one completion, and the queue's metric rows are taken once with the summed count. See
 * `StateStore.completeMany` for what each answer means.
 */
export async function completeJobs(
  ctx: StoreContext,
  items: ReadonlyArray<{ readonly lease: Lease; readonly result: unknown }>
): Promise<Array<Outcome | StoreError>> {
  if (items.length > ctx.limits.maxBatch) {
    throw new StoreError(
      `completeMany takes at most ${ctx.limits.maxBatch} jobs, got ${items.length}`
    );
  }
  const answers: Array<Outcome | StoreError> = items.map(() => LOST);
  const todo: Array<{ index: number; lease: Lease; encoded: Uint8Array }> = [];
  items.forEach(({ lease, result }, index) => {
    if (!isWellFormedLease(lease)) return;
    try {
      todo.push({ index, lease, encoded: encodeResult(ctx, lease.jobId, result) });
    } catch (error) {
      answers[index] = error as StoreError;
    }
  });
  if (todo.length === 0) return answers;
  const { done, rings } = await ctx.db.run('completeMany', (sql) =>
    runTransaction(sql, async (tx) => {
      const { held, now } = await lockHeldJobs(
        tx,
        ctx,
        todo.map((entry) => entry.lease)
      );
      const won = todo.flatMap((entry, position) => {
        const row = held.get(position);
        if (row === undefined) return [];
        const removed = (ctx.codec.decode(row.payload) as Envelope).removeOnComplete === true;
        return [{ ...entry, row, removed }];
      });
      if (won.length === 0) return { done: [], rings: [] };
      await tx`
        INSERT INTO qcloud_completions ${tx(
          won.map(({ row, encoded }) => ({
            namespace: ctx.namespace,
            job_id: row.id,
            queue: row.queue,
            completed_at: now,
            result: encoded,
          })),
          'namespace',
          'job_id',
          'queue',
          'completed_at',
          'result'
        )}
        ON CONFLICT (namespace, job_id) DO UPDATE SET
          queue = excluded.queue, completed_at = excluded.completed_at, result = excluded.result`;
      const removedIds = won.filter((entry) => entry.removed).map((entry) => entry.row.id);
      await deleteJobRows(tx, ctx.namespace, removedIds);
      const keptIds = won.filter((entry) => !entry.removed).map((entry) => entry.row.id);
      if (keptIds.length > 0) {
        await tx`
          UPDATE qcloud_jobs AS j
          SET state = 'completed', completed_at = ${now}, result = c.result,
              lease_owner = NULL, lease_token = NULL, lease_until = NULL, rung_at = NULL,
              dlq_retry_state = NULL, version = j.version + 1
          FROM qcloud_completions AS c
          WHERE j.namespace = ${ctx.namespace} AND j.id = ANY(${tx.array(keptIds, 'TEXT')})
            AND c.namespace = j.namespace AND c.job_id = j.id`;
      }
      await ctx.recorder.record(
        tx,
        won.map(({ row, removed }) => ({
          type: 'completed' as const,
          queue: row.queue,
          jobId: row.id,
          state: 'completed' as const,
          ...(removed && { removed: true as const }),
        })),
        now
      );
      const rings = await ctx.onTerminal(
        tx,
        won.map(({ row }) => ({
          jobId: row.id,
          queue: row.queue,
          parentId: row.parent_id,
          outcome: 'completed' as const,
        })),
        now
      );
      const counts = new Map<string, number>();
      for (const { row } of won) counts.set(row.queue, (counts.get(row.queue) ?? 0) + 1);
      await recordMetrics(tx, ctx, 'completed', counts, now);
      return { done: won.map((entry) => entry.index), rings };
    })
  );
  done.forEach((index, position) => {
    answers[index] = { ok: true, rings: position === 0 ? rings : [] };
  });
  return answers;
}

/** Encodes the result before any connection is used, so one the codec or the size limit refuses fails the call alone. */
function encodeResult(ctx: StoreContext, jobId: string, result: unknown): Uint8Array {
  const shape = overShape(result, ctx.limits);
  if (shape) {
    throw new StoreError(
      `the result of job ${jobId} has ${shape.kind === 'nodes' ? `more than ${shape.limit} values` : `nesting deeper than ${shape.limit}`}`
    );
  }
  let encoded: Uint8Array;
  try {
    encoded = ctx.codec.encode(result === undefined ? null : result);
  } catch (error) {
    throw new StoreError(`the result of job ${jobId} cannot be encoded`, { cause: error });
  }
  if (encoded.byteLength > ctx.limits.maxPayloadBytes) {
    throw new StoreError(
      `the result of job ${jobId} is ${encoded.byteLength} bytes, over the limit of ${ctx.limits.maxPayloadBytes}`
    );
  }
  return encoded;
}
