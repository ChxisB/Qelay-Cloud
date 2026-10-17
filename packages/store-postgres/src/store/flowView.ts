import type {
  FlowFailureMode,
  FlowFailureRecord,
  FlowRootsPage,
  FlowRootSummary,
  FlowView,
  FlowViewNode,
  JobState,
} from '@qelay-cloud/core';
import { DEFAULT_FLOW_VIEW_NODES, MAX_FLOW_VIEW_NODES } from '@qelay-cloud/core';
import type { StoreContext } from './context';
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
  MAX_FLOW_ROOTS_PAGE,
} from './flowViewSql';
import type { Envelope } from './prepare';
import { effectiveState } from './state';

/**
 * What the control API shows of flows: the list of flows with how each is doing, and one flow as a
 * list of jobs. The statements are in `flowViewSql.ts`; a flow is read with a `LIMIT`, top level first, so a
 * flow too large for the cap shows whole levels from the root down.
 */

type Count = number | string | bigint;

/** A flow is counted up to this many jobs. */
const NODE_COUNT_CAP = MAX_FLOW_VIEW_NODES * 10;

interface RootRow {
  readonly id: string;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly state: string;
  readonly run_at: Count;
  readonly priority: number;
  readonly created_at: Count;
  readonly version: Count;
}

const nameOf = (ctx: StoreContext, payload: Uint8Array): string | null => {
  try {
    const name = (ctx.codec.decode(payload) as Envelope).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
};

/** One page of the flows of the namespace, newest first, each with how its jobs are doing. */
export function listFlowRoots(
  ctx: StoreContext,
  page: { readonly limit: number; readonly offset?: number }
): Promise<FlowRootsPage> {
  const limit = Math.min(Math.max(1, Math.floor(page.limit)), MAX_FLOW_ROOTS_PAGE);
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  return ctx.db.run('flowRoots', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [rows, [count]] = await Promise.all([
      sql.unsafe<RootRow[]>(FLOW_ROOTS, [ctx.namespace, limit, offset]),
      sql.unsafe<Array<{ total: Count }>>(FLOW_ROOT_COUNT, [ctx.namespace]),
    ]);
    const roots = sql.array(
      rows.map((row) => row.id),
      'TEXT'
    );
    const [states, blocked] =
      rows.length === 0
        ? [[], []]
        : await Promise.all([
            sql.unsafe<Array<{ root: string; state: JobState; total: Count }>>(FLOW_STATE_COUNTS, [
              ctx.namespace,
              roots,
              now,
            ]),
            sql.unsafe<Array<{ root: string; total: Count }>>(FLOW_BLOCKED_COUNTS, [
              ctx.namespace,
              roots,
            ]),
          ]);
    const items = rows.map((row): FlowRootSummary => {
      const byState: Partial<Record<JobState, number>> = {};
      let total = 0;
      for (const entry of states) {
        if (entry.root !== row.id) continue;
        byState[entry.state] = Number(entry.total);
        total += Number(entry.total);
      }
      return {
        id: row.id,
        queue: row.queue,
        name: nameOf(ctx, row.payload),
        state: effectiveState(row.state, Number(row.run_at), row.priority, now),
        createdAt: Number(row.created_at),
        version: Number(row.version),
        total,
        states: byState,
        blocked: Number(blocked.find((entry) => entry.root === row.id)?.total ?? 0),
      };
    });
    return { items, total: Number(count!.total) };
  });
}

interface NodeRow {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly run_at: Count;
  readonly priority: number;
  readonly version: Count;
  readonly parent_id: string | null;
  readonly flow_depth: number;
  readonly attempts: number;
  readonly created_at: Count;
  readonly completed_at: Count | null;
  readonly error: string | null;
}

interface EdgeRow {
  readonly id: string;
  readonly mode: FlowFailureMode | null;
  readonly parent_state: string;
}

interface RemovedRow {
  readonly parent: string;
  readonly id: string;
  readonly queue: string;
  readonly completed_at: Count;
  readonly mode: FlowFailureMode | null;
}

