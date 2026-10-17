/**
 * Version 8 DDL: webhooks. An operator registers a URL and the journal events it wants
 * (`qcloud_webhooks`); every matching event becomes one delivery row (`qcloud_webhook_deliveries`)
 * that the maintenance tick sends, retries and records. All new tables and one new trigger, so a
 * release that does not know them carries on: its events fire the trigger and, with no webhook
 * registered, the trigger finds nothing.
 *
 * Deliveries are made by a statement-level trigger on the event table, in the transaction that wrote
 * the event, so an event that commits has its deliveries and one that rolls back has none (none lost,
 * none doubled: the unique index on the event is the second guard). The trigger carries the journal's
 * event-to-webhook name table as a `VALUES` list; `core/src/webhook.ts` holds the same table and a
 * test keeps the two equal. Deliveries of one statement are inserted in event order, so their ids
 * (the tie-break of the send order) follow the order the events were journaled in. An event is
 * delivered only to a webhook that was enabled when it was written: enabling a webhook later does
 * not replay the past.
 *
 * The delivery inserts take `FOR KEY SHARE` on the webhook rows they reference, which waits for a
 * delete of that webhook that is in flight and then skips it, so deleting a webhook never fails a
 * job's own transaction on the foreign key. The tick locks webhook rows `FOR NO KEY UPDATE`, which
 * does not conflict with that lock.
 *
 * The secret is `secret_sealed`: AES-GCM under a key the database does not hold (`core`'s
 * `sealSecret`), never the secret itself. `next_attempt_at` is when a `pending` delivery is due and
 * the lease expiry of a `sending` one. `attempt_base` is the attempt number a manual retry restarts
 * the budget from, so attempt numbers keep rising while each retry gets a full budget.
 */
export const WEBHOOK_FUNCTION_BODY = `BEGIN
  INSERT INTO qcloud_webhook_deliveries
    (namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status,
     next_attempt_at, created_at)
  SELECT e.namespace, w.id, e.id, m.webhook_event, e.queue, e.job_id, e.occurred_at, 'pending',
         e.occurred_at, e.occurred_at
  FROM new_event_rows e
  JOIN (VALUES
    ('pushed', 'job.pushed'),
    ('pulled', 'job.started'),
    ('completed', 'job.completed'),
    ('failed', 'job.failed'),
    ('progress', 'job.progress')
  ) AS m(event_type, webhook_event) ON m.event_type = e.event_type
  JOIN qcloud_webhooks w
    ON w.namespace = e.namespace
   AND w.enabled
   AND m.webhook_event = ANY (w.events)
   AND (w.queue IS NULL OR w.queue = e.queue)
  ORDER BY e.id, w.id
  FOR KEY SHARE OF w
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;`;

export const WEBHOOK_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_webhooks (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL CHECK (cardinality(events) >= 1),
  queue TEXT,
  secret_sealed TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  success_count BIGINT NOT NULL DEFAULT 0,
  failure_count BIGINT NOT NULL DEFAULT 0,
  last_triggered BIGINT,
  rate_window_start BIGINT NOT NULL DEFAULT 0,
  rate_window_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, id)
)`,
  `CREATE TABLE qcloud_webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  event_id BIGINT,
  event_name TEXT NOT NULL,
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_base INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  finished_at BIGINT,
  FOREIGN KEY (namespace, webhook_id) REFERENCES qcloud_webhooks(namespace, id) ON DELETE CASCADE
)`,
  // What the tick claims: one webhook's due deliveries, oldest first (the claim reads it once per
  // webhook and shares the slots between webhooks itself).
  `CREATE INDEX qcloud_webhook_deliveries_due_idx
  ON qcloud_webhook_deliveries(namespace, webhook_id, next_attempt_at, id)
  WHERE status IN ('pending', 'sending')`,
  // A webhook's delivery history, newest first.
  `CREATE INDEX qcloud_webhook_deliveries_history_idx
  ON qcloud_webhook_deliveries(namespace, webhook_id, id DESC)`,
  // An event is delivered to a webhook once. Test deliveries have no event and are exempt.
  `CREATE UNIQUE INDEX qcloud_webhook_deliveries_event_idx
  ON qcloud_webhook_deliveries(namespace, webhook_id, event_id)
  WHERE event_id IS NOT NULL`,
  // Retention: live deliveries nobody sent in time, and finished ones past their keep.
  `CREATE INDEX qcloud_webhook_deliveries_stale_idx
  ON qcloud_webhook_deliveries(namespace, next_attempt_at)
  WHERE status IN ('pending', 'sending')`,
  `CREATE INDEX qcloud_webhook_deliveries_finished_idx
  ON qcloud_webhook_deliveries(namespace, finished_at)
  WHERE status IN ('delivered', 'failed')`,
  `CREATE FUNCTION qcloud_enqueue_webhook_deliveries()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${WEBHOOK_FUNCTION_BODY}
$function$`,
  // Fires after qcloud_events_register_commit and qcloud_events_track_retention_insert (name order).
  `CREATE TRIGGER qcloud_events_webhook_deliveries
AFTER INSERT ON qcloud_events
REFERENCING NEW TABLE AS new_event_rows
FOR EACH STATEMENT EXECUTE FUNCTION qcloud_enqueue_webhook_deliveries()`,
];
