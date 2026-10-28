import type { WebhookDestination } from '@qelay-cloud/core';
import { requestDocument, UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { fanOut } from './inboundFanOut';
import type {
  ReplayResult,
  RequestDetail,
  RequestPage,
  RequestQuery,
  RequestSummary,
} from './inboundTypes';
import { identifier } from './prepare';
import { runTransaction } from './retry';
import { DEFAULT_DELIVERY_PAGE, MAX_DELIVERY_PAGE } from './webhookHistory';
import type { DeliveryRow } from './webhookRows';
import { deliveryOf } from './webhookRows';

/** The operator's side of stored requests (migration 20, D12): the list, one request whole, and a replay. */

type Time = number | string | bigint;
type Pairs = Readonly<Record<string, string>>;

interface RequestRow {
  readonly id: Time;
  readonly source_id: string;
  readonly received_at: Time;
  readonly method: string;
  readonly content_type: string | null;
  readonly status: string;
  readonly cause: string | null;
  readonly body_bytes: Time | null;
}

const SUMMARY = `id, source_id, received_at, method, content_type, status, cause, octet_length(body) AS body_bytes`;

const summaryOf = (row: RequestRow): RequestSummary => ({
  id: String(row.id),
  sourceId: row.source_id,
  receivedAt: Number(row.received_at),
  method: row.method,
  contentType: row.content_type,
  status: row.status as RequestSummary['status'],
  cause: row.cause,
  bodyBytes: row.body_bytes === null ? null : Number(row.body_bytes),
});

/** A request id from a caller, as the number it stands for; anything else is refused by name. */
function requestNumber(name: string, value: string): number {
  if (!/^[1-9]\d{0,15}$/u.test(value))
    throw new UnsupportedOptionError(name, 'must be a request id');
  return Number(value);
}

/**
 * A page of requests, newest first, narrowed by source and status. Keyset: `next` is the last id of the page and goes in
 * as `before`, so a request that arrives meanwhile moves no page. The filters are added to the statement rather than
 * tested in it, so one source's list reads `qcloud_requests_source_idx` and the rest `qcloud_requests_list_idx`.
 */
export async function listRequests(
  ctx: StoreContext,
  query: RequestQuery = {}
): Promise<RequestPage> {
  const limit = query.limit ?? DEFAULT_DELIVERY_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELIVERY_PAGE) {
    throw new UnsupportedOptionError('limit', `must be an integer from 1 to ${MAX_DELIVERY_PAGE}`);
  }
  if (query.status !== undefined && query.status !== 'accepted' && query.status !== 'rejected') {
    throw new UnsupportedOptionError('status', 'must be accepted or rejected');
  }
  const params: unknown[] = [ctx.namespace];
  const where = ['namespace = $1'];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (query.sourceId !== undefined) add('source_id = ?', identifier('sourceId', query.sourceId));
  if (query.status !== undefined) add('status = ?', query.status);
  if (query.before !== undefined) add('id < ?', requestNumber('before', query.before));
  params.push(limit + 1);
  return ctx.db.run('listRequests', async (sql) => {
    const rows = await sql.unsafe<RequestRow[]>(
      `SELECT ${SUMMARY} FROM qcloud_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    const items = rows.slice(0, limit).map(summaryOf);
    return { items, next: rows.length > limit ? items[items.length - 1]!.id : null };
  });
}

/**
 * One request whole, with the deliveries it made (a replay's too), newest first. A delivery is found through the routes
 * that have a source, which `qcloud_webhooks_source_idx` lists, and the delivery index by route; `created_at` is at or
 * after the request's, which lets the day partitions before it be skipped. Null when there is no such request.
 */
export async function getRequest(ctx: StoreContext, id: string): Promise<RequestDetail | null> {
  const key = requestNumber('id', id);
  return ctx.db.run('getRequest', async (sql) => {
    const [row] = await sql.unsafe<
      Array<RequestRow & { headers: unknown; query: unknown; body: Uint8Array | null }>
    >(
      `SELECT ${SUMMARY}, headers, query, body FROM qcloud_requests WHERE namespace = $1 AND id = $2`,
      [ctx.namespace, key]
    );
    if (!row) return null;
    const routes = await sql<Array<{ id: string; destination: string }>>`
      SELECT id, destination FROM qcloud_webhooks
      WHERE namespace = ${ctx.namespace} AND source_id IS NOT NULL`;
    const via = new Map(routes.map((route) => [route.id, route.destination as WebhookDestination]));
    const found =
      routes.length === 0
        ? []
        : await sql<DeliveryRow[]>`
            SELECT id, webhook_id, event_name, request_id, occurred_at, status, attempts, next_attempt_at,
                   last_status_code, last_error, history, created_at, finished_at
            FROM qcloud_deliveries
            WHERE namespace = ${ctx.namespace} AND request_id = ${key}
              AND webhook_id = ANY(${sql.array(
                routes.map((route) => route.id),
                'TEXT'
              )})
              AND created_at >= ${row.received_at}
            ORDER BY id DESC LIMIT ${MAX_DELIVERY_PAGE}`;
    return {
      ...summaryOf(row),
      headers: pairsOf(row.headers),
      query: pairsOf(row.query),
      body: row.body,
      deliveries: found.map((d) => ({ delivery: deliveryOf(d), via: via.get(d.webhook_id)! })),
    };
  });
}

const pairsOf = (value: unknown): Pairs =>
  (typeof value === 'string' ? JSON.parse(value) : value) as Pairs;

/**
 * Makes new deliveries of a stored request for the source's routes as they are now (a route added since gets one, a route
 * deleted since does not, a changed filter or shape applies). The dedupe is skipped: the operator asked for this. A receiver
 * that already had the request gets it again, which is the point. A replay in the same millisecond as the accept or an
 * earlier replay of the same request makes nothing, because the delivery's key is the request, the route and the time.
 */
export async function replayRequest(ctx: StoreContext, id: string): Promise<ReplayResult> {
  const key = requestNumber('id', id);
  return ctx.db.run('replayRequest', (sql) =>
    runTransaction(sql, async (tx): Promise<ReplayResult> => {
      const now = await ctx.db.time.now(tx);
      const [row] = await tx<
        Array<{
          source_id: string;
          method: string;
          headers: unknown;
          query: unknown;
          content_type: string | null;
          body: Uint8Array | null;
          status: string;
        }>
      >`
        SELECT source_id, method, headers, query, content_type, body, status FROM qcloud_requests
        WHERE namespace = ${ctx.namespace} AND id = ${key} FOR KEY SHARE`;
      if (!row) return { outcome: 'not_found' };
      if (row.status !== 'accepted' || row.body === null) return { outcome: 'rejected' };
      // KEY SHARE: a delete of the source in flight finishes first, and the request goes with it.
      await tx`
        SELECT id FROM qcloud_sources
        WHERE namespace = ${ctx.namespace} AND id = ${row.source_id} FOR KEY SHARE`;
      const made = await fanOut(tx, ctx, {
        source: row.source_id,
        requestId: String(key),
        now,
        document: requestDocument({
          method: row.method,
          headers: pairsOf(row.headers),
          query: pairsOf(row.query),
          contentType: row.content_type,
          body: row.body,
        }),
        dedupe: false,
      });
      return { outcome: 'replayed', ...made };
    })
  );
}
