/**
 * Version 18 DDL: issues (DESIGN.md D13). A new table and nothing else, so a release that does not know it reads and
 * writes everything as before. It also does not keep the table current: a worker that predates this version opens and
 * resolves no issues, so one can read open after its route recovered, or be missing while it fails, until a worker of this
 * release settles a delivery for that route. Roll every worker before relying on the Issues screen.
 *
 * - One row per episode. `status` is `open`, `acknowledged`, `resolved` or `ignored`; all but `resolved`
 *   are live, and a route has at most one live issue (the partial unique index), so a failure while one is live
 *   adds nothing and a recovery resolves it, whatever its status.
 * - `kind` is what failed; `delivery_failed` is the only one. `updated_by` is the operator who last changed the
 *   status, null when Qelay did (opened it, or resolved it on a recovery).
 * - Deleting the route deletes its issues. The tick prunes resolved issues past `webhookKeepMs`.
 * - The backfill opens one issue for each route that is failing or paused for failing now.
 */
export const WEBHOOK_ISSUE_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_webhook_issues (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored')),
  kind TEXT NOT NULL,
  opened_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (namespace, webhook_id) REFERENCES qcloud_webhooks(namespace, id) ON DELETE CASCADE
)`,
  `CREATE UNIQUE INDEX qcloud_webhook_issues_live_idx ON qcloud_webhook_issues(namespace, webhook_id)
  WHERE status IN ('open', 'acknowledged', 'ignored')`,
  // The Issues screen: one status, newest first, and the counts of each.
  `CREATE INDEX qcloud_webhook_issues_status_idx ON qcloud_webhook_issues(namespace, status, id DESC)`,
  // What the tick prunes: resolved issues past their keep time.
  `CREATE INDEX qcloud_webhook_issues_resolved_idx ON qcloud_webhook_issues(namespace, updated_at)
  WHERE status = 'resolved'`,
  `INSERT INTO qcloud_webhook_issues (namespace, webhook_id, status, kind, opened_at, updated_at)
  SELECT namespace, id, 'open', 'delivery_failed',
         coalesce(disabled_at, (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT),
         (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
  FROM qcloud_webhooks WHERE consecutive_failures > 0 OR disabled_reason IS NOT NULL`,
];
