import type { EnqueuedJob, FlatFlowNode } from '@qelay-cloud/core';
import { FlowError, MAX_FLOW_JOBS, StoreError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { customIds, lockAdmission, planAndWrite } from './enqueue';
import type { StoreEvent } from './events';
import { findById } from './lookup';
import { prepareJobs } from './prepare';
import { effectiveState, isLiveState, ringFor } from './state';

// Adapted from Qelay's `admissionParent.ts` and `src/client/flowPush.ts` (see docs/PORTING.md).

/**
 * What `addFlow` did: wrote the whole flow (`jobs`, one per node in the flat list's order), or found
 * the root already there under its custom id and wrote nothing (`created: false`, the live root).
 */
export type FlowAdded =
  | { readonly created: true; readonly jobs: readonly EnqueuedJob[] }
  | { readonly created: false; readonly root: EnqueuedJob };

/**
 * Writes a flow in one transaction: every job, the parents in `waiting-children`, the children's
 * `parent_id`, one dependency row per child carrying its failure policy. Either all of it is there or
 * none. Only the jobs that are claimable now carry a ring; a parent never does, it is rung when its
 * last child finishes (`flowResolve.ts`).
 *
 * Replay: a root with a custom id that is live is the answer, as for a plain `add`. Nothing is written,
 * so a flow submitted twice with the same root id has one parent. Any other node whose custom id is
 * live is refused (`FlowError`): a flow never adopts a job that already exists, which is what lets a
 * parent's readiness be decided from the rows this call wrote. A finished job with a node's custom id
 * is replaced, as for a plain `add`.
 */
export async function addFlow(
  ctx: StoreContext,
  nodes: readonly FlatFlowNode[]
): Promise<FlowAdded> {
  if (nodes.length === 0) throw new FlowError('a flow has at least one job');
  if (nodes.length > MAX_FLOW_JOBS) throw new FlowError(`a flow has at most ${MAX_FLOW_JOBS} jobs`);
  nodes.forEach((node, at) => {
    const orphan = node.parentIndex === null ? at !== 0 : node.parentIndex >= at;
    if (node.index !== at || orphan) throw new FlowError('the flow nodes are not in pre-order');
  });
  const prepared = prepareJobs(
    nodes.map((node) => node.job),
    ctx.codec,
    { ...ctx.limits, maxBatch: MAX_FLOW_JOBS }
  );
  return ctx.db.run('addFlow', (sql) =>
    sql.begin(async (tx): Promise<FlowAdded> => {
      await lockAdmission(ctx, tx, prepared);
      const now = await ctx.db.time.now(tx);
      const existing = await findById(tx, ctx.namespace, customIds(prepared));
      const root = prepared[0]!.customId === null ? undefined : existing.get(prepared[0]!.customId);
      if (root && isLiveState(root.state)) {
        const state = effectiveState(root.state, root.runAt, root.priority, now);
        await ctx.recorder.record(
          tx,
          [{ type: 'duplicated', queue: root.queue, jobId: root.id, state }],
          now
        );
        return { created: false, root: { id: root.id, created: false, state, ring: null } };
      }
      for (const job of prepared) {
        const held = job.customId === null ? undefined : existing.get(job.customId);
        if (held && isLiveState(held.state)) {
          throw new FlowError(
            `job "${held.id}" already exists and is not the root of this flow: ` +
              'a flow does not take over a job that is already there'
          );
        }
      }

      const plan = await planAndWrite(ctx, tx, prepared, now, existing);
      if (plan.inserts.length !== nodes.length) {
        throw new StoreError(`a flow of ${nodes.length} jobs planned ${plan.inserts.length}`);
      }
      const ids = plan.inserts.map((insert) => insert.id);
      await linkFlow(tx, ctx.namespace, nodes, ids);
      const parents = new Set(nodes.flatMap((node, at) => (node.hasChildren ? [ids[at]!] : [])));
      await ctx.recorder.record(
        tx,
        plan.events.map((event): StoreEvent =>
          event.type === 'pushed' && parents.has(event.jobId)
            ? { ...event, state: 'waiting-children' }
            : event
        ),
        now
      );
      return {
        created: true,
        jobs: plan.inserts.map((insert, at): EnqueuedJob => {
          const waiting = nodes[at]!.hasChildren;
          return {
            id: insert.id,
            created: true,
            state: waiting ? 'waiting-children' : insert.state,
            ring: waiting
              ? null
              : ringFor(
                  ctx.namespace,
                  insert.job.queue,
                  insert.id,
                  insert.runAt,
                  now,
                  ctx.ringWindowMs
                ),
          };
        }),
      };
    })
  );
}

/**
 * Turns the rows admission just wrote into a flow: the parents wait for children, each child names
 * its parent, and each (parent, child) pair gets a dependency row with the child's policy. A parent's
 * `run_at` keeps `created_at + delay`: its delay counts from the moment it is released.
 */
async function linkFlow(
  tx: TransactionSQL,
  namespace: string,
  nodes: readonly FlatFlowNode[],
  ids: readonly string[]
): Promise<void> {
  // A completion record left by an earlier job of one of these ids is not evidence about the new job.
  await tx`
    DELETE FROM qcloud_completions
    WHERE namespace = ${namespace} AND job_id = ANY(${tx.array([...ids], 'TEXT')})`;
  const edges = nodes.flatMap((node) =>
    node.parentIndex === null
      ? []
      : [{ parent: ids[node.parentIndex]!, child: ids[node.index]!, mode: node.mode ?? '' }]
  );
  if (edges.length === 0) return;
  await tx`
    UPDATE qcloud_jobs AS job SET parent_id = link.parent_id
    FROM unnest(${tx.array(
      edges.map((edge) => edge.child),
      'TEXT'
    )}, ${tx.array(
      edges.map((edge) => edge.parent),
      'TEXT'
    )}) AS link(child_id, parent_id)
    WHERE job.namespace = ${namespace} AND job.id = link.child_id`;
  const parentIds = [...new Set(edges.map((edge) => edge.parent))];
  await tx`
    UPDATE qcloud_jobs SET state = 'waiting-children', rung_at = NULL
    WHERE namespace = ${namespace} AND id = ANY(${tx.array(parentIds, 'TEXT')})`;
  await tagFlow(tx, namespace, nodes, ids, parentIds);
  await tx`
    INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id, on_failure)
    SELECT ${namespace}, edge.parent_id, edge.child_id, NULLIF(edge.mode, '')
    FROM unnest(${tx.array(
      edges.map((edge) => edge.parent),
      'TEXT'
    )}, ${tx.array(
      edges.map((edge) => edge.child),
      'TEXT'
    )}, ${tx.array(
      edges.map((edge) => edge.mode),
      'TEXT'
    )}) AS edge(parent_id, child_id, mode)`;
}

/**
 * Marks every job of the flow with its root and depth (`flow_root`, `flow_depth`, migration 7), and lets
 * go of the jobs that an earlier flow of the same ids left behind. A parent that was cancelled or
 * removed leaves its children running as plain jobs with a `parent_id` and `flow_root` that name it
 * (`operator.ts`); when a new flow takes one of those ids, those children are not its own, so they
 * are detached here and neither the flow's reads nor its actions see them. Their versions move: what
 * a reader sees of them changed.
 */
async function tagFlow(
  tx: TransactionSQL,
  namespace: string,
  nodes: readonly FlatFlowNode[],
  ids: readonly string[],
  parentIds: readonly string[]
): Promise<void> {
  const depths: number[] = [];
  for (const node of nodes) {
    depths.push(node.parentIndex === null ? 0 : depths[node.parentIndex]! + 1);
  }
  const root = ids[0]!;
  const own = tx.array([...ids], 'TEXT');
  await tx`
    UPDATE qcloud_jobs SET parent_id = NULL, flow_root = NULL, flow_depth = NULL, version = version + 1
    WHERE namespace = ${namespace} AND flow_root = ${root} AND NOT id = ANY(${own})`;
  await tx`
    UPDATE qcloud_jobs SET parent_id = NULL, flow_root = NULL, flow_depth = NULL, version = version + 1
    WHERE namespace = ${namespace} AND parent_id = ANY(${tx.array([...parentIds], 'TEXT')})
      AND NOT id = ANY(${own})`;
  await tx`
    UPDATE qcloud_jobs AS job SET flow_root = ${root}, flow_depth = tag.depth
    FROM unnest(${own}, ${tx.array(depths, 'INTEGER')}) AS tag(id, depth)
    WHERE job.namespace = ${namespace} AND job.id = tag.id`;
}
