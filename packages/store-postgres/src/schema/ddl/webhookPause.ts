import { WEBHOOK_WRITER_STATEMENTS } from './webhookWriter';

/**
 * Version 15 DDL: a webhook that keeps failing is paused, and its signing secret can be rotated.
 * Everything is added with a default, so a release that does not know the columns reads and writes
 * the table as before.
 *
 * - `consecutive_failures`: deliveries that failed (every attempt used) since the last delivered one.
 *   `alert_level` is how far that is toward the sender's `disableAfter` (0 to 4, see
 *   `webhookAlertLevel`), kept on the row so the Control API can show it without knowing the setting.
 * - A paused webhook has `enabled = FALSE` and `disabled_reason` set. The sender does not serve it
 *   (it only serves `enabled`), but the trigger and the writer keep making its deliveries, so what it
 *   missed is held until `WEBHOOK_DELIVERY_EXPIRY_MS` and goes out when it is turned on again. Turning
 *   it off by hand clears the reason, which stops the deliveries being made.
 * - `secret_previous_sealed` and `secret_previous_until`: the secret before the last rotation, which
 *   still signs beside the new one until the time given.
 *
 * The trigger function is migration 14's with the one condition changed.
 */
const WITH_PAUSED = WEBHOOK_WRITER_STATEMENTS[WEBHOOK_WRITER_STATEMENTS.length - 1]!.replace(
  '   AND w.enabled\n',
  '   AND (w.enabled OR w.disabled_reason IS NOT NULL)\n'
);

export const WEBHOOK_PAUSE_STATEMENTS: readonly string[] = [
  `ALTER TABLE qcloud_webhooks
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN alert_level SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN disabled_reason TEXT,
  ADD COLUMN disabled_at BIGINT,
  ADD COLUMN secret_previous_sealed TEXT,
  ADD COLUMN secret_previous_until BIGINT`,
  WITH_PAUSED,
];