/**
 * The flow whose root is `rootId`, or null when no flow has that root. At most `limit` jobs
 * (default `DEFAULT_FLOW_VIEW_NODES`, ceiling `MAX_FLOW_VIEW_NODES`): the stored jobs top level first, then the
 * children that were removed when they completed. `truncated` says some of the flow is not listed.
 */
export function flowView(
  ctx: StoreContext,
  rootId: string,
  options: { readonly limit?: number } = {}
): Promise<FlowView | null> {
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? DEFAULT_FLOW_VIEW_NODES)),
    MAX_FLOW_VIEW_NODES
  );
  return ctx.db.run('flowView', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [root] = await sql.unsafe<Array<{ id: string }>>(
      `SELECT id FROM qcloud_jobs WHERE namespace = $1 AND id = $2 AND flow_depth = 0`,
      [ctx.namespace, rootId]
    );
    if (!root) return null;
    const rows = await sql.unsafe<NodeRow[]>(FLOW_NODES, [ctx.namespace, rootId, limit + 1]);
    const stored = rows.slice(0, limit);
    const ids = stored.map((row) => row.id);
    const listed = sql.array(ids, 'TEXT');
    const [edges, removedRows, failureRows, [count]] = await Promise.all([
      sql.unsafe<EdgeRow[]>(FLOW_EDGES, [ctx.namespace, listed]),
      rows.length > limit
        ? Promise.resolve<RemovedRow[]>([])
        : sql.unsafe<RemovedRow[]>(FLOW_REMOVED_CHILDREN, [
            ctx.namespace,
            listed,
            limit - stored.length + 1,
          ]),
      sql.unsafe<
        Array<{
          parent_id: string;
          child_id: string;
          child_queue: string;
          mode: 'continue' | 'ignore';
          error: string;
        }>
      >(FLOW_KEPT_FAILURES, [ctx.namespace, listed, limit]),
      sql.unsafe<Array<{ total: Count }>>(FLOW_NODE_COUNT, [ctx.namespace, rootId, NODE_COUNT_CAP]),
    ]);
    const edgeOf = new Map(edges.map((edge) => [edge.id, edge]));
    const depthOf = new Map(stored.map((row) => [row.id, row.flow_depth]));
    const nodes: FlowViewNode[] = stored.map((row) => {
      const state = effectiveState(row.state, Number(row.run_at), row.priority, now);
      const edge = edgeOf.get(row.id);
      return {
        id: row.id,
        queue: row.queue,
        state,
        version: Number(row.version),
        parentId: row.parent_id,
        depth: row.flow_depth,
        attempts: row.attempts,
        createdAt: Number(row.created_at),
        completedAt: row.completed_at === null ? null : Number(row.completed_at),
        error: row.error,
        mode: edge?.mode ?? null,
        blocking:
          state === 'failed' && edge?.mode === null && edge.parent_state === 'waiting-children',
        removed: false,
      };
    });
    const room = limit - nodes.length;
    for (const row of removedRows.slice(0, Math.max(0, room))) {
      nodes.push({
        id: row.id,
        queue: row.queue,
        state: 'completed',
        version: null,
        parentId: row.parent,
        depth: (depthOf.get(row.parent) ?? 0) + 1,
        attempts: 0,
        createdAt: null,
        completedAt: Number(row.completed_at),
        error: null,
        mode: row.mode,
        blocking: false,
        removed: true,
      });
    }
    const failures: FlowFailureRecord[] = failureRows.map((row) => ({
      parentId: row.parent_id,
      childId: row.child_id,
      queue: row.child_queue,
      mode: row.mode,
      error: row.error,
    }));
    return {
      root: rootId,
      nodes,
      total: Number(count!.total),
      truncated: rows.length > limit || removedRows.length > Math.max(0, room),
      limit,
      failures,
    };
  });
}

/** The ids of the jobs that name `parentId` as their parent, at most `limit`, in id order. */
export function childIdsOf(
  ctx: StoreContext,
  parentId: string,
  limit: number
): Promise<readonly string[]> {
  return ctx.db.run('flowChildIds', async (sql) => {
    const rows = await sql.unsafe<Array<{ id: string }>>(FLOW_CHILD_IDS, [
      ctx.namespace,
      parentId,
      limit,
    ]);
    return rows.map((row) => row.id);
  });
}
