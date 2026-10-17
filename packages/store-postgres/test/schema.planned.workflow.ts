import type { Planned } from './schema.planned';

const T = 'qcloud_workflow_executions';
const D = 'qcloud_workflow_definitions';
const PER_STATE = `unnest(ARRAY['running', 'waiting', 'compensating', 'compensation-stuck', 'failed']::text[])`;

/**
 * The query paths of the workflow store (task 60). The statements are written out here as the store
 * runs them (`workflowCrud.ts`, `workflowList.ts`, `workflowSignals.ts`, `workflowRetention.ts`), with
 * the values the store binds filled in; a change to one of them is a change to its row.
 */
export const PLANNED_WORKFLOW: readonly Planned[] = [
  {
    query: 'workflow get, update and remove: one run by id',
    sql: `SELECT id FROM ${T} WHERE namespace = 'ns' AND id = 'x77'`,
    index: `${T}_pkey`,
  },
  {
    query: 'workflow list: newest first, a page at a time',
    sql: `SELECT id FROM ${T} WHERE namespace = 'ns'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_created_idx`,
    ordered: true,
  },
  {
    query: 'workflow summaries: one run by id, without its blobs',
    sql: `SELECT id, workflow_name, state, wait_event, wait_deadline FROM ${T}
          WHERE namespace = 'ns' AND id = 'x77'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_pkey`,
  },
  {
    query: "workflow list: one workflow's runs, newest first",
    sql: `SELECT id FROM ${T} WHERE namespace = 'ns' AND workflow_name = 'order'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_name_idx`,
    ordered: true,
  },
  {
    query: 'workflow list: the runs in one state, newest first',
    sql: `SELECT id FROM ${T} WHERE namespace = 'ns' AND state = 'failed'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_state_idx`,
    ordered: true,
  },
  {
    query: "workflow list: one workflow's runs in one state, newest first",
    sql: `SELECT id FROM ${T} WHERE namespace = 'ns' AND workflow_name = 'order' AND state = 'failed'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_name_state_idx`,
    ordered: true,
  },
  {
    query: "workflow listActive: one workflow's runs that keep its definition in use",
    sql: `SELECT id FROM ${T}
          WHERE namespace = 'ns' AND workflow_name = 'order'
            AND state = ANY(ARRAY['running', 'waiting', 'compensating', 'compensation-stuck', 'failed']::text[])
            AND (state <> 'failed' OR rollback_status IS NULL)
          ORDER BY updated_at, id`,
    index: `${T}_name_state_idx`,
    alternatives: [`${T}_name_idx`, `${T}_progress_idx`],
  },
  {
    query: 'workflow recovery: one state, oldest progress first, stopped at the limit',
    sql: `SELECT id FROM ${T}
          WHERE namespace = 'ns' AND state = 'waiting' AND updated_at <= 9000000
          ORDER BY updated_at, id LIMIT 1000`,
    index: `${T}_progress_idx`,
    ordered: true,
  },
  {
    query: 'workflow recovery: the best of one index range per state',
    sql: `SELECT x.id FROM ${PER_STATE} AS s(state)
          CROSS JOIN LATERAL (
            SELECT e.id, e.updated_at FROM ${T} e
            WHERE e.namespace = 'ns' AND e.state = s.state AND e.updated_at <= 9000000
              AND (e.state <> 'failed' OR e.rollback_status IS NULL)
              AND (e.parent_execution_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM ${T} p WHERE p.namespace = e.namespace AND p.id = e.parent_execution_id))
            ORDER BY e.updated_at, e.id LIMIT 1000
          ) x
          ORDER BY x.updated_at, x.id LIMIT 1000`,
    index: `${T}_progress_idx`,
  },
  {
    query: 'workflow retention: finished runs past their age, oldest first, per state',
    sql: `SELECT x.id FROM unnest(ARRAY['completed', 'failed']::text[]) AS s(state)
          CROSS JOIN LATERAL (
            SELECT e.id, e.updated_at FROM ${T} e
            WHERE e.namespace = 'ns' AND e.state = s.state AND e.updated_at <= 5000
            ORDER BY e.updated_at, e.id LIMIT 1000
          ) x
          ORDER BY x.updated_at, x.id LIMIT 1000`,
    index: `${T}_progress_idx`,
  },
  {
    query: 'workflow findChild: the first child of a run that runs a workflow',
    sql: `SELECT id FROM ${T}
          WHERE namespace = 'ns' AND parent_execution_id = 'x7' AND workflow_name = 'order'
          ORDER BY created_at, id LIMIT 1`,
    index: `${T}_child_idx`,
    ordered: true,
  },
  {
    query: 'workflow claimDueWaits: parked runs past their deadline, earliest first',
    sql: `SELECT id FROM ${T}
          WHERE namespace = 'ns' AND state = 'waiting' AND wait_deadline IS NOT NULL
            AND wait_deadline <= 5000 AND (wait_lease_until IS NULL OR wait_lease_until <= 5000)
          ORDER BY wait_deadline, id LIMIT 100 FOR UPDATE SKIP LOCKED`,
    index: `${T}_wait_idx`,
    ordered: true,
  },
  {
    query: 'workflow getArchivedCount: how many runs the archive holds',
    sql: `SELECT count(*)::int AS n FROM ${T}_archive WHERE namespace = 'ns'`,
    index: `${T}_archive_pkey`,
  },
  {
    query:
      "workflow summaries: one workflow's runs in one state, scalar columns only, newest first",
    sql: `SELECT id, workflow_name, state, definition_hash, parent_execution_id, current_node_index,
                 rollback_status, failure_reason, committed_at, version, created_at, updated_at,
                 wait_event, wait_deadline
          FROM ${T} WHERE namespace = 'ns' AND workflow_name = 'order' AND state = 'failed'
          ORDER BY created_at DESC, id DESC LIMIT 100 OFFSET 0`,
    index: `${T}_name_state_idx`,
    ordered: true,
  },
  {
    // One pass over the namespace's runs, which retention keeps bounded. `ordered` turns bitmap scans
    // off, so the plan shows that the index alone can answer it (an index-only scan).
    query: 'workflow counts: runs per workflow and state, from the index alone',
    sql: `SELECT workflow_name, state, count(*)::bigint AS n FROM ${T} WHERE namespace = 'ns'
          GROUP BY workflow_name, state`,
    index: `${T}_name_state_idx`,
    ordered: true,
  },
  {
    query: 'workflow liveDefinitions: the live runs per workflow and definition hash',
    sql: `SELECT workflow_name, definition_hash, count(*)::bigint AS n FROM ${T}
          WHERE namespace = 'ns'
            AND state IN ('running', 'waiting', 'compensating', 'compensation-stuck')
          GROUP BY workflow_name, definition_hash`,
    index: `${T}_live_idx`,
  },
  {
    query: "workflow definitions: one workflow's announced hashes, newest first",
    sql: `SELECT name, hash FROM ${D} WHERE namespace = 'ns' AND name = 'order'
          ORDER BY last_seen_at DESC, hash COLLATE "C"`,
    index: `${D}_pkey`,
  },
  {
    query: 'workflow definitions: the newest to keep, and the old ones past them',
    sql: `DELETE FROM ${D}
          WHERE namespace = 'ns' AND name = 'order' AND last_seen_at < 9000
            AND hash NOT IN (SELECT hash FROM ${D} WHERE namespace = 'ns' AND name = 'order'
                             ORDER BY last_seen_at DESC, hash COLLATE "C" LIMIT 20)`,
    index: `${D}_pkey`,
  },
];
