/**
 * Version 12 DDL: storage parameters for the tables a busy queue rewrites all day. Only storage
 * parameters change (no column, index or constraint), so a release that does not know them reads
 * and writes the same tables, and `ALTER TABLE ... SET (...)` takes a lock that blocks neither.
 *
 * - `fillfactor = 80` leaves room in each page for the new row version of an update, so one that
 *   changes no indexed column (a progress write, a metric counter, a delivery's history) stays on
 *   the page (a heap-only update) and adds no index entries. It applies to pages written from now on.
 * - `autovacuum_vacuum_scale_factor = 0.01` starts a vacuum when 1% of the table is dead, not the
 *   default 20%: a job row changes state at least three times, so a busy queue makes dead rows
 *   faster than a 20% threshold reaches them.
 *
 * The instance's `autovacuum_max_workers` and a dead-rows alert are set outside the schema; see
 * `docs/limits.md`.
 */
const HOT_TABLES = [
  'qcloud_jobs',
  'qcloud_queue_state',
  'qcloud_metric_buckets',
  'qcloud_metric_totals',
  'qcloud_webhook_deliveries',
] as const;

export const TUNING_STATEMENTS: readonly string[] = HOT_TABLES.map(
  (table) => `ALTER TABLE ${table} SET (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.01)`
);
