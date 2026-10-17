/**
 * Version 4 DDL: the tick's coordination row, one per namespace. It holds the leader lease of the
 * in-process tick and when a tick last succeeded or failed. The lease is a row compared against the
 * database clock, not an advisory lock: a session lock admits two holders behind a transaction
 * pooler. The two timestamps are what the control API and the alerts read to see that the tick runs.
 * A new table, so releases that do not know it are unaffected. See `store/tickState.ts`.
 */
export const TICK_STATE_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_tick_state (
  namespace TEXT PRIMARY KEY,
  leader TEXT,
  leader_expires_at BIGINT NOT NULL DEFAULT 0,
  last_success_at BIGINT,
  last_failure_at BIGINT
)`,
];
