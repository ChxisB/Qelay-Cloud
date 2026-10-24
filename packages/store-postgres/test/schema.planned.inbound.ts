import type { Planned } from './schema.planned';

/**
 * The query paths of inbound sources (migration 20, DESIGN.md D12 and D14). The statements are written out as the store runs
 * them (`inboundAccept.ts`, `inboundCredentials.ts`, `inboundSources.ts`, `inboundRequests.ts`), with the values the store
 * binds filled in. The retention delete is the one the tick runs (`inboundRetention.ts`). A source table is capped at
 * `MAX_SOURCES` rows per namespace, so reading it by id needs no index beyond the primary key.
 */
export const PLANNED_INBOUND: readonly Planned[] = [
  {
    query: 'source token: the source a request to a URL belongs to (the ingest, on every request)',
    sql: `SELECT id, name, enabled, verification FROM qcloud_sources
          WHERE namespace = 'ns' AND token_hash = 'h3'`,
    index: 'qcloud_sources_token_idx',
  },
  {
    query: 'sources: is the name taken (a save checks it under the namespace lock)',
    sql: `SELECT id FROM qcloud_sources
          WHERE namespace = 'ns' AND name = 'Billing' AND id IS DISTINCT FROM 's1'`,
    index: 'qcloud_sources_name_idx',
  },
  {
    query: "accept: a source's routes, paused-but-collecting ones included (the fan-out)",
    sql: `SELECT id, filter, shape, delay_ms, dedupe FROM qcloud_webhooks
          WHERE namespace = 'ns' AND source_id = 's1' AND (enabled OR disabled_reason IS NOT NULL)
          ORDER BY id FOR KEY SHARE`,
    index: 'qcloud_webhooks_source_idx',
  },
  {
    query: 'sources: the routes that listen to one (the in-use check on delete)',
    sql: `SELECT count(*) FROM qcloud_webhooks WHERE namespace = 'ns' AND source_id = 's1'`,
    index: 'qcloud_webhooks_source_idx',
  },
  {
    query: "requests: one source's requests, newest first, a page at a time (the Requests tab)",
    sql: `SELECT id FROM qcloud_requests
          WHERE namespace = 'ns' AND source_id = 's5' AND id < 25000
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_requests_source_idx',
    ordered: true,
  },
  {
    query: "requests: every source's requests, newest first, a page at a time (the Requests tab)",
    sql: `SELECT id FROM qcloud_requests WHERE namespace = 'ns' AND id < 25000 ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_requests_list_idx',
    ordered: true,
  },
  {
    query:
      "requests: one source's rejected requests, newest first (the status is a filter on the same index)",
    sql: `SELECT id FROM qcloud_requests
          WHERE namespace = 'ns' AND source_id = 's5' AND status = 'rejected' AND id < 25000
          ORDER BY id DESC LIMIT 51`,
    index: 'qcloud_requests_source_idx',
    ordered: true,
  },
  {
    query: 'requests: one request by id (the detail, and the replay, which locks it)',
    sql: `SELECT id, headers, query, body FROM qcloud_requests WHERE namespace = 'ns' AND id = 25000`,
    index: 'qcloud_requests_pkey',
    // (namespace, id) is an exact match for the list index too.
    alternatives: ['qcloud_requests_list_idx'],
  },
  {
    query:
      "requests: the routes that have a source (a request's deliveries are found through them)",
    sql: `SELECT id, destination FROM qcloud_webhooks WHERE namespace = 'ns' AND source_id IS NOT NULL`,
    index: 'qcloud_webhooks_source_idx',
  },
  {
    query:
      "requests: a request's deliveries, by its routes, from when it was received (the detail)",
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND request_id = 43 AND webhook_id = ANY(ARRAY['w1', 'w2', 'w3'])
            AND created_at >= 1000
          ORDER BY id DESC LIMIT 200`,
    index: 'qcloud_deliveries_request_idx',
  },
  {
    query: 'requests retention: the requests past their keep, oldest first (the tick prunes them)',
    sql: `SELECT namespace, id FROM qcloud_requests WHERE namespace = 'ns' AND received_at < 1000000
          ORDER BY received_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
    index: 'qcloud_requests_retention_idx',
    ordered: true,
  },
  {
    query: 'accept: the delivery a request already has for a route (the conflict, and a replay)',
    sql: `SELECT id FROM qcloud_deliveries
          WHERE namespace = 'ns' AND webhook_id = 'w3' AND request_id = 43`,
    index: 'qcloud_deliveries_request_idx',
  },
];
