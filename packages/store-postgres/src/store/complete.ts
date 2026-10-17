import type { Lease, Outcome } from '@qelay-cloud/core';
import { StoreError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { lockHeldJob } from './jobRow';
import { isWellFormedLease } from './leaseRules';
import { recordMetrics } from './metrics';
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

/** Encodes the result before any connection is used, so one the codec or the size limit refuses fails the call alone. */
function encodeResult(ctx: StoreContext, jobId: string, result: unknown): Uint8Array {
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
