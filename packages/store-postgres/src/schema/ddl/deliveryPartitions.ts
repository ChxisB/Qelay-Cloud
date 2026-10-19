import { WEBHOOK_FUNCTION_BODY } from './webhooks';

/**
 * Version 13 DDL: webhook deliveries in a table partitioned by day (`qcloud_deliveries`), so the tick
 * drops a finished day whole instead of deleting its rows one by one: a drop is instant and leaves
 * nothing for vacuum, where a week of per-row deletes on the hot table made a standing load of dead
 * tuples. Everything is added; `qcloud_webhook_deliveries` stays, empty of live rows, for the release
 * after this one to drop (a release that still reads it is not broken by its absence of new rows,
 * only by deliveries it never sees: see docs/operations.md, "Rolling back past version 13").
 *
 * The partition key is `created_at`, which the trigger sets to the event's `occurred_at`, so one event
 * always lands in one partition and the unique index (it must include the key) still guards it. A row
 * whose day has no partition goes to `qcloud_deliveries_default`, so a write never fails for a missing
 * partition; the tick creates the next days ahead and drops the old ones (`qcloud_*_delivery_partitions`).
 * The default partition keeps the row-by-row retention the old table had, and two indexes of its own.
 *
 * Partitions are named `qcloud_deliveries_YYYYMMDD` (UTC) and made by a function, not by a migration
 * statement: the schema manifest and the snapshot know the table, not the days. The functions take
 * `pg_advisory_xact_lock` (never a session lock), so two ticks cannot make one partition twice.
 */
const PARTITION_STORAGE = 'fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01';
const DAY_MS = 86_400_000;
const LOCK = `pg_advisory_xact_lock(hashtext(current_schema() || '/qcloud_deliveries'))`;

export const DELIVERY_PARTITION_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_deliveries (
  id BIGSERIAL,
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
  PRIMARY KEY (id, created_at),
  FOREIGN KEY (namespace, webhook_id) REFERENCES qcloud_webhooks(namespace, id) ON DELETE CASCADE
) PARTITION BY RANGE (created_at)`,
  // The same paths as the old table (see its indexes); the finished-row index is the default
  // partition's alone, because a day partition is dropped whole and is never searched by finish time.
  `CREATE INDEX qcloud_deliveries_due_idx
  ON qcloud_deliveries(namespace, webhook_id, next_attempt_at, id)
  WHERE status IN ('pending', 'sending')`,
  `CREATE INDEX qcloud_deliveries_history_idx
  ON qcloud_deliveries(namespace, webhook_id, id DESC)`,
  // An event is delivered to a webhook once. `created_at` is the partition key, and the trigger sets it
  // from the event, so a second insert for the same event meets the first. Test deliveries are exempt.
  `CREATE UNIQUE INDEX qcloud_deliveries_event_idx
  ON qcloud_deliveries(namespace, webhook_id, event_id, created_at)
  WHERE event_id IS NOT NULL`,
  `CREATE INDEX qcloud_deliveries_stale_idx
  ON qcloud_deliveries(namespace, next_attempt_at)
  WHERE status IN ('pending', 'sending')`,
  `CREATE TABLE qcloud_deliveries_default PARTITION OF qcloud_deliveries DEFAULT
  WITH (${PARTITION_STORAGE})`,
  `CREATE INDEX qcloud_deliveries_default_finished_idx
  ON qcloud_deliveries_default(namespace, finished_at)
  WHERE status IN ('delivered', 'failed')`,
  // Whether a day that has no partition yet already has rows in the default one (then it is left there).
  `CREATE INDEX qcloud_deliveries_default_created_idx ON qcloud_deliveries_default(created_at)`,
  // Makes today and the next `ahead` days. A day whose range the default partition already holds rows
  // for is skipped (attaching would fail, and moving the rows is not worth it): the default keeps it.
  // Attaching lets inserts through on the parent, but locks the default partition while it checks that
  // it holds no row of the new range, so a write that lands there waits that long (the default holds
  // little). The lock wait is capped at one second: a pass that cannot get it stops, and the next retries.
  `CREATE FUNCTION qcloud_ensure_delivery_partitions(now_ms BIGINT, ahead INTEGER)
