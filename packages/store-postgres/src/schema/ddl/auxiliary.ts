/**
 * Version 1 DDL, part 2: the tables around the jobs. Adapted from Qelay's `schema.ts` (version 21).
 * The `INSERT ... SELECT` that seeded queue state from existing jobs is gone: a new database has none.
 */
export const AUXILIARY_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_dependencies (
  namespace TEXT NOT NULL,
  job_id TEXT NOT NULL,
  dependency_id TEXT NOT NULL,
  PRIMARY KEY (namespace, job_id, dependency_id)
)`,
  `CREATE INDEX qcloud_dependencies_dependency_idx
  ON qcloud_dependencies(namespace, dependency_id, job_id)`,

  `CREATE TABLE qcloud_flow_failures (
  namespace TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_queue TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fail', 'remove', 'ignore', 'continue')),
  error TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, parent_id, child_id)
)`,
  `CREATE INDEX qcloud_flow_failures_parent_idx
  ON qcloud_flow_failures(namespace, parent_id, mode)`,

  `CREATE TABLE qcloud_repeat_links (
  namespace TEXT NOT NULL,
  original_id TEXT NOT NULL,
  successor_id TEXT NOT NULL,
  PRIMARY KEY (namespace, original_id)
)`,
  `CREATE INDEX qcloud_repeat_links_successor_idx
  ON qcloud_repeat_links(namespace, successor_id)`,

  `CREATE TABLE qcloud_job_logs (
  id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  job_id TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL
)`,
  `CREATE INDEX qcloud_job_logs_job_idx
  ON qcloud_job_logs(namespace, job_id, id)`,

  `CREATE TABLE qcloud_crons (
  namespace TEXT NOT NULL,
  name TEXT NOT NULL,
  payload BYTEA NOT NULL,
  next_run BIGINT NOT NULL,
  executions INTEGER NOT NULL DEFAULT 0,
  max_limit INTEGER,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, name)
)`,
  `CREATE INDEX qcloud_crons_due_idx
  ON qcloud_crons(namespace, next_run, name)`,

  `CREATE TABLE qcloud_workers (
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  client_id TEXT,
  queues TEXT[] NOT NULL,
  payload BYTEA NOT NULL,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (namespace, id)
)`,
  // No index on `queues`: the lookup is `queue = ANY(queues)` within a namespace, which a GIN index
  // cannot serve (it takes `@>` and `&&`) and the primary key already narrows to the fleet's size.

  `CREATE TABLE qcloud_metric_buckets (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('completed', 'failed')),
  minute BIGINT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (namespace, queue, metric_type, minute)
)`,
  `CREATE TABLE qcloud_metric_totals (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('completed', 'failed')),
  total_count BIGINT NOT NULL,
  prev_ts BIGINT NOT NULL,
  prev_count INTEGER NOT NULL,
  PRIMARY KEY (namespace, queue, metric_type)
)`,

  `CREATE TABLE qcloud_completions (
  namespace TEXT NOT NULL,
  job_id TEXT NOT NULL,
  queue TEXT NOT NULL,
  completed_at BIGINT NOT NULL,
  result BYTEA,
  PRIMARY KEY (namespace, job_id)
)`,
  `CREATE INDEX qcloud_completions_queue_idx
  ON qcloud_completions(namespace, queue, job_id)`,
  `CREATE INDEX qcloud_completions_recent_idx
  ON qcloud_completions(namespace, completed_at DESC, job_id DESC)`,

  // `group_sequence` is the round-robin counter of a queue's groups: a claim hands out
  // `qcloud_group_state.last_served` values from it (task 13). Admission does not use it; task 12 kept
  // grouped admission on `nextval('qcloud_group_order_seq')`.
  `CREATE TABLE qcloud_queue_state (
  namespace TEXT NOT NULL,
  queue TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  rate_limit INTEGER,
  rate_duration_ms BIGINT,
  rate_window_started_at BIGINT,
  rate_expires_at BIGINT,
  rate_count INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER,
  stall_config BYTEA,
  dlq_config BYTEA,
  group_sequence BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, queue)
)`,
];
