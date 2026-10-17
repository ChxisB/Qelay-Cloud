import { FLOW_VIEW_ERROR_CHARS } from '@qelay-cloud/core';

/**
 * The statements behind the flow reads in `flowView.ts`. Each is bounded: the list reads one page of roots
 * from `qcloud_jobs_flow_roots_idx` and the jobs of that page from `qcloud_jobs_flow_idx`, and a flow is read
 * with a `LIMIT`. Nothing here walks `parent_id`. Their plans are checked in `test/schema.planned.flow.ts`.
 */

/** The state a reader reports, in SQL: a stored `delayed` row past its time is claimable. Parameter 3 is now. */
const EFFECTIVE_STATE = `CASE WHEN state IN ('waiting', 'prioritized', 'delayed')
    THEN CASE WHEN run_at > $3 THEN 'delayed' WHEN priority > 0 THEN 'prioritized' ELSE 'waiting' END
    ELSE state END`;

/** The roots of the flows, newest first. Parameters: namespace, limit, offset. */
export const FLOW_ROOTS = `
  SELECT id, queue, payload, state, run_at, priority, created_at, version
  FROM qcloud_jobs
  WHERE namespace = $1 AND flow_depth = 0
  ORDER BY created_at DESC, id DESC
  LIMIT $2 OFFSET $3`;

/** The number of flows. Parameter: namespace. */
export const FLOW_ROOT_COUNT = `
  SELECT count(*)::bigint AS total FROM qcloud_jobs WHERE namespace = $1 AND flow_depth = 0`;

/** Stored jobs of the given flows by state. Parameters: namespace, root ids, now. */
export const FLOW_STATE_COUNTS = `
  SELECT flow_root AS root, ${EFFECTIVE_STATE} AS state, count(*)::bigint AS total
  FROM qcloud_jobs
  WHERE namespace = $1 AND flow_root = ANY($2::text[])
  GROUP BY 1, 2`;

/** Failed children that hold a waiting parent back, by flow. Parameters: namespace, root ids. */
export const FLOW_BLOCKED_COUNTS = `
  SELECT child.flow_root AS root, count(*)::bigint AS total
  FROM qcloud_jobs AS child
  JOIN qcloud_dependencies AS edge
    ON edge.namespace = child.namespace AND edge.dependency_id = child.id AND edge.on_failure IS NULL
  JOIN qcloud_jobs AS parent
    ON parent.namespace = edge.namespace AND parent.id = edge.job_id AND parent.state = 'waiting-children'
  WHERE child.namespace = $1 AND child.flow_root = ANY($2::text[]) AND child.state = 'failed'
  GROUP BY 1`;

/** The jobs of one flow, top level first. Parameters: namespace, root id, limit. */
export const FLOW_NODES = `
  SELECT id, queue, state, run_at, priority, version, parent_id, flow_depth, attempts, created_at,
         completed_at, left(error, ${FLOW_VIEW_ERROR_CHARS}) AS error
  FROM qcloud_jobs
  WHERE namespace = $1 AND flow_root = $2
  ORDER BY flow_depth, id
  LIMIT $3`;

/** How many jobs a flow has, counted up to a cap. Parameters: namespace, root id, cap. */
export const FLOW_NODE_COUNT = `
  SELECT count(*)::bigint AS total FROM (
    SELECT 1 FROM qcloud_jobs WHERE namespace = $1 AND flow_root = $2 LIMIT $3
  ) AS counted`;

/** The edges that point at the given jobs, with the state of the parent. Parameters: namespace, child ids. */
export const FLOW_EDGES = `
  SELECT edge.dependency_id AS id, edge.on_failure AS mode, parent.state AS parent_state
  FROM qcloud_dependencies AS edge
  JOIN qcloud_jobs AS parent ON parent.namespace = edge.namespace AND parent.id = edge.job_id
  WHERE edge.namespace = $1 AND edge.dependency_id = ANY($2::text[])`;

/** Children that completed and were removed: only the edge and the completion record are left. Parameters: namespace, parent ids, limit. */
export const FLOW_REMOVED_CHILDREN = `
  SELECT edge.job_id AS parent, edge.dependency_id AS id, completion.queue, completion.completed_at,
         edge.on_failure AS mode
  FROM qcloud_dependencies AS edge
  JOIN qcloud_completions AS completion
    ON completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
  WHERE edge.namespace = $1 AND edge.job_id = ANY($2::text[])
    AND NOT EXISTS (
      SELECT 1 FROM qcloud_jobs AS job
      WHERE job.namespace = edge.namespace AND job.id = edge.dependency_id
    )
  ORDER BY edge.dependency_id
  LIMIT $3`;

/** The failures the given parents kept. Parameters: namespace, parent ids, limit. */
export const FLOW_KEPT_FAILURES = `
  SELECT parent_id, child_id, child_queue, mode, left(error, ${FLOW_VIEW_ERROR_CHARS}) AS error
  FROM qcloud_flow_failures
  WHERE namespace = $1 AND parent_id = ANY($2::text[])
  ORDER BY created_at, child_id
  LIMIT $3`;

/** The ids of a job's children, by `parent_id`. Parameters: namespace, parent id, limit. */
export const FLOW_CHILD_IDS = `
  SELECT id FROM qcloud_jobs WHERE namespace = $1 AND parent_id = $2 ORDER BY id LIMIT $3`;

/** The most roots one page lists. */
export const MAX_FLOW_ROOTS_PAGE = 100;
