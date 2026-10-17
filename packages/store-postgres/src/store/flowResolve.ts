import type { Ring } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext, TerminalChange } from './context';
import { enforceDlqLimit } from './dlq';
import type { StoreEvent } from './events';
import { policyReader } from './policies';
import type { Envelope } from './prepare';
import { deleteJobRows } from './remove';
import type { DlqBlob } from './retryState';
import { initialState, ringFor } from './state';

// Adapted from Qelay's `dependencyPromotion.ts`, `dependencyDestruction.ts` and `flowFailures.ts` (see docs/PORTING.md).

/**
 * The steps that settle a flow parent: decide whether it can run, release it, fail it, drop the edge of
 * a child that is gone. The parent's row lock (`lockParents`) serializes every one of them, so
 * two children finishing together, or a child finishing while an operator cancels another, are
 * applied one after the other, each reading what the one before wrote. Never take a child's row lock
 * after a parent's: the order is child, then parent, then the parent's own parent.
 */

/** A parent the caller holds locked. */
export interface ParentRow {
  readonly id: string;
  /** `waiting-children`, unless the parent was locked through `lockParents`' `anyState`. */
  readonly state: string;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly priority: number;
  readonly run_at: number | string | bigint;
  readonly created_at: number | string | bigint;
  /** The parent's own parent, for a flow of more than two levels. */
  readonly parent_id: string | null;
}

/**
 * Locks the rows among `ids` that are `waiting-children`, plus the rows among `anyState` in whatever state
 * they are, in id order. A parent in any other state is not here: it was released, failed, cancelled or
 * never waited, and nothing about it changes. `anyState` is for the parents of children that failed: a
 * parent already released (`continueParentOnFailure`) still has edges for its other children, and a
 * late failure under `ignore` or `remove` must settle them, serialized against the parent's removal.
 * The state is rechecked after a lock wait (the statement's `WHERE` is evaluated again on the row's
 * newest version), so a parent another transaction just released is not returned as waiting.
 */
export async function lockParents(
  tx: TransactionSQL,
  namespace: string,
  ids: readonly string[],
  anyState: readonly string[] = []
): Promise<Map<string, ParentRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx<ParentRow[]>`
    SELECT id, state, queue, payload, priority, run_at, created_at, parent_id FROM qcloud_jobs
    WHERE namespace = ${namespace} AND id = ANY(${tx.array([...new Set(ids)], 'TEXT')})
      AND (state = 'waiting-children' OR id = ANY(${tx.array([...new Set(anyState)], 'TEXT')}))
    ORDER BY id
    FOR UPDATE`;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * True when every child the parent still has an edge to has completed: a completion record exists. The
 * caller holds the parent's lock, so the records are read after every earlier finisher committed.
 * A parent with no edges is resolved: nothing is left to wait for.
 */
export async function allResolved(
  tx: TransactionSQL,
  namespace: string,
  parentId: string
): Promise<boolean> {
  const [row] = await tx<Array<{ resolved: boolean }>>`
    SELECT NOT EXISTS (
      SELECT 1 FROM qcloud_dependencies AS edge
      WHERE edge.namespace = ${namespace} AND edge.job_id = ${parentId}
        AND NOT EXISTS (
          SELECT 1 FROM qcloud_completions AS completion
          WHERE completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
        )
    ) AS resolved`;
  return row!.resolved;
}

/** Deletes the edges from `parentId` to `childIds`. */
export async function dropEdges(
  tx: TransactionSQL,
  namespace: string,
  parentId: string,
  childIds: readonly string[]
): Promise<void> {
  if (childIds.length === 0) return;
  await tx`
    DELETE FROM qcloud_dependencies
    WHERE namespace = ${namespace} AND job_id = ${parentId}
      AND dependency_id = ANY(${tx.array([...childIds], 'TEXT')})`;
}

/** Records a child's failure for its parent to read, replacing an earlier one of the same child. */
export async function recordFailure(
  tx: TransactionSQL,
  namespace: string,
  parentId: string,
  child: TerminalChange,
  mode: 'ignore' | 'continue',
  now: number
): Promise<void> {
  await tx`
    INSERT INTO qcloud_flow_failures (namespace, parent_id, child_id, child_queue, mode, error, created_at)
    VALUES (${namespace}, ${parentId}, ${child.jobId}, ${child.queue}, ${mode},
            ${child.error ?? 'unknown error'}, ${now})
    ON CONFLICT (namespace, parent_id, child_id) DO UPDATE SET
      child_queue = excluded.child_queue, mode = excluded.mode, error = excluded.error,
      created_at = excluded.created_at`;
}

/** What settling a parent produced, for the caller to journal and ring. */
export interface Released {
  readonly event: StoreEvent;
  readonly ring: Ring | null;
}

