/**
 * Version 21 DDL: the job-event pipeline is removed (DESIGN.md D14). A route is fed by an inbound source and nothing else,
 * so the trigger that made a delivery for every journal event, the delivery writer that replaced it, and a route's `events`,
 * `queue` and `active_from` have no reader left.
 *
 * Nothing a user made is deleted. A route that listened to a queue (it has no `source_id`) is kept, disabled with a reason
 * the operator can read; the operator picks a source and enables it. The deliveries such a route had not finished can no
 * longer be built (the journal is not read for them), so they are failed with the same reason. Finished deliveries, the
 * journal and the old `qcloud_webhook_deliveries` table are not touched.
 *
 * `queue` and `job_id` of a delivery were NOT NULL for the job it was about. A request delivery has no job, so they are
 * nullable now and the request delivery writes NULL (version 20 put the source id and the request id there to keep the
 * constraint true).
 *
 * This is not the rolling kind of migration the rules ask for: a worker of the previous version would still read `events`.
 * It is safe here because 1.0.0 is not released, which the owner confirmed on 2026-10-23.
 */
const REASON = `its source, a queue''s job events, was removed`;
const NOW = `(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT`;

export const REMOVE_JOB_EVENT_STATEMENTS: readonly string[] = [
  `DROP TRIGGER qcloud_events_webhook_deliveries ON qcloud_events`,
  `DROP FUNCTION qcloud_enqueue_webhook_deliveries()`,
  `DROP TABLE qcloud_webhook_writers`,
  // Its only reader was the trigger and the writer: one delivery per route and event.
  `DROP INDEX qcloud_deliveries_event_idx`,
  `UPDATE qcloud_webhooks
  SET enabled = FALSE,
      disabled_reason = '${REASON}',
      disabled_at = coalesce(disabled_at, ${NOW})
  WHERE source_id IS NULL`,
  `UPDATE qcloud_deliveries
  SET status = 'failed', last_error = '${REASON}', finished_at = ${NOW}
  WHERE request_id IS NULL AND event_id IS NOT NULL AND status IN ('pending', 'sending')`,
  `ALTER TABLE qcloud_webhooks DROP COLUMN events, DROP COLUMN queue, DROP COLUMN active_from`,
  `ALTER TABLE qcloud_deliveries ALTER COLUMN queue DROP NOT NULL, ALTER COLUMN job_id DROP NOT NULL`,
];
