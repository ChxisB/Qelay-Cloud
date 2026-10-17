import type { FlowActionResult, FlowChange, JobState } from '@qelay-cloud/core';
import { MAX_FLOW_JOBS } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import type { FlowRow } from './flowActionSupport';
import { fence, lockFlowRows } from './flowActionSupport';
import { removeEach } from './remove';

/**
 * Removes a whole flow: every job of it, its dependency edges, the failures its parents kept, the
 * logs, and the completion records of its children, in one transaction. Either every job is gone or
 * none is. A flow with a running job is refused whole, because a worker holds that job; the operator
 * waits for it or lets its lease run out.
 *
 * The caller names every job it read and the version it read it at. A job the flow has that the
 * caller did not name (`unseen`), or a version that moved, refuses the action, so a flow that grew, or
 * changed, since it was shown is not removed on the strength of the old picture.
 */
export async function removeFlow(
  ctx: StoreContext,
  tx: TransactionSQL,
  root: string,
  versions: ReadonlyMap<string, number>
): Promise<FlowActionResult> {
  const { namespace } = ctx;
  const listed = await tx<Array<{ id: string }>>`
    SELECT id FROM qcloud_jobs
    WHERE namespace = ${namespace} AND flow_root = ${root}
    ORDER BY flow_depth DESC, id DESC
    LIMIT ${MAX_FLOW_JOBS + 1}`;
  if (listed.length > MAX_FLOW_JOBS) {
    return { applied: false, refusal: { kind: 'too_large', limit: MAX_FLOW_JOBS } };
  }
  const rows = await lockFlowRows(
    tx,
    namespace,
    root,
    listed.map((row) => row.id)
  );
  const refusal = fence(rows, versions);
  if (refusal) return { applied: false, refusal };
  const running = [...rows.values()].filter((row) => row.state === 'active');
  if (running.length > 0) {
    return {
      applied: false,
      refusal: { kind: 'active', ids: running.map((row) => row.id).sort() },
    };
  }

  const now = await ctx.db.time.now(tx);
  const ids = [...rows.keys()];
  // Children that completed and were removed: only an edge and a completion record are left of them.
  const left = await tx<Array<{ id: string }>>`
    SELECT dependency_id AS id FROM qcloud_dependencies
    WHERE namespace = ${namespace} AND job_id = ANY(${tx.array(ids, 'TEXT')})`;
  await removeEach(tx, ctx, [...rows.values()].map(removedRow), 'flow removed', now);
  await tx`
    DELETE FROM qcloud_completions
    WHERE namespace = ${namespace}
      AND job_id = ANY(${tx.array([...ids, ...left.map((row) => row.id)], 'TEXT')})`;
  const changes: FlowChange[] = [...rows.values()]
    .sort((a, b) => b.flow_depth - a.flow_depth || (a.id < b.id ? -1 : 1))
    .map((row) => ({ id: row.id, queue: row.queue, from: row.state as JobState, to: 'removed' }));
  return { applied: true, changes, rings: [] };
}

const removedRow = (row: FlowRow) => ({
  id: row.id,
  queue: row.queue,
  state: row.state as JobState,
});