/**
 * Releases a parent to run: `waiting`, `prioritized` or `delayed`, as for any job with its priority and
 * delay. Its delay counts from now, not from when the flow was added: while it waited, `run_at` held
 * `created_at + delay`, which is where the delay comes from. `rung_at` is cleared, so the caller's ring
 * or, failing that, the tick's next pass delivers a bell for it.
 */
export async function releaseParent(
  ctx: StoreContext,
  tx: TransactionSQL,
  parent: ParentRow,
  now: number
): Promise<Released> {
  const delay = Math.max(0, Number(parent.run_at) - Number(parent.created_at));
  const runAt = now + delay;
  const state = initialState(runAt, now, parent.priority);
  await tx`
    UPDATE qcloud_jobs SET state = ${state}, run_at = ${runAt}, rung_at = NULL, version = version + 1
    WHERE namespace = ${ctx.namespace} AND id = ${parent.id}`;
  return {
    event: { type: 'promoted', queue: parent.queue, jobId: parent.id, state },
    ring: ringFor(ctx.namespace, parent.queue, parent.id, runAt, now, ctx.ringWindowMs),
  };
}

/**
 * Fails a parent because a child failed: the job ends in the DLQ with the child's error, or is deleted
 * when it asked for `removeOnFail`. Its edges and recorded failures go (upstream's `failParent`), so no
 * job is held back for a parent that is over. No metric is counted: the parent never ran. Returns the
 * change a grandparent reacts to.
 */
export async function failParent(
  ctx: StoreContext,
  tx: TransactionSQL,
  parent: ParentRow,
  message: string,
  now: number
): Promise<{ readonly event: StoreEvent; readonly change: TerminalChange }> {
  const removed = (ctx.codec.decode(parent.payload) as Envelope).removeOnFail === true;
  if (removed) {
    await deleteJobRows(tx, ctx.namespace, [parent.id]);
  } else {
    await tx`
      DELETE FROM qcloud_flow_failures WHERE namespace = ${ctx.namespace} AND parent_id = ${parent.id}`;
    await tx`
      DELETE FROM qcloud_dependencies WHERE namespace = ${ctx.namespace} AND job_id = ${parent.id}`;
    const blob: DlqBlob = {
      v: 1,
      enteredAt: now,
      reason: 'explicit_fail',
      error: message,
      attempts: [],
    };
    await tx`
      UPDATE qcloud_jobs
      SET state = 'failed', completed_at = ${now}, rung_at = NULL, error = ${message},
          failure_reason = 'explicit_fail', dlq_entry = ${ctx.codec.encode(blob)},
          dlq_retry_state = NULL, version = version + 1
      WHERE namespace = ${ctx.namespace} AND id = ${parent.id}`;
    const { maxEntries } = await policyReader(tx, ctx)(parent.queue);
    await enforceDlqLimit(tx, ctx, parent.queue, maxEntries, now);
  }
  return {
    event: {
      type: 'failed',
      queue: parent.queue,
      jobId: parent.id,
      state: 'failed',
      error: message,
      ...(removed && { removed: true as const }),
    },
    change: {
      jobId: parent.id,
      queue: parent.queue,
      parentId: parent.parent_id,
      outcome: 'failed',
      error: message,
    },
  };
}

/**
 * A job with a parent was deleted without finishing (cancelled, expired): its edge goes, and the parent
 * is released if that was the last thing it waited for. Returns the rings for released parents; a caller
 * with nowhere to return them leaves them to the tick. In the caller's transaction, after the child's
 * own row lock.
 */
export async function releaseDeleted(
  ctx: StoreContext,
  tx: TransactionSQL,
  children: ReadonlyArray<{ readonly id: string; readonly parentId: string | null }>,
  now: number
): Promise<readonly Ring[]> {
  const byParent = new Map<string, string[]>();
  for (const child of children) {
    if (child.parentId === null) continue;
    byParent.set(child.parentId, [...(byParent.get(child.parentId) ?? []), child.id]);
  }
  if (byParent.size === 0) return [];
  const waiting = await lockParents(tx, ctx.namespace, [...byParent.keys()]);
  const rings: Ring[] = [];
  const events: StoreEvent[] = [];
  for (const [parentId, childIds] of [...byParent].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await dropEdges(tx, ctx.namespace, parentId, childIds);
    const parent = waiting.get(parentId);
    if (!parent || !(await allResolved(tx, ctx.namespace, parentId))) continue;
    const released = await releaseParent(ctx, tx, parent, now);
    events.push(released.event);
    if (released.ring) rings.push(released.ring);
  }
  if (events.length > 0) await ctx.recorder.record(tx, events, now);
  return rings;
}
