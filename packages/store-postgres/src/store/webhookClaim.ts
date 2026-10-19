import { openSecret, UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';
import { appendHistory, historyOf } from './webhookRows';
import { secretContext } from './webhooks';
import type { ClaimedDelivery, ClaimOptions } from './webhookTypes';

/**
 * The sending side of webhooks: what the maintenance tick calls around its HTTP requests. The store
 * does no network I/O; it hands out deliveries (`claimDueDeliveries`) and takes back what became of
 * them (`recordAttempts`, in `webhookRecord.ts`).
 *
 * A claim takes each webhook's row `FOR NO KEY UPDATE SKIP LOCKED`, so two claims never work on one
 * webhook at once and a delivery goes out in at most one attempt at a time (the lease, `next_attempt_at`
 * of a `sending` row, is what lets another claim take it again after a crash). `NO KEY UPDATE` and not
 * `UPDATE`: the trigger that creates deliveries takes `KEY SHARE` on the webhook, and that must not wait
 * for a claim, or a slow tick would stall every job push. Rows are always locked webhook first, delivery
 * second (here, in `recordAttempts` and in retention), so no two of them can deadlock.
 */

/** The fixed window the per-webhook rate limit counts in. */
export const RATE_WINDOW_MS = 60_000;

export const ABANDONED_ERROR = 'attempt abandoned: no result was recorded';

interface HookRow {
  readonly id: string;
  readonly url: string;
  readonly secret_sealed: string | null;
  readonly secret_previous_sealed: string | null;
  readonly secret_previous_until: number | string | bigint | null;
  readonly allowance: number | string;
}

interface DueRow {
  readonly id: number | string | bigint;
  readonly webhook_id: string;
  readonly event_id: number | string | bigint | null;
  readonly event_name: string;
  readonly queue: string;
  readonly job_id: string;
  readonly occurred_at: number | string | bigint;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: number | string | bigint;
  readonly history: unknown;
  readonly body: string | null;
}

interface Claimed {
  readonly now: number;
  readonly hooks: ReadonlyMap<string, HookRow>;
  readonly rows: readonly DueRow[];
  readonly attempts: ReadonlyMap<string, number>;
  readonly journal: ReadonlyMap<string, { state?: string; error?: string; progress?: number }>;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(name, 'must be a positive integer');
  }
  return value;
}

/**
 * Takes up to `limit` due deliveries, at most `ratePerMinute` per webhook in a fixed minute, oldest
 * first and fairly between webhooks (see `roundRobin`), and marks each `sending` with a lease of
 * `leaseMs`. A delivery whose lease lapsed with no result (the sender died, or hung) is taken again, with the lost attempt noted in its history; it
 * counts against the delivery's attempts. Only enabled webhooks are served.
 */
