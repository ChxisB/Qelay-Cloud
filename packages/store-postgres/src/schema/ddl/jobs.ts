/**
 * Version 1 DDL, part 1: the job table, its indexes, and group state. Adapted from Qelay's
 * `schema.ts` (version 21) and `groupSchema.ts`: the broker columns are gone, `rung_at` and the
 * two tick indexes are new, and the repair code for older versions is not carried over (there is no
 * older version of this schema). See docs/PORTING.md.
 *
 * One statement per array entry, so the runner can name the statement that failed.
 */
const READY_STATES = `state IN ('waiting', 'prioritized', 'delayed')`;

export const JOBS_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_jobs (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload BYTEA NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('waiting', 'prioritized', 'delayed', 'waiting-children',
              'active', 'completed', 'failed')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  lifo BOOLEAN NOT NULL DEFAULT FALSE,
  run_at BIGINT NOT NULL,
  rung_at BIGINT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  completed_at BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  ttl BIGINT,
  timeout BIGINT,
  unique_key TEXT,
  unique_expires_at BIGINT,
  custom_id TEXT,
  group_id TEXT,
  group_order BIGINT,
  parent_id TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_until BIGINT,
  lease_renewals INTEGER NOT NULL DEFAULT 0,
  result BYTEA,
  dlq_entry BYTEA,
  dlq_retry_state BYTEA,
  error TEXT,
  failure_reason TEXT,
  version BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, id)
)`,

  // The claim path: ungrouped jobs in queue order (priority, then run_at, then id).
  `CREATE INDEX qcloud_jobs_ready_idx
  ON qcloud_jobs(namespace, queue, priority DESC, run_at ASC, id ASC)
  WHERE ${READY_STATES}`,
  `CREATE INDEX qcloud_jobs_lifo_ready_idx
  ON qcloud_jobs(namespace, queue, priority DESC, id DESC)
  WHERE group_id IS NULL AND lifo AND ${READY_STATES}`,
  // The claim path for grouped jobs: per-group order, with the sequence as the FIFO tiebreak.
  `CREATE INDEX qcloud_jobs_group_ready_idx
  ON qcloud_jobs(namespace, queue, group_id, priority ASC, run_at ASC, group_order ASC, id ASC)
  WHERE group_id IS NOT NULL AND ${READY_STATES}`,
  // Active jobs per group, for concurrency limits.
  `CREATE INDEX qcloud_jobs_group_active_idx
  ON qcloud_jobs(namespace, queue, group_id, lease_until)
  WHERE group_id IS NOT NULL AND state = 'active'`,
  // Lease recovery.
  `CREATE INDEX qcloud_jobs_lease_idx
  ON qcloud_jobs(namespace, lease_until)
  WHERE state = 'active'`,
  // Listing a queue by state, newest first or oldest first.
  `CREATE INDEX qcloud_jobs_state_idx
  ON qcloud_jobs(namespace, queue, state, created_at, id)`,
  // Flow children of a parent.
  `CREATE INDEX qcloud_jobs_parent_idx
  ON qcloud_jobs(namespace, parent_id)
  WHERE parent_id IS NOT NULL`,
  // Expiry of jobs that were never claimed.
  `CREATE INDEX qcloud_jobs_ttl_pending_idx
  ON qcloud_jobs(namespace, queue, created_at, id)
  WHERE ttl IS NOT NULL AND ${READY_STATES}`,
  // Deduplication: one live job per unique key.
  `CREATE UNIQUE INDEX qcloud_jobs_live_unique_key_idx
  ON qcloud_jobs(namespace, queue, unique_key)
  WHERE unique_key IS NOT NULL
    AND state IN ('waiting', 'prioritized', 'delayed', 'waiting-children', 'active')`,

  // The tick (task 20). Re-ring, stale bells: pending jobs whose last bell is older than the
  // threshold, oldest bell first, a range scan of `rung_at, id` that stops at the per-queue cap.
  // Jobs with no bell at all are read from `qcloud_jobs_unrung_idx` (version 2), not from here.
  // Promotion: delayed jobs whose `run_at` has passed.
  `CREATE INDEX qcloud_jobs_ring_idx
  ON qcloud_jobs(namespace, queue, rung_at, id)
  WHERE ${READY_STATES}`,
  `CREATE INDEX qcloud_jobs_delayed_idx
  ON qcloud_jobs(namespace, queue, run_at, id)
  WHERE state = 'delayed'`,

  // `group_order` values come from this sequence, which a group's FIFO order is built on.
  `CREATE SEQUENCE qcloud_group_order_seq AS BIGINT
  INCREMENT BY 1 NO MINVALUE NO MAXVALUE NO CYCLE CACHE 1`,

  `CREATE TABLE qcloud_group_state (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  group_id TEXT NOT NULL,
  rate_limit BIGINT,
  rate_duration_ms BIGINT,
  rate_window_started_at BIGINT,
  rate_count BIGINT NOT NULL DEFAULT 0,
  rate_effective_max BIGINT,
  rate_effective_duration_ms BIGINT,
  concurrency_limit BIGINT,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  manual_rate_limit_until BIGINT,
  last_served BIGINT,
  PRIMARY KEY (namespace, queue, group_id)
)`,
  // Round-robin between groups: the least recently served first.
  `CREATE INDEX qcloud_group_state_rotation_idx
  ON qcloud_group_state(namespace, queue, last_served, group_id)`,
];
