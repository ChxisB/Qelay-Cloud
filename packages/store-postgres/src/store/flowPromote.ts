import type { FlowActionResult, JobState } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { fence } from './flowActionSupport';
import type { ParentRow } from './flowResolve';
import { dropEdges, recordFailure, releaseParent } from './flowResolve';
import { assertVersion } from './operator';

/**
 * `promote`: lets a stuck parent run. A parent is stuck when every child it still waits for has failed
 * with no failure policy on its edge, so none of them will ever complete. The action treats each of
 * those failures as `ignore`: the failure is kept for the parent's processor to read
 * (`ignoredFailures`), the edge is dropped, and the parent is released. The failed children stay where
 * they are, in the DLQ.
 *
 * Outcomes, each refused whole with `not_stuck` and nothing changed:
 * - `not_waiting`: the parent is not `waiting-children` (it ran, failed, or was released already).
 * - `children_unfinished`: some child it waits for is waiting, delayed, active or has not been written
 *   (an edge with no job): the parent is not stuck, it is waiting. Releasing it now would run it while
 *   children still work, so the action never does; the ids are the unfinished children.
 * - `nothing_blocks`: no failed child holds it back.
 *
 * The caller names the parent and every failed child that holds it back, with their versions. A failed
 * child it did not name makes the request `unseen`, so the parent is not released on the strength of a
 * picture that was missing a child.
 *
 * Locks: only the parent row. The children are read under that lock, and a child that finishes at the
 * same moment waits for the parent lock after its own, so it either shows as unfinished here (and the
 * action refuses) or is settled afterwards by the terminal hook.
 */
export async function promoteParent(
  ctx: StoreContext,
  tx: TransactionSQL,
  root: string,
  parentId: string,
  versions: ReadonlyMap<string, number>
): Promise<FlowActionResult> {
  const { namespace } = ctx;
  const [parent] = await tx<Array<ParentRow & { readonly version: number | string | bigint }>>`
    SELECT id, state, queue, payload, priority, run_at, created_at, parent_id, version
    FROM qcloud_jobs
    WHERE namespace = ${namespace} AND id = ${parentId} AND flow_root = ${root}
    FOR UPDATE`;
  if (!parent) return { applied: false, refusal: { kind: 'foreign', ids: [parentId] } };
  // A caller that read the parent earlier learns that it moved, whatever state it is in now.
  assertVersion(parentId, parent, versions.get(parentId));
  if (parent.state !== 'waiting-children') return stuck('not_waiting', [parentId]);

  const open = await tx<Open[]>`
    SELECT edge.dependency_id AS id, job.queue, job.state, job.version, left(job.error, 10000) AS error
    FROM qcloud_dependencies AS edge
    LEFT JOIN qcloud_jobs AS job ON job.namespace = edge.namespace AND job.id = edge.dependency_id
    WHERE edge.namespace = ${namespace} AND edge.job_id = ${parentId}
      AND NOT EXISTS (
        SELECT 1 FROM qcloud_completions AS completion
        WHERE completion.namespace = edge.namespace AND completion.job_id = edge.dependency_id
      )
    ORDER BY edge.dependency_id`;
  const holding = open.filter((child) => child.state === 'failed');
  const refusal = fence(
    new Map<string, { readonly version: number | string | bigint }>([
      [parent.id, parent],
      ...holding.map((child): [string, { readonly version: number | string | bigint }] => [
        child.id,
        child,
      ]),
    ]),
    versions
  );
  if (refusal) return { applied: false, refusal };

  const unfinished = open.filter((child) => !holding.includes(child)).map((child) => child.id);
  if (unfinished.length > 0) return stuck('children_unfinished', unfinished);
  if (holding.length === 0) return stuck('nothing_blocks', []);

  const now = await ctx.db.time.now(tx);
  for (const child of holding) {
    await recordFailure(
      tx,
      namespace,
      parentId,
      {
        jobId: child.id,
        queue: child.queue!,
        parentId,
        outcome: 'failed',
        error: child.error ?? 'unknown error',
      },
      'ignore',
      now
    );
  }
  await dropEdges(
    tx,
    namespace,
    parentId,
    holding.map((child) => child.id)
  );
  const released = await releaseParent(ctx, tx, parent, now);
  await ctx.recorder.record(tx, [released.event], now);
  return {
    applied: true,
    changes: [
      {
        id: parentId,
        queue: parent.queue,
        from: 'waiting-children',
        to: released.event.state as JobState,
      },
    ],
    rings: released.ring ? [released.ring] : [],
  };
}

interface Open {
  readonly id: string;
  /** Null when the edge points at no job row and no completion record. */
  readonly queue: string | null;
  readonly state: string | null;
  readonly version: number | string | bigint;
  readonly error: string | null;
}

const stuck = (
  reason: 'not_waiting' | 'nothing_blocks' | 'children_unfinished',
  ids: readonly string[]
): FlowActionResult => ({ applied: false, refusal: { kind: 'not_stuck', reason, ids } });
