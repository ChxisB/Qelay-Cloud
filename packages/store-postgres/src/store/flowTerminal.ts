import type { Ring } from '@qelay-cloud/core';
import { MAX_FLOW_DEPTH, StoreError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext, TerminalChange, TerminalHook } from './context';
import type { StoreEvent } from './events';
import type { ParentRow } from './flowResolve';
import {
  allResolved,
  dropEdges,
  failParent,
  lockParents,
  recordFailure,
  releaseParent,
} from './flowResolve';

// Adapted from Qelay's `dependencyPromotion.ts` and `flowFailures.ts` (see docs/PORTING.md).

type Mode = 'fail' | 'continue' | 'ignore' | 'remove';

/** The policy of each edge from `parentId` to the failed `childIds`. A child with none is not in the map. */
async function edgeModes(
  tx: TransactionSQL,
  namespace: string,
  parentId: string,
  childIds: readonly string[]
): Promise<Map<string, Mode>> {
  if (childIds.length === 0) return new Map();
  const rows = await tx<Array<{ dependency_id: string; on_failure: Mode | null }>>`
    SELECT dependency_id, on_failure FROM qcloud_dependencies
    WHERE namespace = ${namespace} AND job_id = ${parentId}
      AND dependency_id = ANY(${tx.array([...childIds], 'TEXT')})`;
  return new Map(
    rows.flatMap((row) => (row.on_failure === null ? [] : [[row.dependency_id, row.on_failure]]))
  );
}

/**
 * Records the failures that keep a trace (`continue`, `ignore`) and drops the edges of every child
 * whose policy lets go of it (`continue`, `ignore`, `remove`).
 */
async function settleEdges(
  tx: TransactionSQL,
  namespace: string,
  parentId: string,
  continued: readonly TerminalChange[],
  ignored: readonly TerminalChange[],
  removed: readonly TerminalChange[],
  now: number
): Promise<void> {
  for (const change of continued)
    await recordFailure(tx, namespace, parentId, change, 'continue', now);
  for (const change of ignored) await recordFailure(tx, namespace, parentId, change, 'ignore', now);
  await dropEdges(
    tx,
    namespace,
    parentId,
    [...continued, ...ignored, ...removed].map((change) => change.jobId)
  );
}

interface Settled {
  readonly events: StoreEvent[];
  readonly rings: Ring[];
  /** The parent failed: its own parent reacts to it next. */
  readonly failed: TerminalChange | null;
}

/**
 * Applies what a parent's finished children did to it. Failure precedence is upstream's: `fail`, then
 * `continue`, then `ignore`, then `remove`.
 * - `fail`: the parent fails with `Child job <id> failed: <error>`.
 * - `continue`: the failure is recorded, the child's edge dropped, and the parent is released whatever
 *   its other children are doing. Their edges stay, so what has completed stays readable.
 * - `ignore`: the failure is recorded and the child's edge dropped.
 * - `remove`: the child's edge is dropped, nothing recorded.
 * - no policy: nothing changes: the parent keeps waiting for a child that will not complete.
 * Then the parent is released when every edge it has left is complete (this is the completion path:
 * a completed child changes nothing but the evidence this reads). A parent that was released already
 * (it continued past a sibling's failure) gets the edge settling of `continue`, `ignore` and `remove`
 * for a child that fails later, and nothing else: it cannot be failed or released again.
 */
async function settleParent(
  ctx: StoreContext,
  tx: TransactionSQL,
  parent: ParentRow,
  changes: readonly TerminalChange[],
  now: number
): Promise<Settled> {
  const { namespace } = ctx;
  const failures = changes.filter((change) => change.outcome === 'failed');
  const modes = await edgeModes(
    tx,
    namespace,
    parent.id,
    failures.map((change) => change.jobId)
  );
  const withMode = (mode: Mode) => failures.filter((change) => modes.get(change.jobId) === mode);

  const [failing] = parent.state === 'waiting-children' ? withMode('fail') : [];
  if (failing) {
    const message = `Child job ${failing.jobId} failed: ${failing.error ?? 'unknown error'}`;
    const { event, change } = await failParent(ctx, tx, parent, message, now);
    return { events: [event], rings: [], failed: change };
  }
  const continued = withMode('continue');
  const ignored = withMode('ignore');
  await settleEdges(tx, namespace, parent.id, continued, ignored, withMode('remove'), now);
  // Released already (a sibling continued past its failure): the edges that are left settled above,
  // but the parent is neither failed nor released a second time.
  if (parent.state !== 'waiting-children') return { events: [], rings: [], failed: null };

  if (continued.length === 0 && !(await allResolved(tx, namespace, parent.id))) {
    return { events: [], rings: [], failed: null };
  }
  const released = await releaseParent(ctx, tx, parent, now);
  return { events: [released.event], rings: released.ring ? [released.ring] : [], failed: null };
}

/**
 * The terminal hook that makes flows work (`StoreContext.onTerminal`): runs in the transaction of every
 * completion, terminal failure and recovery, after the job's own writes. For each finished job that has
 * a parent it locks the parent, applies the job's failure policy, and releases the parent when nothing
 * it waits for is left, so a parent is never claimable for a child whose completion rolled back and
 * two children finishing together release it exactly once. A parent that fails is itself a failed job
 * for its own parent, and so on up the flow, in the same transaction. Returns the rings of released
 * parents; the caller hands them back with its own.
 */
export const resolveFlows = async (
  ctx: StoreContext,
  tx: TransactionSQL,
  changes: readonly TerminalChange[],
  now: number
): Promise<readonly Ring[]> => {
  const rings: Ring[] = [];
  const events: StoreEvent[] = [];
  let pending = changes.filter((change) => change.parentId !== null);
  for (let level = 0; pending.length > 0; level++) {
    if (level > MAX_FLOW_DEPTH)
      throw new StoreError('a flow failure went up more levels than a flow has');
    const byParent = new Map<string, TerminalChange[]>();
    for (const change of pending) {
      byParent.set(change.parentId!, [...(byParent.get(change.parentId!) ?? []), change]);
    }
    const failing = [...byParent]
      .filter(([, group]) => group.some((change) => change.outcome === 'failed'))
      .map(([parentId]) => parentId);
    const parents = await lockParents(tx, ctx.namespace, [...byParent.keys()], failing);
    const next: TerminalChange[] = [];
    for (const [parentId, group] of [...byParent].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const parent = parents.get(parentId);
      if (!parent) continue;
      const settled = await settleParent(ctx, tx, parent, group, now);
      events.push(...settled.events);
      rings.push(...settled.rings);
      if (settled.failed) next.push(settled.failed);
    }
    // A parent that failed and has no parent of its own ends the climb.
    pending = next.filter((change) => change.parentId !== null);
  }
  if (events.length > 0) await ctx.recorder.record(tx, events, now);
  return rings;
};

/** `resolveFlows` as the hook the context carries. */
export const flowTerminalHook =
  (ctx: () => StoreContext): TerminalHook =>
  (tx, changes, now) =>
    resolveFlows(ctx(), tx, changes, now);
