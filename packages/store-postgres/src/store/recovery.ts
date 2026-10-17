import type { Ring } from '@qelay-cloud/core';
import type { StoreContext, TerminalChange } from './context';
import { enforceDlqLimit } from './dlq';
import type { StoreEvent } from './events';
import type { HeldRow } from './jobRow';
import { HELD_COLUMNS } from './jobRow';
import { processingDeadline } from './leaseRules';
import { recordMetrics } from './metrics';
import { policyReader } from './policies';
import { runTransaction } from './retry';
import type { FailureReason } from './retryState';
import { retryStateOf, settleAttempt } from './settle';

/** Most expired leases one pass takes, when the caller names no other number. */
export const DEFAULT_RECOVERY_LIMIT = 100;

export interface RecoveryReport {
  /** Jobs whose lease had expired and that were retried or moved to the DLQ. */
  readonly recovered: number;
  /** The bells for the retried jobs whose backoff fits the transport's window. */
  readonly rings: readonly Ring[];
  /** More expired leases were found than the limit: another pass has work. */
  readonly more: boolean;
}

/**
 * Recovers jobs whose lease expired: a worker that crashed, hung or lost its connection. Adapted
 * from Qelay's `recovery.ts` (see docs/PORTING.md). This is the tick's work (task 15) and nothing
 * else's: a later doorbell claims nothing while a dead worker's row is `active`.
 *
 * Each expired job counts an attempt, then goes through the same step as a failure reported by a
 * worker: retried after its backoff with `rung_at` cleared, or, when the attempts are spent, written
 * to the DLQ. A lease past the job's processing deadline is a `timeout`; one that expired before it
 * is a stall, and a job whose stalls reach the queue's `maxStalls` goes to the DLQ even with
 * attempts left (a timeout is not a stall). The rows are taken `FOR UPDATE SKIP LOCKED` in
 * `lease_until` order, so concurrent passes (and a `fail` or `complete` in flight) never process
 * the same job twice; a job whose lease is still valid is never touched.
 *
 * Worst case from a crash to the job running again: the lease, plus up to one tick interval to
 * notice it, plus the backoff, plus up to one more interval for the tick to ring a job whose
 * backoff did not fit the window (lease + 2 tick intervals when the backoff is within one).
 */
export async function recoverExpired(
  ctx: StoreContext,
  limit: number = DEFAULT_RECOVERY_LIMIT
): Promise<RecoveryReport> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('recoverExpired', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const found = await tx<HeldRow[]>`
        SELECT ${tx.unsafe(HELD_COLUMNS)} FROM qcloud_jobs
        WHERE namespace = ${ctx.namespace} AND state = 'active' AND lease_until <= ${now}
        ORDER BY lease_until, id
        LIMIT ${cap + 1}
        FOR UPDATE SKIP LOCKED`;
      const rows = found.slice(0, cap);
      const policyOf = policyReader(tx, ctx);
      const events: StoreEvent[] = [];
      const terminal: TerminalChange[] = [];
      const rings: Ring[] = [];
      const failed = new Map<string, number>();
      const dlqLimits = new Map<string, number>();
      for (const row of rows) {
        const deadline = processingDeadline(
          row.timeout === null ? null : Number(row.timeout),
          Number(row.started_at ?? 0)
        );
        const timedOut = deadline !== null && deadline <= now;
        const prior = retryStateOf(ctx, row);
        const attempts = row.attempts + 1;
        const stalls = prior.stalls + (timedOut ? 0 : 1);
        const { maxStalls } = await policyOf(row.queue);
        const attemptsSpent = attempts >= row.max_attempts;
        const stallsSpent = !timedOut && maxStalls > 0 && stalls >= maxStalls;
        const reason: FailureReason = timedOut
          ? 'timeout'
          : attemptsSpent
            ? 'max_attempts_exceeded'
            : 'stalled';
        const settled = await settleAttempt(
          tx,
          ctx,
          {
            row,
            now,
            attempts,
            prior,
            retry: !attemptsSpent && !stallsSpent,
            reason,
            stalled: !timedOut,
            message: timedOut ? 'Job processing timed out' : 'Job lease expired',
          },
          policyOf
        );
        events.push(settled.event);
        if (settled.outcome === 'retried') {
          if (settled.ring) rings.push(settled.ring);
          continue;
        }
        terminal.push({
          jobId: row.id,
          queue: row.queue,
          parentId: row.parent_id,
          outcome: 'failed',
          error: timedOut ? 'Job processing timed out' : 'Job lease expired',
        });
        failed.set(row.queue, (failed.get(row.queue) ?? 0) + 1);
        if (settled.dlqMaxEntries !== null) dlqLimits.set(row.queue, settled.dlqMaxEntries);
      }
      if (events.length > 0) await ctx.recorder.record(tx, events, now);
      if (terminal.length > 0) rings.push(...(await ctx.onTerminal(tx, terminal, now)));
      for (const queue of [...dlqLimits.keys()].sort()) {
        await enforceDlqLimit(tx, ctx, queue, dlqLimits.get(queue)!, now);
      }
      await recordMetrics(tx, ctx, 'failed', failed, now);
      return { recovered: rows.length, rings, more: found.length > cap };
    })
  );
}
