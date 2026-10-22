/**
 * Version 19 DDL: saved destinations (DESIGN.md D11). A new table and a nullable column, so a release that does not know
 * them reads and writes everything as before.
 *
 * - A destination is a named address: `http` (a `url`) or `queue` (a `target` queue). Names are unique in the namespace.
 *   The kind is fixed at creation; the address and the name can change.
 * - A webhook made from one keeps `destination_id`, and its own `url` and `target` are copies of the address, so the
 *   sender, the writer and every release before this one read the webhook alone. Changing a destination rewrites the
 *   copies in one transaction (`store/webhookDestinations.ts`). A release that predates this version can neither make nor
 *   rewrite one: roll every worker before relying on shared destinations.
 * - The foreign key restricts: a destination in use cannot be removed. MATCH SIMPLE leaves a webhook with no
 *   `destination_id` out of the check, which is every webhook that was made before this version.
 */
export const WEBHOOK_DESTINATION_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_webhook_destinations (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('http', 'queue')),
  url TEXT,
  target TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, id),
  CHECK ((kind = 'http') = (url IS NOT NULL)),
  CHECK ((kind = 'queue') = (target IS NOT NULL))
)`,
  `CREATE UNIQUE INDEX qcloud_webhook_destinations_name_idx ON qcloud_webhook_destinations(namespace, name)`,
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN destination_id TEXT,
  ADD CONSTRAINT qcloud_webhooks_destination_fk FOREIGN KEY (namespace, destination_id)
    REFERENCES qcloud_webhook_destinations(namespace, id) ON DELETE RESTRICT`,
  // The webhooks of one destination: the in-use count, the rewrite and the foreign key's own check.
  `CREATE INDEX qcloud_webhooks_destination_idx ON qcloud_webhooks(namespace, destination_id)
  WHERE destination_id IS NOT NULL`,
];
