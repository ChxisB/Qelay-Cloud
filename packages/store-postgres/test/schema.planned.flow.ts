import {
  CHILDREN_VALUES,
  DEPENDENCY_STATUS,
  FLOW_CHILDREN,
  FLOW_FAILURES,
} from '../src/store/flowReads';
import {
  FLOW_BLOCKED_COUNTS,
  FLOW_CHILD_IDS,
  FLOW_EDGES,
  FLOW_KEPT_FAILURES,
  FLOW_NODE_COUNT,
  FLOW_NODES,
  FLOW_REMOVED_CHILDREN,
  FLOW_ROOT_COUNT,
  FLOW_ROOTS,
  FLOW_STATE_COUNTS,
} from '../src/store/flowViewSql';
import type { Planned } from './schema.planned';

/**
 * The query paths of flows (task 50). The reads are the store's own text; the statements that settle a
 * parent are written inline in `flowResolve.ts` and `flowTerminal.ts` as tagged templates, so they are
 * repeated here as they are written there.
 */
export const PLANNED_FLOW: readonly Planned[] = [
  {
    query: 'flow: lock the parents of finished children that are still waiting',
    sql: `SELECT id, state, queue, payload, priority, run_at, created_at, parent_id FROM qcloud_jobs
          WHERE namespace = 'ns' AND id = ANY(ARRAY['p1', 'p2'])
            AND (state = 'waiting-children' OR id = ANY(ARRAY['p2']))
          ORDER BY id FOR UPDATE`,
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'flow: is every edge of a parent complete',
    sql: `SELECT NOT EXISTS (
            SELECT 1 FROM qcloud_dependencies AS edge
            WHERE edge.namespace = 'ns' AND edge.job_id = 'p1'
              AND NOT EXISTS (
                SELECT 1 FROM qcloud_completions AS completion
                WHERE completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
              )
          ) AS resolved`,
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow: the failure policy of the edges to some failed children',
    sql: `SELECT dependency_id, on_failure FROM qcloud_dependencies
          WHERE namespace = 'ns' AND job_id = 'p1' AND dependency_id = ANY(ARRAY['c1', 'c2'])`,
    index: 'qcloud_dependencies_pkey',
    alternatives: ['qcloud_dependencies_dependency_idx'],
  },
  {
    query: 'flow: drop the edges of a parent to some children',
    sql: `DELETE FROM qcloud_dependencies
          WHERE namespace = 'ns' AND job_id = 'p1' AND dependency_id = ANY(ARRAY['c1', 'c2'])`,
    index: 'qcloud_dependencies_pkey',
    alternatives: ['qcloud_dependencies_dependency_idx'],
  },
  {
    query: 'flow: drop every edge of a parent that failed or was removed',
    sql: `DELETE FROM qcloud_dependencies WHERE namespace = 'ns' AND job_id = 'p1'`,
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow: drop every recorded failure of a parent that failed or was removed',
    sql: `DELETE FROM qcloud_flow_failures WHERE namespace = 'ns' AND parent_id = 'p1'`,
    index: 'qcloud_flow_failures_pkey',
    alternatives: ['qcloud_flow_failures_parent_idx'],
  },
  {
    query: 'flow read: the results of the completed children of a parent',
    sql: CHILDREN_VALUES,
    params: ['ns', 'p1'],
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow read: every edge of a parent with the result of its child',
    sql: DEPENDENCY_STATUS,
    params: ['ns', 'p1'],
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow read: the recorded failures of a parent by mode',
    sql: FLOW_FAILURES,
    params: ['ns', 'p10', 'continue'],
    index: 'qcloud_flow_failures_pkey',
    // A parent has few recorded failures: the primary key's (namespace, parent_id) prefix is as good as the mode index.
    alternatives: ['qcloud_flow_failures_parent_idx'],
  },
  {
    query: 'flow read: the children of a level of a flow tree',
    sql: FLOW_CHILDREN,
    params: ['ns', '{p1,p2}'],
    index: 'qcloud_jobs_parent_idx',
  },
  // Task 51: what the control API shows of flows, and what an operator's action reads and locks.
  {
    query: 'flow view: a page of roots, newest first',
    sql: FLOW_ROOTS,
    params: ['ns', 25, 0],
    index: 'qcloud_jobs_flow_roots_idx',
    ordered: true,
  },
  {
    query: 'flow view: how many flows there are',
    sql: FLOW_ROOT_COUNT,
    params: ['ns'],
    index: 'qcloud_jobs_flow_roots_idx',
  },
  {
    query: 'flow view: the jobs of a page of flows by state',
    sql: FLOW_STATE_COUNTS,
    params: ['ns', '{fr1,fr2,fr3}', 5000],
    index: 'qcloud_jobs_flow_idx',
  },
  {
    query: 'flow view: the failed children that hold a waiting parent, for a page of flows',
    sql: FLOW_BLOCKED_COUNTS,
    params: ['ns', '{fr1,fr2,fr3}'],
    index: 'qcloud_jobs_flow_idx',
  },
  {
    query: 'flow view: the jobs of one flow, top level first, bounded',
    sql: FLOW_NODES,
    params: ['ns', 'fr1', 1001],
    index: 'qcloud_jobs_flow_idx',
    ordered: true,
  },
  {
    query: 'flow view: how many jobs one flow has, up to a cap',
    sql: FLOW_NODE_COUNT,
    params: ['ns', 'fr1', 50000],
    index: 'qcloud_jobs_flow_idx',
  },
  {
    query: 'flow view: the edges that point at the jobs listed',
    sql: FLOW_EDGES,
    params: ['ns', '{j1001,j1002}'],
    index: 'qcloud_dependencies_dependency_idx',
    alternatives: ['qcloud_dependencies_pkey'],
  },
  {
    query: 'flow view: children removed when they completed, under the parents listed',
    sql: FLOW_REMOVED_CHILDREN,
    params: ['ns', '{j1,j2}', 1000],
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow view: the failures the parents listed kept',
    sql: FLOW_KEPT_FAILURES,
    params: ['ns', '{p10,p11}', 1000],
    index: 'qcloud_flow_failures_pkey',
    alternatives: ['qcloud_flow_failures_parent_idx'],
  },
  {
    query: 'flow view: the children of a job by parent_id',
    sql: FLOW_CHILD_IDS,
    params: ['ns', 'p10', 100],
    index: 'qcloud_jobs_parent_idx',
  },
  {
    query: 'flow action: is this job the root of a flow',
    sql: `SELECT id FROM qcloud_jobs WHERE namespace = 'ns' AND id = 'fr1' AND flow_depth = 0`,
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'flow action: the jobs of a flow, deepest level first, bounded',
    sql: `SELECT id FROM qcloud_jobs WHERE namespace = 'ns' AND flow_root = 'fr1'
          ORDER BY flow_depth DESC, id DESC LIMIT 1001`,
    index: 'qcloud_jobs_flow_idx',
    ordered: true,
  },
  {
    query: 'flow action: lock the named jobs of a flow in order',
    sql: `SELECT id, queue, state, version, parent_id, flow_depth FROM qcloud_jobs
          WHERE namespace = 'ns' AND flow_root = 'fr1' AND id = ANY(ARRAY['fr1-1', 'fr1-2'])
          ORDER BY array_position(ARRAY['fr1-1', 'fr1-2'], id) FOR UPDATE`,
    index: 'qcloud_jobs_pkey',
    alternatives: ['qcloud_jobs_flow_idx'],
  },
  {
    query: 'flow action: what a retry checks of each failed child',
    sql: `SELECT job.id, job.parent_id, job.priority, job.queue,
            EXISTS (
              SELECT 1 FROM qcloud_dependencies AS edge
              WHERE edge.namespace = job.namespace AND edge.job_id = job.parent_id
                AND edge.dependency_id = job.id AND edge.on_failure IS NULL
            ) AS holds,
            (job.started_at IS NULL AND EXISTS (
              SELECT 1 FROM qcloud_jobs AS child
              WHERE child.namespace = job.namespace AND child.parent_id = job.id
            )) AS never_ran
          FROM qcloud_jobs AS job
          WHERE job.namespace = 'ns' AND job.id = ANY(ARRAY['fr1-1', 'fr1-2'])`,
    index: 'qcloud_jobs_pkey',
  },
  {
    query: 'flow action: the edges of a parent no completion covers, with the state of each child',
    sql: `SELECT edge.dependency_id AS id, job.queue, job.state, job.version, left(job.error, 10000) AS error
          FROM qcloud_dependencies AS edge
          LEFT JOIN qcloud_jobs AS job ON job.namespace = edge.namespace AND job.id = edge.dependency_id
          WHERE edge.namespace = 'ns' AND edge.job_id = 'p10'
            AND NOT EXISTS (
              SELECT 1 FROM qcloud_completions AS completion
              WHERE completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
            )
          ORDER BY edge.dependency_id`,
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow action: the edges that lead from the jobs of a removed flow',
    sql: `SELECT dependency_id AS id FROM qcloud_dependencies
          WHERE namespace = 'ns' AND job_id = ANY(ARRAY['fr1', 'fr1-1'])`,
    index: 'qcloud_dependencies_pkey',
  },
  {
    query: 'flow action: the completion records of a removed flow',
    sql: `DELETE FROM qcloud_completions WHERE namespace = $1 AND job_id = ANY($2::text[])`,
    params: ['ns', '{j1001,fr1}'],
    index: 'qcloud_completions_pkey',
    // Postgres 18 can skip-scan the queue index when the table holds one queue, as the seed does.
    alternatives: ['qcloud_completions_queue_idx'],
  },
];
