/**
 * Version 17 DDL: what a connection gets beside `filter` and `shape` (DESIGN.md D13). Every column is
 * nullable, so a release that does not know them reads and writes the table as before.
 *
 * - `name`, `description`: what the operator calls the route. Display only.
 * - `delay_ms`: a delivery is made when the event is, and is not due until `delay_ms` later. The delivery
 *   writer applies it (the trigger does not), so it needs the writer on, as a filter does.
 * - `dedupe`: `{ windowMs, fields }`, applied by the writer too. A route with either rule blocks switching the
 *   writer off. A sender that predates this version still sends the deliveries it finds, with the delay already
 *   in `next_attempt_at`; only a writer that predates it would ignore the rule, so add a route with a delay or a
 *   dedupe after every tick runs this release.
 * - `qcloud_webhook_dedupe`: the writer's memory for `dedupe`. One row for each distinct value a route has accepted
 *   inside its window: `key` is a hash of the chosen fields' values (never the values), `until` is when the window
 *   ends. It is written in the writer's transaction and pruned by the tick once `until` has passed.
 */
export const WEBHOOK_RULE_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN name TEXT,
  ADD COLUMN description TEXT,
  ADD COLUMN delay_ms BIGINT CHECK (delay_ms IS NULL OR delay_ms > 0),
  ADD COLUMN dedupe JSONB`,
  `CREATE TABLE qcloud_webhook_dedupe (
  namespace TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  key TEXT NOT NULL,
  until BIGINT NOT NULL,
  PRIMARY KEY (namespace, webhook_id, key),
  FOREIGN KEY (namespace, webhook_id) REFERENCES qcloud_webhooks(namespace, id) ON DELETE CASCADE
)`,
  // What the tick prunes: the keys whose window has ended.
  `CREATE INDEX qcloud_webhook_dedupe_until_idx ON qcloud_webhook_dedupe(namespace, until)`,
];
