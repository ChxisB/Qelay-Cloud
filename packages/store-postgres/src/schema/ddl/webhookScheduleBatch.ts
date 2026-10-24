/**
 * Version 22 DDL: a route can send at a set time and in batches (DESIGN.md D15). Every column is nullable, so a
 * release that does not know them reads and writes both tables as before.
 *
 * - `schedule_cron`, `schedule_timezone`: when the route's deliveries are due. Both or neither. The fan-out sets a
 *   delivery's `next_attempt_at` to the first fire at or after the event plus the route's delay, so the sender, which
 *   only looks at `next_attempt_at`, needs no change to hold it. The expression itself is checked by the store's cron
 *   parser when the route is saved (SQL cannot parse it). A release that predates this version ignores the schedule on
 *   a route and does not move new deliveries to the fire time, so add a scheduled route after every process runs this
 *   release.
 * - `batch_max_events`, `batch_max_bytes`: the route sends its due deliveries as one request. Both or neither, within
 *   the bounds of `webhookBatch.ts` in core, and only on an `http` route. A sender that predates this version sends
 *   each delivery alone, which is correct but is not a batch.
 * - `qcloud_deliveries.batch_id`: the batch a delivery last went out in. Null for a delivery sent alone. It is added to
 *   the partitioned parent, so every partition has it, the default one and the ones the tick makes later (they are
 *   copied from the parent with `LIKE`). No index: nothing looks a delivery up by it.
 */
export const WEBHOOK_SCHEDULE_BATCH_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN schedule_cron TEXT CHECK (schedule_cron IS NULL OR char_length(schedule_cron) BETWEEN 1 AND 200),
  ADD COLUMN schedule_timezone TEXT CHECK (schedule_timezone IS NULL OR char_length(schedule_timezone) BETWEEN 1 AND 64),
  ADD COLUMN batch_max_events INTEGER CHECK (batch_max_events IS NULL OR batch_max_events BETWEEN 1 AND 500),
  ADD COLUMN batch_max_bytes INTEGER CHECK (batch_max_bytes IS NULL OR batch_max_bytes BETWEEN 1024 AND 1048576),
  ADD CONSTRAINT qcloud_webhooks_schedule_check CHECK ((schedule_cron IS NULL) = (schedule_timezone IS NULL)),
  ADD CONSTRAINT qcloud_webhooks_batch_check CHECK (
    (batch_max_events IS NULL) = (batch_max_bytes IS NULL)
    AND (batch_max_events IS NULL OR destination = 'http'))`,
  `ALTER TABLE qcloud_deliveries ADD COLUMN batch_id TEXT`,
];
