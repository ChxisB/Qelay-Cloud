import type { EnqueuedJob, NewFlowNode } from '@qelay-cloud/core';
import { flattenFlow } from '@qelay-cloud/core';
import type { SQL } from 'bun';
import type { PostgresStore } from '../src/postgresStore';
import type { TestStore } from './storeHelpers';

/** Adds a flow and returns its jobs in pre-order; fails the test if the root was already there. */
export async function addTree(
  store: Pick<PostgresStore, 'flows'>,
  tree: NewFlowNode
): Promise<readonly EnqueuedJob[]> {
  const added = await store.flows.add(flattenFlow(tree));
  if (!added.created) throw new Error('the flow was already there');
  return added.jobs;
}

/** A parent in `parentQueue` with `count` plain children in `childQueue`, each with the same options. */
export const fanOut = (
  count: number,
  options: {
    readonly parentQueue?: string;
    readonly childQueue?: string;
    readonly parent?: NewFlowNode['options'];
    readonly child?: NewFlowNode['options'];
  } = {}
): NewFlowNode => ({
  queue: options.parentQueue ?? 'parents',
  data: 'parent',
  options: { ...options.parent },
  children: Array.from({ length: count }, (_, at) => ({
    queue: options.childQueue ?? 'children',
    data: at,
    options: { ...options.child },
  })),
});

export interface JobSummary {
  readonly state: string;
  readonly parent_id: string | null;
  readonly rung_at: string | null;
}

export const summary = async (t: TestStore, id: string): Promise<JobSummary | undefined> =>
  (
    await t.fresh.sql<JobSummary[]>`
      SELECT state, parent_id, rung_at FROM qcloud_jobs WHERE id = ${id}`
  )[0];

export const edgesOf = async (t: TestStore, parent: string): Promise<string[]> =>
  (
    await t.fresh.sql<Array<{ dependency_id: string }>>`
      SELECT dependency_id FROM qcloud_dependencies WHERE job_id = ${parent} ORDER BY dependency_id`
  ).map((row) => row.dependency_id);

export interface RecordedFailure {
  readonly child_id: string;
  readonly mode: string;
  readonly error: string;
}

export const failuresOf = async (t: TestStore, parent: string): Promise<RecordedFailure[]> =>
  await t.fresh.sql<RecordedFailure[]>`
    SELECT child_id, mode, error FROM qcloud_flow_failures
    WHERE parent_id = ${parent} ORDER BY child_id`;

/** Claims one job of `queue` and completes it with `result`; returns the outcome. */
export async function finish(
  t: Pick<TestStore, 'store'>,
  queue: string,
  result: unknown = 'ok'
): Promise<{ readonly id: string; readonly rings: number }> {
  const [job] = await t.store.claim(queue, 'w', 1);
  if (!job) throw new Error(`nothing to claim in ${queue}`);
  const outcome = await t.store.complete(job.lease, result);
  return { id: job.id, rings: outcome.rings.length };
}

/** Claims one job of `queue` and fails it for good; returns its id and the outcome's ring count. */
export async function failFor(
  t: Pick<TestStore, 'store'>,
  queue: string,
  message = 'boom'
): Promise<{ readonly id: string; readonly rings: number }> {
  const [job] = await t.store.claim(queue, 'w', 1);
  if (!job) throw new Error(`nothing to claim in ${queue}`);
  const outcome = await t.store.fail(job.lease, { message, unrecoverable: true });
  return { id: job.id, rings: outcome.rings.length };
}

/**
 * What must never be true after any operation: an edge of a live parent to a job that is neither there
 * nor completed, an edge or a recorded failure of a parent that is gone, and a `waiting-children` parent
 * with no edge left to wait for. The edges of a parent that finished are history: the sweep of completion
 * records and the retention of jobs may remove what they point to.
 */
export async function flowDefectsIn(sql: SQL, namespace: string | null = null): Promise<string[]> {
  const rows = await sql<Array<{ defect: string }>>`
    SELECT 'dangling child ' || edge.job_id || ' -> ' || edge.dependency_id AS defect
    FROM qcloud_dependencies AS edge
    JOIN qcloud_jobs AS parent ON parent.namespace = edge.namespace AND parent.id = edge.job_id
    WHERE (${namespace}::text IS NULL OR edge.namespace = ${namespace})
      AND parent.state IN ('waiting-children', 'waiting', 'prioritized', 'delayed', 'active')
      AND NOT EXISTS (SELECT 1 FROM qcloud_jobs AS job
                      WHERE job.namespace = edge.namespace AND job.id = edge.dependency_id)
      AND NOT EXISTS (SELECT 1 FROM qcloud_completions AS done
                      WHERE done.namespace = edge.namespace AND done.job_id = edge.dependency_id)
    UNION ALL
    SELECT 'orphan edge from ' || edge.job_id
    FROM qcloud_dependencies AS edge
    WHERE (${namespace}::text IS NULL OR edge.namespace = ${namespace})
      AND NOT EXISTS (SELECT 1 FROM qcloud_jobs AS job
                      WHERE job.namespace = edge.namespace AND job.id = edge.job_id)
    UNION ALL
    SELECT 'orphan failure of ' || failure.parent_id
    FROM qcloud_flow_failures AS failure
    WHERE (${namespace}::text IS NULL OR failure.namespace = ${namespace})
      AND NOT EXISTS (SELECT 1 FROM qcloud_jobs AS job
                      WHERE job.namespace = failure.namespace AND job.id = failure.parent_id)
    UNION ALL
    SELECT 'stuck parent ' || parent.id
    FROM qcloud_jobs AS parent
    WHERE (${namespace}::text IS NULL OR parent.namespace = ${namespace})
      AND parent.state = 'waiting-children'
      AND NOT EXISTS (
        SELECT 1 FROM qcloud_dependencies AS edge
        WHERE edge.namespace = parent.namespace AND edge.job_id = parent.id
          AND NOT EXISTS (SELECT 1 FROM qcloud_completions AS done
                          WHERE done.namespace = edge.namespace AND done.job_id = edge.dependency_id))`;
  return rows.map((row) => row.defect);
}

export const flowDefects = (t: Pick<TestStore, 'fresh'>): Promise<string[]> =>
  flowDefectsIn(t.fresh.sql);
