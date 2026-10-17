/**
 * Version 9 DDL: workflow executions. One row per run of a durable workflow
 * (`qcloud_workflow_executions`), and an archive of finished ones (`qcloud_workflow_executions_archive`).
 * Two new tables and nothing else, so a release that does not know them carries on untouched.
 *
 * The layout follows upstream's `workflow_executions`, with the columns of its `meta` blob promoted
 * to real ones so that recovery, listing and the wait scan are indexed instead of parsed:
 *
 * - `input`, `steps`, `resolved_steps`, `decisions` and `signals` are codec-encoded blobs (`core`'s
 *   `Codec`, the msgpack one by default). They hold user data of any shape, which JSONB would not
 *   round-trip. `signals` stays a column of the row, as upstream has it, so recording a signal and
 *   claiming the resume of a parked run is one `UPDATE` of one row under one row lock.
 * - `version` is the compare-and-set counter behind `WorkflowStorePort.update`: 0 when saved, one
 *   more for every write that moves the run. Upstream's `update` was a blind write, which is right
 *   for one process and wrong for two engines sharing a database.
 * - `wait_event`, `wait_deadline` and `wait_lease_until` are what a parked `waitFor` needs to time out
 *   without a process holding a timer: the awaited event, when it expires, and until when one scanner
 *   owns the expiry (`FOR UPDATE SKIP LOCKED`). They are set only while `state = 'waiting'`.
 * - The archive has the same columns without the wait ones, plus `archived_at`. An execution archived
 *   twice (restored by hand, run again, archived again) replaces its earlier row.
 *
 * Every index starts with `namespace`, because every query does. The listing indexes are upstream's
 * (newest first, optionally by workflow and state); `(state, updated_at, id)` serves recovery and
 * retention; the partial indexes serve the child lookup and the wait scan and stay small because
 * most runs are neither.
 */

const EXECUTION_COLUMNS = `namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('running', 'waiting', 'completed', 'failed', 'compensating', 'compensation-stuck')),
  definition_hash TEXT,
  parent_execution_id TEXT,
  input BYTEA NOT NULL,
  steps BYTEA NOT NULL,
  current_node_index INTEGER NOT NULL DEFAULT 0,
  resolved_steps BYTEA,
  decisions BYTEA,
  signals BYTEA NOT NULL,
  rollback_status TEXT CHECK (rollback_status IN ('completed', 'not-applicable', 'stuck')),
  failure_reason TEXT,
  committed_at INTEGER,
  version BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL`;

export const WORKFLOW_STATEMENTS: readonly string[] = [
  `CREATE TABLE qcloud_workflow_executions (
  ${EXECUTION_COLUMNS},
  wait_event TEXT,
  wait_deadline BIGINT,
  wait_lease_until BIGINT,
  PRIMARY KEY (namespace, id)
)`,
  `CREATE TABLE qcloud_workflow_executions_archive (
  ${EXECUTION_COLUMNS},
  archived_at BIGINT NOT NULL,
  PRIMARY KEY (namespace, id)
)`,
  // list(): newest first, then by workflow, by state, by both.
  `CREATE INDEX qcloud_workflow_executions_created_idx
  ON qcloud_workflow_executions(namespace, created_at DESC, id DESC)`,
  `CREATE INDEX qcloud_workflow_executions_name_idx
  ON qcloud_workflow_executions(namespace, workflow_name, created_at DESC, id DESC)`,
  `CREATE INDEX qcloud_workflow_executions_state_idx
  ON qcloud_workflow_executions(namespace, state, created_at DESC, id DESC)`,
  `CREATE INDEX qcloud_workflow_executions_name_state_idx
  ON qcloud_workflow_executions(namespace, workflow_name, state, created_at DESC, id DESC)`,
  // listRecoverable(), cleanup() and archive(): a state, oldest progress first.
  `CREATE INDEX qcloud_workflow_executions_progress_idx
  ON qcloud_workflow_executions(namespace, state, updated_at, id)`,
  // findChild(): the first child of a parent that runs a workflow.
  `CREATE INDEX qcloud_workflow_executions_child_idx
  ON qcloud_workflow_executions(namespace, parent_execution_id, workflow_name, created_at, id)
  WHERE parent_execution_id IS NOT NULL`,
  // claimDueWaits(): parked runs by deadline.
  `CREATE INDEX qcloud_workflow_executions_wait_idx
  ON qcloud_workflow_executions(namespace, wait_deadline, id)
  WHERE state = 'waiting' AND wait_deadline IS NOT NULL`,
];
