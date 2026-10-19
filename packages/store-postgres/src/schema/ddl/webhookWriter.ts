import { WEBHOOK_FUNCTION_BODY } from './webhooks';

/**
 * Version 14 DDL: the webhook delivery writer. Until now every event insert fired a trigger that
 * made the deliveries inside the job's own transaction. With a writer on, a separate step reads the
 * journal by cursor and makes them in batches, off the job's path, and applies each webhook's filter
 * and body shape on the way (`store/webhookWriter.ts`).
 *
 * Everything is added, and nothing changes until a namespace is switched: the trigger keeps its
 * behaviour for a namespace with no row in `qcloud_webhook_writers`, so a release that does not know
 * the writer is not affected by this migration. A row means "the writer makes this namespace's
 * deliveries": it holds the journal cursor (`commit_seq`, `event_id`, the same pair `readEvents` takes).
 *
 * Switching on and off is lossless without a pause in job traffic:
 * - On: the row starts at the journal's end. An event whose trigger ran just before the row appeared
 *   already has its deliveries, and the unique index on the event makes the writer's insert a no-op.
 * - Off: the row is first marked `stopping`, which makes the trigger deliver again (and stop taking
 *   the row's lock). The trigger takes `FOR KEY SHARE` on the row while it skips an event, so the
 *   writer's last pass locks the row `FOR UPDATE`, which waits for every transaction that skipped one
 *   to commit, drains the journal to its end and deletes the row, all in one transaction.
 *
 * New columns, all nullable: `filter` and `shape` on a webhook (null: every matching event, the
 * default body), `active_from` (when it was last turned on: the writer does not deliver events from
 * before it, as the trigger never did), and `body` on a delivery (the bytes to send; null: the sender
 * builds the default body, as before).
 */
export const WEBHOOK_WRITER_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_webhook_writers (
  namespace TEXT PRIMARY KEY,
  commit_seq BIGINT NOT NULL,
  event_id BIGINT NOT NULL,
  stopping BOOLEAN NOT NULL DEFAULT FALSE,
  started_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`,
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN filter JSONB,
  ADD COLUMN shape JSONB,
  ADD COLUMN active_from BIGINT`,
  `ALTER TABLE qcloud_deliveries ADD COLUMN body TEXT`,
  `CREATE OR REPLACE FUNCTION qcloud_enqueue_webhook_deliveries()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  written TEXT[];
${WEBHOOK_FUNCTION_BODY.replace(
  'INSERT INTO qcloud_webhook_deliveries',
  'INSERT INTO qcloud_deliveries'
)
  .replace(
    'BEGIN\n',
    `BEGIN
  SELECT coalesce(array_agg(s.namespace), '{}') INTO written FROM (
    SELECT x.namespace FROM qcloud_webhook_writers x
    WHERE NOT x.stopping AND x.namespace IN (SELECT namespace FROM new_event_rows)
    FOR KEY SHARE OF x) s;
`
  )
  .replace(
    '  ORDER BY e.id, w.id',
    '  WHERE NOT (e.namespace = ANY (written))\n  ORDER BY e.id, w.id'
  )}
$function$`,
];
