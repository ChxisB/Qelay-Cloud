import type { AttemptRecord, DeliveryPolicy } from '@qelay-cloud/core';
import { resolveDeliveryPolicy, webhookRetryDelayMs } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';
import { appendHistory, boundedError, deliveryNumber, historyOf } from './webhookRows';
import type { AttemptOutcome, RecordSummary } from './webhookTypes';

interface SendingRow {
  readonly id: number | string | bigint;
  readonly attempts: number;
  readonly attempt_base: number;
  readonly history: unknown;
}

interface Settled {
  readonly id: number;
  readonly status: 'delivered' | 'pending' | 'failed';
  readonly nextAttemptAt: number;
  readonly finishedAt: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly history: AttemptRecord[];
}

/**
 * Takes back what the attempts came to. An outcome is applied only to a delivery that is still
 * `sending` and still on that attempt: after its lease lapsed and another claim took it, or after a
 * manual retry, the late result is dropped (`stale`) and the newer attempt owns the delivery. A
 * delivered attempt finishes it; a failed one is retried after `webhookRetryDelayMs`, or fails the
 * delivery once its attempts (since the last manual retry) reach `policy.maxAttempts`.
 */
export async function recordAttempts(
  ctx: StoreContext,
  outcomes: readonly AttemptOutcome[],
  policy: DeliveryPolicy
): Promise<RecordSummary> {
  const rules = resolveDeliveryPolicy(policy);
  if (outcomes.length === 0) return { delivered: 0, retrying: 0, failed: 0, stale: 0 };
  const numbers = outcomes.map((outcome) => deliveryNumber('deliveryId', outcome.deliveryId));
  const hookIds = [...new Set(outcomes.map((outcome) => outcome.webhookId))].sort();
  return ctx.db.run('recordWebhookAttempts', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // Webhook rows first, in id order, as the claim and retention take them.
      await tx`
        SELECT id FROM qcloud_webhooks
        WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(hookIds, 'TEXT')})
        ORDER BY id FOR NO KEY UPDATE`;
      const rows = await tx<SendingRow[]>`
        SELECT id, attempts, attempt_base, history FROM qcloud_webhook_deliveries
        WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(numbers, 'BIGINT')})
          AND status = 'sending'
        ORDER BY id FOR UPDATE`;
      const open = new Map(rows.map((row) => [Number(row.id), row]));
      const settled: Settled[] = [];
      const tally = new Map<string, { ok: number; failed: number }>();
      let stale = 0;
      outcomes.forEach((outcome, index) => {
        const number = numbers[index]!;
        const row = open.get(number);
        if (row === undefined || row.attempts !== outcome.attempt) {
          stale += 1;
          return;
        }
        open.delete(number);
        const used = row.attempts - row.attempt_base;
        const error = outcome.ok ? null : boundedError(outcome.error ?? 'delivery failed');
        const history = appendHistory(historyOf(row.history), {
          attempt: outcome.attempt,
          at: outcome.startedAt,
          durationMs: outcome.durationMs,
          statusCode: outcome.statusCode,
          error,
        });
        const counts = tally.get(outcome.webhookId) ?? { ok: 0, failed: 0 };
        tally.set(outcome.webhookId, counts);
        const base = { id: number, statusCode: outcome.statusCode, error, history };
        if (outcome.ok) {
          counts.ok += 1;
          settled.push({ ...base, status: 'delivered', nextAttemptAt: now, finishedAt: now });
        } else if (used >= rules.maxAttempts) {
          counts.failed += 1;
          settled.push({ ...base, status: 'failed', nextAttemptAt: now, finishedAt: now });
        } else {
          settled.push({
            ...base,
            status: 'pending',
            nextAttemptAt: now + webhookRetryDelayMs(used, rules),
            finishedAt: null,
          });
        }
      });
      if (settled.length > 0) {
        // One JSON document, not parallel arrays: `tx.array` writes a null element as the text "null".
        await tx`
          UPDATE qcloud_webhook_deliveries d
          SET status = c.status, next_attempt_at = c.next_attempt_at, finished_at = c.finished_at,
              last_status_code = c.status_code, last_error = c.error, history = c.history
          FROM jsonb_to_recordset(${JSON.stringify(
            settled.map((s) => ({
              id: s.id,
              status: s.status,
              next_attempt_at: s.nextAttemptAt,
              finished_at: s.finishedAt,
              status_code: s.statusCode,
              error: s.error,
              history: s.history,
            }))
          )}::text::jsonb) AS c(id bigint, status text, next_attempt_at bigint, finished_at bigint,
                          status_code integer, error text, history jsonb)
          WHERE d.id = c.id`;
        const counted = [...tally].filter(([, n]) => n.ok > 0 || n.failed > 0);
        if (counted.length > 0) {
          await tx`
            UPDATE qcloud_webhooks w
            SET success_count = w.success_count + c.ok, failure_count = w.failure_count + c.failed
            FROM unnest(${tx.array(
              counted.map(([id]) => id),
              'TEXT'
            )}, ${tx.array(
              counted.map(([, n]) => n.ok),
              'INTEGER'
            )}, ${tx.array(
              counted.map(([, n]) => n.failed),
              'INTEGER'
            )}) AS c(id, ok, failed)
            WHERE w.namespace = ${ctx.namespace} AND w.id = c.id`;
        }
      }
      return {
        delivered: settled.filter((s) => s.status === 'delivered').length,
        retrying: settled.filter((s) => s.status === 'pending').length,
        failed: settled.filter((s) => s.status === 'failed').length,
        stale,
      };
    })
  );
}
