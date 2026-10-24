import { openSecret, UnsupportedOptionError } from '@qelay-cloud/core';
import type { WebhookDestination } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { runTransaction } from './retry';
import { roundRobin } from './webhookClaimOrder';
import { readRequests } from './webhookClaimRequests';
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
 * `UPDATE`: the accept that creates deliveries takes `KEY SHARE` on the webhook, and that must not wait
 * for a claim, or a slow tick would stall a request being taken. Rows are always locked webhook first, delivery
 * second (here, in `recordAttempts` and in retention), so no two of them can deadlock.
 *
 * A route with a batch (D15) is served as one unit: a claim takes up to `maxEvents` of its due deliveries, stopping before
 * `maxBytes` of body is passed (the first one always goes), and they count as ONE request toward the claim's `limit` and the
 * route's rate. The sender sends them together (`ClaimedDelivery.batched`). One claim takes at most one batch of a route; a
 * backlog is taken batch by batch, by the claims that follow.
 */

/** The fixed window the per-webhook rate limit counts in. */
export const RATE_WINDOW_MS = 60_000;

export const ABANDONED_ERROR = 'attempt abandoned: no result was recorded';

interface HookRow {
  readonly id: string;
  readonly url: string;
  readonly destination: WebhookDestination;
  readonly target: string | null;
  readonly secret_sealed: string | null;
  readonly secret_previous_sealed: string | null;
  readonly secret_previous_until: number | string | bigint | null;
  readonly allowance: number | string;
  readonly batch_max_events: number | null;
  readonly batch_max_bytes: number | null;
}

interface DueRow {
  readonly id: number | string | bigint;
  readonly webhook_id: string;
  readonly event_name: string;
  readonly occurred_at: number | string | bigint;
  readonly status: string;
  readonly attempts: number;
  readonly next_attempt_at: number | string | bigint;
  readonly history: unknown;
  readonly body: string | null;
  readonly request_id: number | string | bigint | null;
  readonly size: number | string;
}

interface Claimed {
  readonly now: number;
  readonly hooks: ReadonlyMap<string, HookRow>;
  readonly rows: readonly DueRow[];
  readonly attempts: ReadonlyMap<string, number>;
  readonly requests: ReadonlyMap<string, { contentType: string | null; body: Uint8Array }>;
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
        SELECT w.id, w.url, w.destination, w.target, w.secret_sealed, w.secret_previous_sealed, w.secret_previous_until,
               w.batch_max_events, w.batch_max_bytes,
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
      // A plain route takes as many deliveries as its rate allows; a batch route takes its `maxEvents`, which is one request.
      const takes = open.map((hook) =>
        hook.batch_max_events === null
          ? Math.min(Number(hook.allowance), limit)
          : hook.batch_max_events
      );
      const found = await tx<DueRow[]>`
        SELECT d.id, d.webhook_id, d.event_name, d.occurred_at,
               d.status, d.attempts, d.next_attempt_at, d.history, d.body, d.request_id, d.size
        FROM unnest(${tx.array(
          open.map((hook) => hook.id),
          'TEXT'
        )}, ${tx.array(takes, 'INTEGER')}, ${tx.array(
          open.map((hook) => (hook.batch_max_events === null ? 0 : 1)),
          'INTEGER'
        )}) AS h(id, take, batched)
        CROSS JOIN LATERAL (
          SELECT x.*,
                 CASE WHEN h.batched = 1
                      THEN COALESCE(octet_length(x.body),
                                    (SELECT octet_length(r.body) FROM qcloud_requests r
                                     WHERE r.namespace = ${ctx.namespace} AND r.id = x.request_id), 0)
                      ELSE 0 END AS size
          FROM qcloud_deliveries x
          WHERE x.namespace = ${ctx.namespace} AND x.webhook_id = h.id
            AND x.status IN ('pending', 'sending') AND x.next_attempt_at <= ${now}
          ORDER BY x.next_attempt_at, x.id
          LIMIT h.take
          FOR UPDATE OF x SKIP LOCKED
        ) d`;
      const batches = new Map(
        open.flatMap((hook) =>
          hook.batch_max_bytes === null ? [] : [[hook.id, hook.batch_max_bytes] as const]
        )
      );
      const rows = roundRobin(found, limit, batches);
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

      // A batch is one request toward the rate however many deliveries it holds.
      const perHook = new Map<string, number>();
      for (const row of rows) {
        perHook.set(
          row.webhook_id,
          batches.has(row.webhook_id) ? 1 : (perHook.get(row.webhook_id) ?? 0) + 1
        );
      }
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

      // A request delivery with no shaped body sends the request's own bytes.
      const requests = await readRequests(
        tx,
        ctx.namespace,
        rows.flatMap((row) =>
          row.request_id === null || row.body !== null ? [] : [row.request_id]
        )
      );
      return {
        now,
        hooks: new Map(open.map((hook) => [hook.id, hook])),
        rows,
        attempts: new Map(rows.map((row) => [String(row.id), row.attempts + 1])),
        requests,
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
    const secret = secrets.get(row.webhook_id)!;
    return {
      deliveryId: String(row.id),
      webhookId: row.webhook_id,
      url: claimed.hooks.get(row.webhook_id)!.url,
      destination: claimed.hooks.get(row.webhook_id)!.destination,
      target: claimed.hooks.get(row.webhook_id)!.target,
      attempt: claimed.attempts.get(String(row.id))!,
      event: row.event_name as ClaimedDelivery['event'],
      occurredAt: Number(row.occurred_at),
      body: row.body,
      ...(claimed.hooks.get(row.webhook_id)!.batch_max_events === null ? {} : { batched: true }),
      requestId: row.request_id === null ? null : String(row.request_id),
      requestBody: claimed.requests.get(String(row.request_id))?.body ?? null,
      requestContentType: claimed.requests.get(String(row.request_id))?.contentType ?? null,
      secret: secret.secret,
      previousSecret: secret.previous,
      secretUnreadable: secret.unreadable,
    };
  });
}
