/**
 * Version 20 DDL: inbound sources and the requests they take (DESIGN.md D12 and D14). Only additions, so a release that
 * does not know them reads and writes everything as before.
 *
 * - `qcloud_sources`: a public ingest URL and how it checks who posts to it. `token_hash` is the SHA-256 of the URL token
 *   (the token is shown once and never stored); the verification secret is sealed like a webhook's. The `reject_window_*`
 *   columns are a fixed one-minute window that caps how many rejected requests a source stores, and `rejected_dropped`
 *   counts the ones over the cap, so a flood of bad requests cannot fill `qcloud_requests`.
 * - `qcloud_requests`: one stored inbound call, accepted or rejected with a cause. Headers are stored redacted. A plain
 *   table, not partitioned by day like deliveries: the delivery partition functions are specific to that table and the tick
 *   would need new code for another; the retention index lets it delete old rows in batches instead.
 * - `qcloud_webhooks.source_id`: the inbound source a route listens to. A route with a source has no events and no queue.
 *   The foreign key restricts: a source with routes cannot be removed. The `events` check is relaxed to allow that, and
 *   the trigger and the delivery writer of a release that predates this version find no events in such a route, so they
 *   make nothing for it.
 * - `qcloud_deliveries.request_id`: the request a delivery carries, with a unique index like the event's, so one request is
 *   delivered to a route once (a replay has a later `created_at`, the partition key). The delivery's `event_name` is
 *   `request.received`, `queue` the source id and `job_id` the request id, which keeps the old NOT NULL columns true until
 *   version 21 removes them.
 */
export const INBOUND_SOURCE_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_sources (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'none' CHECK (verification IN ('none', 'hmac', 'basic', 'api_key')),
  verification_header TEXT,
  verification_user TEXT,
  secret_sealed TEXT,
  secret_previous_sealed TEXT,
  secret_previous_until BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  reject_window_start BIGINT NOT NULL DEFAULT 0,
  reject_window_count INTEGER NOT NULL DEFAULT 0,
  rejected_dropped BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, id)
)`,
  `CREATE UNIQUE INDEX qcloud_sources_name_idx ON qcloud_sources(namespace, name)`,
  // What the ingest looks up on every request.
  `CREATE UNIQUE INDEX qcloud_sources_token_idx ON qcloud_sources(namespace, token_hash)`,
  `CREATE TABLE qcloud_requests (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  method TEXT NOT NULL,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  query JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_type TEXT,
  body BYTEA,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  cause TEXT,
  FOREIGN KEY (namespace, source_id) REFERENCES qcloud_sources(namespace, id) ON DELETE CASCADE
)`,
  // The Requests tab: one source's requests, and every source's, newest first.
  `CREATE INDEX qcloud_requests_source_idx ON qcloud_requests(namespace, source_id, id DESC)`,
  `CREATE INDEX qcloud_requests_list_idx ON qcloud_requests(namespace, id DESC)`,
  // Retention: requests past their keep.
  `CREATE INDEX qcloud_requests_retention_idx ON qcloud_requests(namespace, received_at)`,
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN source_id TEXT,
  ADD CONSTRAINT qcloud_webhooks_source_fk FOREIGN KEY (namespace, source_id)
    REFERENCES qcloud_sources(namespace, id) ON DELETE RESTRICT`,
  `ALTER TABLE qcloud_webhooks DROP CONSTRAINT qcloud_webhooks_events_check`,
  `ALTER TABLE qcloud_webhooks ADD CONSTRAINT qcloud_webhooks_events_check
  CHECK (cardinality(events) >= 1 OR source_id IS NOT NULL)`,
  // The routes of one source: the fan-out, the in-use check and the foreign key's own.
  `CREATE INDEX qcloud_webhooks_source_idx ON qcloud_webhooks(namespace, source_id) WHERE source_id IS NOT NULL`,
  `ALTER TABLE qcloud_deliveries ADD COLUMN request_id BIGINT`,
  // A request is delivered to a route once. `created_at` is the partition key, so it is part of the key.
  `CREATE UNIQUE INDEX qcloud_deliveries_request_idx
  ON qcloud_deliveries(namespace, webhook_id, request_id, created_at)
  WHERE request_id IS NOT NULL`,
];
