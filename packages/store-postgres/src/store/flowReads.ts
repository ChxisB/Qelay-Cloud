import type { FlowDependencies, FlowTree, JobState } from '@qelay-cloud/core';
import { MAX_FLOW_DEPTH } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { effectiveState } from './state';

/**
 * What a flow parent reads about its children while it runs, and what the inspector reads about a whole
 * flow. Each is one bounded query per call (per level, for a tree), by primary key or the indexes of
 * `qcloud_dependencies`, `qcloud_flow_failures` and `qcloud_jobs_parent_idx` (planned in
 * `schema.planned.flow.ts`). Adapted from Qelay's `completionQueries.ts` and `flowFailures.ts` (see docs/PORTING.md).
 */

type Count = number | string | bigint;

/** The result of every child of a parent that completed. Parameters: namespace, parent id. */
export const CHILDREN_VALUES = `
  SELECT completion.queue, completion.job_id AS id, completion.result
  FROM qcloud_dependencies AS edge
  JOIN qcloud_completions AS completion
    ON completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
  WHERE edge.namespace = $1 AND edge.job_id = $2
  ORDER BY completion.job_id`;

/** Each edge of a parent with the result of its child, or none while it has not completed. Parameters: namespace, parent id. */
export const DEPENDENCY_STATUS = `
  SELECT COALESCE(completion.queue, child.queue) AS queue, edge.dependency_id AS id,
         completion.job_id IS NOT NULL AS done, completion.result
  FROM qcloud_dependencies AS edge
  LEFT JOIN qcloud_completions AS completion
    ON completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
  LEFT JOIN qcloud_jobs AS child
    ON child.namespace = edge.namespace AND child.id = edge.dependency_id
  WHERE edge.namespace = $1 AND edge.job_id = $2
  ORDER BY edge.dependency_id`;

/** The recorded failures of one mode, oldest first. Parameters: namespace, parent id, mode. */
export const FLOW_FAILURES = `
  SELECT child_queue AS queue, child_id AS id, error
  FROM qcloud_flow_failures
  WHERE namespace = $1 AND parent_id = $2 AND mode = $3
  ORDER BY created_at, child_id`;

/**
 * The children of a set of parents: the jobs that name one as `parent_id`, then children that only
 * their completion record is left of (a job removed on completion). Parameters: namespace, a text array of parent ids.
 */
export const FLOW_CHILDREN = `
  SELECT parent, id, queue, state, run_at, priority FROM (
    SELECT job.parent_id AS parent, job.id, job.queue, job.state, job.run_at, job.priority, 0 AS source
    FROM qcloud_jobs AS job
    WHERE job.namespace = $1 AND job.parent_id = ANY($2::text[])
    UNION ALL
    SELECT edge.job_id, edge.dependency_id, completion.queue, 'completed', completion.completed_at, 0, 1
    FROM qcloud_dependencies AS edge
    JOIN qcloud_completions AS completion
      ON completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
    WHERE edge.namespace = $1 AND edge.job_id = ANY($2::text[])
  ) AS children
  ORDER BY parent, source, id`;

interface ResultRow {
  readonly queue: string;
  readonly id: string;
  readonly result: Uint8Array | null;
}

const keyOf = (row: { readonly queue: string; readonly id: string }): string =>
  `${row.queue}:${row.id}`;

/** The results of the completed children of `parentId`, by `"<queue>:<id>"`. Empty for an unknown parent. */
export function childrenValues(
  ctx: StoreContext,
  parentId: string
): Promise<Record<string, unknown>> {
  return ctx.db.run('flowChildrenValues', async (sql) => {
    const rows = await sql.unsafe<ResultRow[]>(CHILDREN_VALUES, [ctx.namespace, parentId]);
    return Object.fromEntries(
      rows.map((row) => [keyOf(row), row.result === null ? null : ctx.codec.decode(row.result)])
    );
  });
}

