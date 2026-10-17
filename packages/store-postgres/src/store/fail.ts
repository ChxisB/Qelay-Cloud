import type { FailureInfo, Lease, Outcome } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { enforceDlqLimit } from './dlq';
import { lockHeldJob } from './jobRow';
import { isWellFormedLease } from './leaseRules';
import { recordMetrics } from './metrics';
import { policyReader } from './policies';
import { runTransaction } from './retry';
import { cleanText, MAX_MESSAGE_CHARS, MAX_STACK_CHARS } from './retryState';
import { retryStateOf, settleAttempt } from './settle';

const LOST: Outcome = { ok: false, rings: [] };

/**
 * Ends the attempt the lease holds without success. Adapted from Qelay's `outcomes.ts` (see
 * docs/PORTING.md). One transaction: lock the row, check the fence, count the attempt, then either
 * retry it after the job's backoff (`attempts < max_attempts` and not `unrecoverable`) or write its
 * DLQ entry; journal the event, run the terminal hook for a last attempt, enforce the queue's DLQ
 * limit, count a `failed` metric for a last attempt. A retry returns the ring for the job.
 *
 * The reason recorded is `explicit_fail` for a worker's own report, including an unrecoverable one
 * (upstream would say `max_attempts_exceeded` for it), and `max_attempts_exceeded` only when the
 * attempts ran out. A lease that was lost returns `{ ok: false }` and changes nothing.
 */
export async function failJob(
  ctx: StoreContext,
  lease: Lease,
  info: FailureInfo
): Promise<Outcome> {
  if (!isWellFormedLease(lease)) return LOST;
  const message = cleanText(info?.message, MAX_MESSAGE_CHARS);
  const stack =
    typeof info?.stack === 'string' ? cleanText(info.stack, MAX_STACK_CHARS) : undefined;
  const unrecoverable = info?.unrecoverable === true;
  return ctx.db.run('fail', (sql) =>
    runTransaction(sql, async (tx) => {
      const held = await lockHeldJob(tx, ctx, lease);
      if (!held) return LOST;
      const { row, now } = held;
      const attempts = row.attempts + 1;
      const retry = !unrecoverable && attempts < row.max_attempts;
      const settled = await settleAttempt(
        tx,
        ctx,
        {
          row,
          now,
          attempts,
          prior: retryStateOf(ctx, row),
          retry,
          reason: retry || unrecoverable ? 'explicit_fail' : 'max_attempts_exceeded',
          stalled: false,
          message,
          ...(stack !== undefined && { stack }),
        },
        policyReader(tx, ctx)
      );
      await ctx.recorder.record(tx, [settled.event], now);
      if (settled.outcome === 'retried') {
        return { ok: true, rings: settled.ring === null ? [] : [settled.ring] };
      }
      const rings = await ctx.onTerminal(
        tx,
        [
          {
            jobId: row.id,
            queue: row.queue,
            parentId: row.parent_id,
            outcome: 'failed',
            error: message,
          },
        ],
        now
      );
      if (settled.dlqMaxEntries !== null) {
        await enforceDlqLimit(tx, ctx, row.queue, settled.dlqMaxEntries, now);
      }
      await recordMetrics(tx, ctx, 'failed', new Map([[row.queue, 1]]), now);
      return { ok: true, rings };
    })
  );
}