RETURNS INTEGER LANGUAGE plpgsql AS $function$
DECLARE
  first_day INTEGER := (now_ms / ${DAY_MS})::INTEGER;
  lo BIGINT;
  part TEXT;
  made INTEGER := 0;
BEGIN
  PERFORM ${LOCK};
  PERFORM set_config('lock_timeout', '1000', true);
  -- The loop variable is an INTEGER of its own: the day's start in milliseconds is made in a BIGINT.
  FOR dn IN first_day .. first_day + ahead LOOP
    lo := dn::BIGINT * ${DAY_MS};
    part := 'qcloud_deliveries_' || to_char(to_timestamp(lo / 1000) AT TIME ZONE 'UTC', 'YYYYMMDD');
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_class WHERE relname = part AND relnamespace = current_schema()::regnamespace);
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM qcloud_deliveries_default
      WHERE created_at >= lo AND created_at < lo + ${DAY_MS});
    -- Attach, not CREATE ... PARTITION OF, which takes ACCESS EXCLUSIVE on the parent.
    BEGIN
      EXECUTE format(
        'CREATE TABLE %I (LIKE qcloud_deliveries INCLUDING DEFAULTS INCLUDING CONSTRAINTS) WITH (${PARTITION_STORAGE})', part);
      EXECUTE format(
        'ALTER TABLE qcloud_deliveries ATTACH PARTITION %I FOR VALUES FROM (%s) TO (%s)',
        part, lo, lo + ${DAY_MS});
      made := made + 1;
    EXCEPTION WHEN lock_not_available THEN
      EXIT;
    END;
  END LOOP;
  RETURN made;
END
$function$`,
  // Drops the day partitions that end at or before before_ms and hold no live delivery (a retried
  // one is live again). Dropping locks the table, so it waits one second at most and tries again on
  // the next pass; it never queues the job transactions behind a long wait.
  `CREATE FUNCTION qcloud_drop_delivery_partitions(before_ms BIGINT)
RETURNS INTEGER LANGUAGE plpgsql AS $function$
DECLARE
  part TEXT;
  live BOOLEAN;
  dropped INTEGER := 0;
BEGIN
  PERFORM ${LOCK};
  PERFORM set_config('lock_timeout', '1000', true);
  FOR part IN
    SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'qcloud_deliveries'::regclass AND c.relname ~ '^qcloud_deliveries_[0-9]{8}$'
      AND extract(epoch FROM to_date(substr(c.relname::text, 19), 'YYYYMMDD') + 1)::BIGINT * 1000 <= before_ms
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE status IN (''pending'', ''sending''))', part)
      INTO live;
    CONTINUE WHEN live;
    BEGIN
      EXECUTE format('DROP TABLE %I', part);
      dropped := dropped + 1;
    EXCEPTION WHEN lock_not_available THEN
      EXIT;
    END;
  END LOOP;
  RETURN dropped;
END
$function$`,
  `SELECT qcloud_ensure_delivery_partitions((extract(epoch FROM clock_timestamp()) * 1000)::BIGINT, 3)`,
  // The ids go on from the old table's, so a moved live delivery and a new one never share an id.
  `SELECT setval('qcloud_deliveries_id_seq', coalesce((SELECT max(id) FROM qcloud_webhook_deliveries), 0) + 1, false)`,
  // Same body as version 8's, writing to the new table.
  `CREATE OR REPLACE FUNCTION qcloud_enqueue_webhook_deliveries()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
${WEBHOOK_FUNCTION_BODY.replace('INSERT INTO qcloud_webhook_deliveries', 'INSERT INTO qcloud_deliveries')}
$function$`,
  // What is still to be sent moves over, so no sender of this release has to read the old table. What
  // is finished stays behind with its history: it is gone from the API and goes with the old table.
  `WITH moved AS (
  DELETE FROM qcloud_webhook_deliveries WHERE status IN ('pending', 'sending') RETURNING *
)
INSERT INTO qcloud_deliveries
  (id, namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status, attempts,
   attempt_base, next_attempt_at, last_status_code, last_error, history, created_at, finished_at)
SELECT id, namespace, webhook_id, event_id, event_name, queue, job_id, occurred_at, status, attempts,
       attempt_base, next_attempt_at, last_status_code, last_error, history, created_at, finished_at
FROM moved`,
];
