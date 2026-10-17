import type { TransactionSQL } from 'bun';

/**
 * The rule every destructive action on a job follows: a job a live flow consumer still depends on is
 * not deleted. A consumer is a parent (or any job) with a row in `qcloud_dependencies` naming the job
 * as a dependency; it is live while it is pending, waiting on children or active. Once the consumer
 * is finished or gone, nothing waits on the job and it can go. Flows are enqueued by task 50; the
 * rule reads the rows that task writes, so it holds for them from the start.
 */

const LIVE_CONSUMER_STATES = `'waiting', 'prioritized', 'delayed', 'waiting-children', 'active'`;

/**
 * An `EXISTS` condition, true when a live consumer depends on the row `alias` stands for. `alias` is a
 * table alias written in this codebase, never input. Index-backed by
 * `qcloud_dependencies(namespace, dependency_id, job_id)` and the jobs primary key.
 */
export function hasLiveConsumer(alias: string): string {
  return `EXISTS (
      SELECT 1 FROM qcloud_dependencies AS dependency
      JOIN qcloud_jobs AS consumer
        ON consumer.namespace = dependency.namespace AND consumer.id = dependency.job_id
      WHERE dependency.namespace = ${alias}.namespace AND dependency.dependency_id = ${alias}.id
        AND consumer.state IN (${LIVE_CONSUMER_STATES})
    )`;
}

/** Which of `ids` a live consumer depends on. */
export async function protectedIds(
  tx: TransactionSQL,
  namespace: string,
  ids: readonly string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx<Array<{ id: string }>>`
    SELECT DISTINCT dependency.dependency_id AS id
    FROM qcloud_dependencies AS dependency
    JOIN qcloud_jobs AS consumer
      ON consumer.namespace = dependency.namespace AND consumer.id = dependency.job_id
    WHERE dependency.namespace = ${namespace}
      AND dependency.dependency_id = ANY(${tx.array([...ids], 'TEXT')})
      AND consumer.state IN (${tx.unsafe(LIVE_CONSUMER_STATES)})`;
  return new Set(rows.map((row) => row.id));
}

/**
 * One job of `queue` that a live consumer in another queue depends on, or a null `id`. A consumer in
 * the queue itself goes with it, so it does not count. The statement reads the namespace's flow edges
 * (`qcloud_dependencies` holds the edges of flows that have not finished) and looks the two jobs of
 * each edge up by primary key in a lateral subquery. The subquery's `LIMIT 1` keeps the planner from
 * flattening it into the join, so the cost follows the number of edges and never the size of the
 * queue. As a plain join, with `LIMIT 1` or without, the planner may start from the queue's jobs and
 * walk all of them. Parameters: namespace, queue.
 */
export const PROTECTED_BY_OUTSIDE_CONSUMER = `
  SELECT min(hit.id) AS id
  FROM qcloud_dependencies AS edge
  CROSS JOIN LATERAL (
    SELECT child.id
    FROM qcloud_jobs AS child
    JOIN qcloud_jobs AS consumer ON consumer.namespace = edge.namespace AND consumer.id = edge.job_id
    WHERE child.namespace = edge.namespace AND child.id = edge.dependency_id
      AND child.queue = $2 AND consumer.queue <> $2
      AND consumer.state IN (${LIVE_CONSUMER_STATES})
    LIMIT 1
  ) AS hit
  WHERE edge.namespace = $1`;
