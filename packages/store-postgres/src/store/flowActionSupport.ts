import type { FlowJobVersion, FlowRefusal } from '@qelay-cloud/core';
import { JobVersionError, UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';

/**
 * What the flow actions share (`flowActions.ts`). Every action works inside one transaction and
 * decides everything before it writes, so a refusal changes nothing and a failure part-way rolls
 * back what was written: a flow is changed whole or not at all.
 *
 * Lock order is the flow's own: a child before its parent, the deepest level first, the same order
 * the terminal hook takes (`flowResolve.ts`), so an action and a worker finishing a job of the flow
 * wait for each other without a deadlock.
 */

type Count = number | string | bigint;

/** A job of the flow, read under its lock. */
export interface FlowRow {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly version: Count;
  readonly parent_id: string | null;
  readonly flow_depth: number;
}

/** True when `id` is the root of a flow (the root is the job that names itself and has depth 0). */
export async function isFlowRoot(
  tx: TransactionSQL,
  namespace: string,
  id: string
): Promise<boolean> {
  const [row] = await tx<Array<{ id: string }>>`
    SELECT id FROM qcloud_jobs WHERE namespace = ${namespace} AND id = ${id} AND flow_depth = 0`;
  return row !== undefined;
}

/**
 * Locks the jobs of the flow `root` named in `ids`, in the order of `ids`, and returns the ones that
 * are still in it. A job that was removed, or that left the flow, since `ids` was read is not here:
 * the lock wait re-evaluates the `WHERE` against the row's newest version.
 */
export async function lockFlowRows(
  tx: TransactionSQL,
  namespace: string,
  root: string,
  ids: readonly string[]
): Promise<Map<string, FlowRow>> {
  if (ids.length === 0) return new Map();
  const list = tx.array([...ids], 'TEXT');
  const rows = await tx<FlowRow[]>`
    SELECT id, queue, state, version, parent_id, flow_depth FROM qcloud_jobs
    WHERE namespace = ${namespace} AND flow_root = ${root} AND id = ANY(${list})
    ORDER BY array_position(${list}, id)
    FOR UPDATE`;
  return new Map(rows.map((row) => [row.id, row]));
}

/** The version each job in a request was read at. Throws when a job is named twice or a version is not a count. */
export function versionsOf(jobs: readonly FlowJobVersion[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const job of jobs) {
    if (!Number.isSafeInteger(job.expectedVersion) || job.expectedVersion < 0) {
      throw new UnsupportedOptionError('expectedVersion', 'must be an integer from 0');
    }
    if (versions.has(job.id)) {
      throw new UnsupportedOptionError('jobs', `names job ${job.id} twice`);
    }
    versions.set(job.id, job.expectedVersion);
  }
  return versions;
}

/**
 * The fence of a flow action: `rows` are the jobs the action touches, locked, and `versions` what the
 * caller read.
 * - A job whose version moved throws `JobVersionError` first (as for one job: a caller that read a
 *   job earlier always learns that it moved), and the transaction rolls back.
 * - A job named but not touched is `foreign`: it is not in the flow, or it is gone.
 * - A job touched but not named is `unseen`: the caller never saw it, so the flow is not what it read.
 * Returns the refusal, or null when the caller saw exactly the jobs the action touches.
 */
export function fence(
  rows: ReadonlyMap<string, { readonly version: Count }>,
  versions: ReadonlyMap<string, number>
): FlowRefusal | null {
  for (const [id, row] of rows) {
    const expected = versions.get(id);
    if (expected !== undefined && Number(row.version) !== expected) {
      throw new JobVersionError(id, expected, Number(row.version));
    }
  }
  const foreign = [...versions.keys()].filter((id) => !rows.has(id));
  if (foreign.length > 0) return { kind: 'foreign', ids: foreign.sort() };
  const unseen = [...rows.keys()].filter((id) => !versions.has(id));
  if (unseen.length > 0) return { kind: 'unseen', ids: unseen.sort() };
  return null;
}
