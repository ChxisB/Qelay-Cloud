/**
 * Version 16 DDL: a webhook is a route that says where its deliveries go (DESIGN.md D11).
 * Both columns are added with a default or as nullable, so a release that does not know them reads
 * and writes the table as before.
 *
 * - `destination`: `http` (a POST to `url`, the only kind before this version) or `queue` (a job
 *   added to `target`, a queue of the same namespace). Every existing row is `http`.
 * - `target`: the queue of a `queue` route, null for `http`. `url` stays NOT NULL and holds the
 *   empty string for a `queue` route; a sender that predates this version fails such a delivery
 *   without making a request.
 */
export const WEBHOOK_DESTINATION_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN destination TEXT NOT NULL DEFAULT 'http' CHECK (destination IN ('http', 'queue')),
  ADD COLUMN target TEXT,
  ADD CONSTRAINT qcloud_webhooks_target_check CHECK ((destination = 'queue') = (target IS NOT NULL))`,
];