export async function claimDueDeliveries(
  ctx: StoreContext,
  options: ClaimOptions
): Promise<ClaimedDelivery[]> {
  const limit = positive('limit', options.limit);
  const leaseMs = positive('leaseMs', options.leaseMs);
  const rate = positive('ratePerMinute', options.ratePerMinute);
  const claimed = await ctx.db.run('claimWebhookDeliveries', (sql) =>
    runTransaction(sql, async (tx): Promise<Claimed | null> => {
      const now = await ctx.db.time.now(tx);
      const windowStart = now - (now % RATE_WINDOW_MS);
      // Webhooks with something due, least recently served first, so a busy one does not hide the rest.
      const hooks = await tx<HookRow[]>`
        SELECT w.id, w.url, w.secret_sealed, w.secret_previous_sealed, w.secret_previous_until,
               ${rate}::int - CASE WHEN w.rate_window_start = ${windowStart}
                                   THEN w.rate_window_count ELSE 0 END AS allowance
        FROM qcloud_webhooks w
        WHERE w.namespace = ${ctx.namespace} AND w.enabled
          AND EXISTS (
            SELECT 1 FROM qcloud_deliveries d
            WHERE d.namespace = ${ctx.namespace} AND d.webhook_id = w.id
              AND d.status IN ('pending', 'sending') AND d.next_attempt_at <= ${now})
        ORDER BY w.last_triggered NULLS FIRST, w.id
        LIMIT ${limit}
        FOR NO KEY UPDATE OF w SKIP LOCKED`;
      const open = hooks.filter((hook) => Number(hook.allowance) > 0);
      if (open.length === 0) return null;
      const found = await tx<DueRow[]>`
        SELECT d.id, d.webhook_id, d.event_id, d.event_name, d.queue, d.job_id, d.occurred_at,
               d.status, d.attempts, d.next_attempt_at, d.history, d.body
        FROM unnest(${tx.array(
          open.map((hook) => hook.id),
          'TEXT'
        )}, ${tx.array(
          open.map((hook) => Math.min(Number(hook.allowance), limit)),
          'INTEGER'
        )}) AS h(id, allowance)
        CROSS JOIN LATERAL (
          SELECT x.* FROM qcloud_deliveries x
          WHERE x.namespace = ${ctx.namespace} AND x.webhook_id = h.id
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at <= ${now}
          ORDER BY x.next_attempt_at, x.id
          LIMIT h.allowance
          FOR UPDATE OF x SKIP LOCKED
        ) d`;
      const rows = roundRobin(found, limit);
      if (rows.length === 0) return null;

      const histories = rows.map((row) =>
        JSON.stringify(
          row.status === 'sending'
            ? appendHistory(historyOf(row.history), {
                attempt: row.attempts,
                at: now,
                durationMs: 0,
                statusCode: null,
                error: ABANDONED_ERROR,
              })
            : historyOf(row.history)
        )
      );
      await tx`
        UPDATE qcloud_deliveries d
        SET status = 'sending', attempts = d.attempts + 1, next_attempt_at = ${now + leaseMs},
            history = c.history::jsonb
        FROM unnest(${tx.array(
          rows.map((row) => Number(row.id)),
          'BIGINT'
        )}, ${tx.array(histories, 'TEXT')}) AS c(id, history)
        WHERE d.id = c.id`;

      const perHook = new Map<string, number>();
      for (const row of rows) perHook.set(row.webhook_id, (perHook.get(row.webhook_id) ?? 0) + 1);
      await tx`
        UPDATE qcloud_webhooks w
        SET rate_window_count = (CASE WHEN w.rate_window_start = ${windowStart}
                                      THEN w.rate_window_count ELSE 0 END) + c.n,
            rate_window_start = ${windowStart}, last_triggered = ${now}
        FROM unnest(${tx.array([...perHook.keys()], 'TEXT')}, ${tx.array(
          [...perHook.values()],
          'INTEGER'
        )}) AS c(id, n)
        WHERE w.namespace = ${ctx.namespace} AND w.id = c.id`;

      // A shaped delivery carries its own body: its event's detail is not read.
      const eventIds = rows.flatMap((row) =>
        row.event_id === null || row.body !== null ? [] : [Number(row.event_id)]
      );
      const events =
        eventIds.length === 0
          ? []
          : await tx<Array<{ id: number | string | bigint; payload: Uint8Array | null }>>`
              SELECT id, payload FROM qcloud_events
              WHERE namespace = ${ctx.namespace} AND id = ANY(${tx.array(eventIds, 'BIGINT')})`;
      const journal = new Map<string, { state?: string; error?: string; progress?: number }>();
      for (const event of events) {
        try {
          const payload = ctx.codec.decode(event.payload ?? new Uint8Array()) as {
            state?: string;
            error?: string;
            progress?: number;
          } | null;
          if (payload) journal.set(String(event.id), payload);
        } catch {
          // An event the journal cannot read is delivered without its detail.
        }
      }
      return {
        now,
        hooks: new Map(open.map((hook) => [hook.id, hook])),
        rows,
        attempts: new Map(rows.map((row) => [String(row.id), row.attempts + 1])),
        journal,
      };
    })
  );
  if (claimed === null) return [];

  // Opening a secret is CPU work, not a reason to hold the claim's transaction open.
  const secrets = new Map<
    string,
    { secret: string | null; previous: string | null; unreadable: boolean }
  >();
  const open = (sealed: string, id: string): Promise<string | null> =>
    ctx.webhookKey === null
      ? Promise.resolve(null)
      : openSecret(sealed, ctx.webhookKey, secretContext(ctx.namespace, id));
  for (const [id, hook] of claimed.hooks) {
    if (hook.secret_sealed === null) {
      secrets.set(id, { secret: null, previous: null, unreadable: false });
      continue;
    }
    const opened = await open(hook.secret_sealed, id);
    // A secret past its grace is not used, and one that does not open is left out: the new one still signs.
    const previous =
      hook.secret_previous_sealed !== null && Number(hook.secret_previous_until) > claimed.now
        ? await open(hook.secret_previous_sealed, id)
        : null;
    secrets.set(id, { secret: opened, previous, unreadable: opened === null });
  }
  return claimed.rows.map((row): ClaimedDelivery => {
    const detail = row.event_id === null ? undefined : claimed.journal.get(String(row.event_id));
    const secret = secrets.get(row.webhook_id)!;
    return {
      deliveryId: String(row.id),
      webhookId: row.webhook_id,
      url: claimed.hooks.get(row.webhook_id)!.url,
      attempt: claimed.attempts.get(String(row.id))!,
      event: row.event_name as ClaimedDelivery['event'],
      queue: row.queue,
      jobId: row.job_id,
      occurredAt: Number(row.occurred_at),
      state: detail?.state ?? null,
      error: detail?.error ?? null,
      progress: detail?.progress ?? null,
      body: row.body,
      secret: secret.secret,
      previousSecret: secret.previous,
      secretUnreadable: secret.unreadable,
    };
  });
}

/**
 * At most `limit` of the claimed rows: the oldest of each webhook first, then the second oldest of
 * each, and so on, so a webhook with a backlog does not take every slot from one with a single
 * delivery waiting. Within a round, oldest first.
 */
function roundRobin(found: readonly DueRow[], limit: number): DueRow[] {
  const byAge = [...found].sort(
    (a, b) => Number(a.next_attempt_at) - Number(b.next_attempt_at) || Number(a.id) - Number(b.id)
  );
  const seen = new Map<string, number>();
  const ranked = byAge.map((row) => {
    const rank = seen.get(row.webhook_id) ?? 0;
    seen.set(row.webhook_id, rank + 1);
    return { row, rank };
  });
  // `sort` is stable, so within a rank the age order above stands.
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map(({ row }) => row);
}
