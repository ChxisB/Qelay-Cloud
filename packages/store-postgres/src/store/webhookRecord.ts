import type { AttemptRecord, DeliveryPolicy } from '@qelay-cloud/core';
import { resolveDeliveryPolicy, webhookAlertLevel, webhookRetryDelayMs } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';
import {
  appendHistory,
  boundedError,
  boundedResponse,
  deliveryNumber,
  historyOf,
} from './webhookRows';
import type { AttemptOutcome, RecordSummary } from './webhookTypes';

interface SendingRow {
  readonly id: number | string | bigint;
  readonly attempts: number;
  readonly attempt_base: number;
  readonly history: unknown;
}

interface HookState {
  readonly id: string;
  readonly enabled: boolean;
  readonly consecutive_failures: number;
  readonly alert_level: number;
  readonly paused: boolean;
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
 *
 * A webhook's streak is its failed deliveries (attempts used up) in a row; a delivered one resets it.
 * It sets the webhook's `alert_level` (`webhookAlertLevel`) and, on reaching `policy.disableAfter`,
 * pauses it: `enabled` goes false with a `disabled_reason`, the sender stops claiming it, and
 * deliveries keep being written for it, waiting until it is enabled again.
 */
export async function recordAttempts(
  ctx: StoreContext,
  outcomes: readonly AttemptOutcome[],
  policy: DeliveryPolicy
): Promise<RecordSummary> {
  const rules = resolveDeliveryPolicy(policy);
  if (outcomes.length === 0) return { delivered: 0, retrying: 0, failed: 0, stale: 0, paused: 0 };
  const numbers = outcomes.map((outcome) => deliveryNumber('deliveryId', outcome.deliveryId));
  const hookIds = [...new Set(outcomes.map((outcome) => outcome.webhookId))].sort();
  return ctx.db.run('recordWebhookAttempts', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // Webhook rows first, in id order, as the claim and retention take them.
      const hooks = new Map(
        (
          await tx<HookState[]>`
            SELECT id, enabled, consecutive_failures, alert_level, disabled_reason IS NOT NULL AS paused
            FROM qcloud_webhooks
            WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(hookIds, 'TEXT')})
            ORDER BY id FOR NO KEY UPDATE`
        ).map((hook) => [hook.id, hook])
      );
      const rows = await tx<SendingRow[]>`
        SELECT id, attempts, attempt_base, history FROM qcloud_deliveries
        WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(numbers, 'BIGINT')})
          AND status = 'sending'
        ORDER BY id FOR UPDATE`;
      const open = new Map(rows.map((row) => [Number(row.id), row]));
      const settled: Settled[] = [];
      // Final outcomes per webhook, in order: true delivered, false exhausted.
      const tally = new Map<string, { ok: number; failed: number; runs: boolean[] }>();
      let stale = 0;
      let paused = 0;
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
        const response = outcome.ok ? null : boundedResponse(outcome.response);
        const history = appendHistory(historyOf(row.history), {
          attempt: outcome.attempt,
          at: outcome.startedAt,
          durationMs: outcome.durationMs,
          statusCode: outcome.statusCode,
          error,
          ...(response === null ? {} : { response }),
        });
        const counts = tally.get(outcome.webhookId) ?? { ok: 0, failed: 0, runs: [] };
        tally.set(outcome.webhookId, counts);
        const base = { id: number, statusCode: outcome.statusCode, error, history };
        if (outcome.ok) {
          counts.ok += 1;
          counts.runs.push(true);
          settled.push({ ...base, status: 'delivered', nextAttemptAt: now, finishedAt: now });
        } else if (used >= rules.maxAttempts) {
          counts.failed += 1;
          counts.runs.push(false);
          settled.push({ ...base, status: 'failed', nextAttemptAt: now, finishedAt: now });
        } else {
          settled.push({
            ...base,
            status: 'pending',
            nextAttemptAt: now + webhookRetryDelayMs(used, rules, ctx.backoff.random),
            finishedAt: null,
          });
        }
      });
      if (settled.length > 0) {
        // One JSON document, not parallel arrays: `tx.array` writes a null element as the text "null".
        await tx`
          UPDATE qcloud_deliveries d
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
        const counted = [...tally].filter(([, n]) => n.runs.length > 0);
        if (counted.length > 0) {
          const next = counted.map(([id, n]) =>
            streakOf(hooks.get(id), n.runs, rules.disableAfter)
          );
          await tx`
            UPDATE qcloud_webhooks w
            SET success_count = w.success_count + c.ok, failure_count = w.failure_count + c.failed,
                consecutive_failures = c.streak, alert_level = c.level,
                enabled = w.enabled AND c.pause = 0,
                disabled_reason = CASE WHEN c.pause = 1
                  THEN c.streak::text || ' failed deliveries in a row' ELSE w.disabled_reason END,
                disabled_at = CASE WHEN c.pause = 1 THEN ${now}::bigint ELSE w.disabled_at END
            FROM unnest(${tx.array(
              counted.map(([id]) => id),
              'TEXT'
            )}, ${tx.array(
              counted.map(([, n]) => n.ok),
              'INTEGER'
            )}, ${tx.array(
              counted.map(([, n]) => n.failed),
              'INTEGER'
            )}, ${tx.array(
              next.map((n) => n.streak),
              'INTEGER'
            )}, ${tx.array(
              next.map((n) => n.level),
              'INTEGER'
            )}, ${tx.array(
              next.map((n) => (n.pause ? 1 : 0)),
              'INTEGER'
            )}) AS c(id, ok, failed, streak, level, pause)
            WHERE w.namespace = ${ctx.namespace} AND w.id = c.id`;
          paused = next.filter((n) => n.pause).length;
        }
      }
      return {
        delivered: settled.filter((s) => s.status === 'delivered').length,
        retrying: settled.filter((s) => s.status === 'pending').length,
        failed: settled.filter((s) => s.status === 'failed').length,
        stale,
        paused,
      };
    })
  );
}

/** The streak after `runs`, its alert level, and whether it pauses the webhook now. A paused webhook keeps its state. */
function streakOf(
  hook: HookState | undefined,
  runs: readonly boolean[],
  disableAfter: number
): { streak: number; level: number; pause: boolean } {
  const before = hook?.consecutive_failures ?? 0;
  if (hook === undefined || hook.paused)
    return { streak: before, level: hook?.alert_level ?? 0, pause: false };
  const streak = runs.reduce((n, ok) => (ok ? 0 : n + 1), before);
  const pause = disableAfter > 0 && streak >= disableAfter && hook.enabled;
  return { streak, level: webhookAlertLevel(streak, disableAfter), pause };
}
