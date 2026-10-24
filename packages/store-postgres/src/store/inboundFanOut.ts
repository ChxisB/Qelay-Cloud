import { createHash } from 'node:crypto';
import type { WebhookDedupe, WebhookFilter, WebhookShape } from '@qelay-cloud/core';
import { dedupeValues, matchesFilter, renderShape, WEBHOOK_REQUEST_EVENT } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { jsonOrNull } from './webhookRows';
import { nextFire } from './webhookSchedule';

/**
 * The fan-out of a stored request (DESIGN.md D14): one delivery for each enabled route of its source, made in the
 * transaction that stores the request (`inboundAccept.ts`) or replays it (`inboundRequests.ts`).
 */

type Time = number | string | bigint;
type Document = Parameters<typeof dedupeValues>[1];

interface RouteRow {
  readonly id: string;
  readonly filter: unknown;
  readonly shape: unknown;
  readonly delay_ms: Time | null;
  readonly dedupe: unknown;
  readonly schedule_cron: string | null;
  readonly schedule_timezone: string | null;
}

/** One delivery to make. `a`: when it is due. `x` set: it is recorded as failed, with an empty body. */
interface Planned {
  readonly w: string;
  readonly a: number;
  readonly b: string | null;
  readonly x: string | null;
}

/**
 * When a route's delivery is due: the request time plus the delay, moved to the first fire of the route's schedule at or
 * after it (D15). A schedule the parser cannot read now, or that has no next fire, is not a reason to lose or hold the
 * event for good: it is due at once, as it would be without a schedule. A route is checked when it is saved, so this is
 * a zone database that dropped a name, not an input.
 */
function dueAt(route: RouteRow, now: number): number {
  const due = now + Number(route.delay_ms ?? 0);
  if (route.schedule_cron === null || route.schedule_timezone === null) return due;
  try {
    const fire = nextFire({ cron: route.schedule_cron, timezone: route.schedule_timezone }, due);
    return fire === 0 ? due : fire;
  } catch {
    return due;
  }
}

/** What two requests must share to be the same, as a key for the route's dedupe window. */
const keyOf = (dedupe: WebhookDedupe, document: Document): string =>
  createHash('sha256').update(dedupeValues(dedupe.fields, document)).digest('hex');

/**
 * Opens the route's dedupe window for this key, or finds it still open. One atomic upsert: of any number of requests with
 * the same key arriving at once, on any number of ingest processes, the row lock makes the later ones wait for the first,
 * see its window and get no row back. A rolled-back accept rolls the window back with it.
 */
async function opensWindow(
  tx: TransactionSQL,
  ctx: StoreContext,
  route: string,
  key: string,
  until: number,
  now: number
): Promise<boolean> {
  const rows = await tx<Array<{ key: string }>>`
    INSERT INTO qcloud_webhook_dedupe (namespace, webhook_id, key, until)
    VALUES (${ctx.namespace}, ${route}, ${key}, ${until})
    ON CONFLICT (namespace, webhook_id, key) DO UPDATE SET until = EXCLUDED.until
    WHERE qcloud_webhook_dedupe.until <= ${now}
    RETURNING key`;
  return rows.length > 0;
}

/**
 * Makes the deliveries of one request. Per enabled route, in this order: the filter, the dedupe, the shape (no shape: the
 * delivery carries no body of its own and the sender sends the request's), then the delay. A route paused by an operator
 * with `hold`, or for failing, still gets its deliveries, which wait. The delay is followed by the route's schedule, if
 * it has one (`dueAt`). `dedupe: false` (a replay, which an operator asked
 * for) skips the dedupe and leaves its windows alone. Returns how many routes the source has and how many deliveries were made.
 */
export async function fanOut(
  tx: TransactionSQL,
  ctx: StoreContext,
  at: {
    readonly source: string;
    readonly requestId: string;
    readonly now: number;
    readonly document: Document;
    readonly dedupe: boolean;
  }
): Promise<{ routes: number; deliveries: number }> {
  const { source, now, document } = at;
  // KEY SHARE, like the sender's: a route being deleted is waited for and then skipped.
  const routes = await tx<RouteRow[]>`
    SELECT id, filter, shape, delay_ms, dedupe, schedule_cron, schedule_timezone FROM qcloud_webhooks
    WHERE namespace = ${ctx.namespace} AND source_id = ${source} AND (enabled OR disabled_reason IS NOT NULL)
    ORDER BY id FOR KEY SHARE`;
  const planned: Planned[] = [];
  // Routes in id order, so two requests that dedupe on several routes take the window rows in the same order.
  for (const route of routes) {
    const filter = jsonOrNull<WebhookFilter>(route.filter);
    if (filter !== null && !matchesFilter(filter, document)) continue;
    const dedupe = jsonOrNull<WebhookDedupe>(route.dedupe);
    if (
      at.dedupe &&
      dedupe !== null &&
      !(await opensWindow(tx, ctx, route.id, keyOf(dedupe, document), now + dedupe.windowMs, now))
    ) {
      continue;
    }
    const shape = jsonOrNull<WebhookShape>(route.shape);
    const rendered = shape === null ? null : renderShape(shape, document);
    planned.push({
      w: route.id,
      a: dueAt(route, now),
      b: rendered === null ? null : rendered.ok ? rendered.body : '',
      x: rendered !== null && !rendered.ok ? rendered.error : null,
    });
  }
  const deliveries = planned.length === 0 ? 0 : await insertDeliveries(tx, ctx, planned, at);
  return { routes: routes.length, deliveries };
}

/** Inserts in route order (the ids, the tie-break of the send order, follow it); a delivery that exists is left alone. */
async function insertDeliveries(
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly Planned[],
  at: { readonly requestId: string; readonly now: number }
): Promise<number> {
  const made = await tx<Array<{ id: Time }>>`
    INSERT INTO qcloud_deliveries
      (namespace, webhook_id, event_id, request_id, event_name, occurred_at, status,
       next_attempt_at, created_at, body, last_error, finished_at)
    SELECT ${ctx.namespace}::text, r.v->>'w', NULL, ${at.requestId}::bigint, ${WEBHOOK_REQUEST_EVENT}::text,
           ${at.now}::bigint,
           CASE WHEN r.v->>'x' IS NULL THEN 'pending' ELSE 'failed' END,
           (r.v->>'a')::bigint, ${at.now}::bigint, r.v->>'b', r.v->>'x',
           CASE WHEN r.v->>'x' IS NULL THEN NULL ELSE ${at.now}::bigint END
    FROM jsonb_array_elements(${JSON.stringify(rows)}::text::jsonb) WITH ORDINALITY AS r(v, ord)
    ORDER BY r.ord
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return made.length;
}