/** The children `parentId` still waits for and the results of those that completed. */
export function dependencies(ctx: StoreContext, parentId: string): Promise<FlowDependencies> {
  return ctx.db.run('flowDependencies', async (sql) => {
    const rows = await sql.unsafe<Array<ResultRow & { done: boolean }>>(DEPENDENCY_STATUS, [
      ctx.namespace,
      parentId,
    ]);
    const processed: Record<string, unknown> = {};
    const unprocessed: string[] = [];
    for (const row of rows) {
      if (row.done)
        processed[keyOf(row)] = row.result === null ? null : ctx.codec.decode(row.result);
      else if (row.queue !== null) unprocessed.push(keyOf(row));
    }
    return { processed, unprocessed };
  });
}

/**
 * The errors of the children whose failure was recorded under `mode`, by `"<queue>:<id>"`:
 * `continue` for `getFailedChildrenValues`, `ignore` for `getIgnoredChildrenFailures`.
 */
export function recordedFailures(
  ctx: StoreContext,
  parentId: string,
  mode: 'continue' | 'ignore'
): Promise<Record<string, string>> {
  return ctx.db.run('flowFailures', async (sql) => {
    const rows = await sql.unsafe<Array<{ queue: string; id: string; error: string }>>(
      FLOW_FAILURES,
      [ctx.namespace, parentId, mode]
    );
    return Object.fromEntries(rows.map((row) => [keyOf(row), row.error]));
  });
}

interface ChildRow {
  readonly parent: string;
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly run_at: Count;
  readonly priority: number;
}

/** How much of a flow `flowTree` reads, as upstream's `getFlow` options. */
export interface FlowTreeLimits {
  /** Levels read below the root: 0 is the root alone. Default and ceiling: the deepest flow there can be. */
  readonly depth?: number;
  /** Children read per job, in the order they were listed (completed-and-removed ones last). Default: all. */
  readonly maxChildren?: number;
}

/**
 * The flow whose root is `rootId`, as it is now, one query per level, at most `MAX_FLOW_DEPTH` levels
 * (fewer with `limits.depth`). A job is listed once, under the first parent that names it. Null when
 * there is no such job.
 */
export async function flowTree(
  ctx: StoreContext,
  rootId: string,
  limits: FlowTreeLimits = {}
): Promise<FlowTree | null> {
  const levels = Math.min(limits.depth ?? MAX_FLOW_DEPTH, MAX_FLOW_DEPTH - 1);
  const perParent = limits.maxChildren ?? Infinity;
  for (const [name, value] of [
    ['depth', limits.depth],
    ['maxChildren', limits.maxChildren],
  ] as const) {
    if (value !== undefined && !(value >= 0))
      throw new RangeError(`${name} must be a number of 0 or more`);
  }
  return ctx.db.run('flowTree', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [root] = await sql.unsafe<ChildRow[]>(
      `SELECT NULL AS parent, id, queue, state, run_at, priority FROM qcloud_jobs
       WHERE namespace = $1 AND id = $2`,
      [ctx.namespace, rootId]
    );
    if (!root) return null;
    interface Mutable {
      id: string;
      queue: string;
      state: JobState;
      children: Mutable[];
    }
    const node = (row: ChildRow): Mutable => ({
      id: row.id,
      queue: row.queue,
      state: effectiveState(row.state, Number(row.run_at), row.priority, now),
      children: [],
    });
    const top = node(root);
    const seen = new Set<string>([rootId]);
    let level = new Map<string, Mutable>([[rootId, top]]);
    for (let depth = 1; depth <= levels && level.size > 0 && perParent > 0; depth++) {
      const rows = await sql.unsafe<ChildRow[]>(FLOW_CHILDREN, [
        ctx.namespace,
        sql.array([...level.keys()], 'TEXT'),
      ]);
      const next = new Map<string, Mutable>();
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        const siblings = level.get(row.parent)?.children;
        if (!siblings || siblings.length >= perParent) continue;
        seen.add(row.id);
        const child = node(row);
        siblings.push(child);
        next.set(row.id, child);
      }
      level = next;
    }
    return top;
  });
}
