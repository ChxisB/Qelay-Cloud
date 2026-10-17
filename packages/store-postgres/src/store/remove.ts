import type { JobState } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';

/**
 * Deletes jobs and what hangs off them: their logs, the flow failures they recorded as a parent,
 * the dependencies they were waiting on, then the rows. Adapted from Qelay's `deleteLiveJob` and the
 * statements of `expiry.ts` and `dlqLifecycle.ts`. A completion record stays: it says the job
 * finished, which a flow parent may still need.
 */
export async function deleteJobRows(
  tx: TransactionSQL,
  namespace: string,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return;
  const list = tx.array([...ids], 'TEXT');
  await tx`DELETE FROM qcloud_job_logs WHERE namespace = ${namespace} AND job_id = ANY(${list})`;
  await tx`
    DELETE FROM qcloud_flow_failures WHERE namespace = ${namespace} AND parent_id = ANY(${list})`;
  await tx`
    DELETE FROM qcloud_dependencies WHERE namespace = ${namespace} AND job_id = ANY(${list})`;
  await tx`DELETE FROM qcloud_jobs WHERE namespace = ${namespace} AND id = ANY(${list})`;
}

/** A job to delete, with the state it is deleted from. */
export interface RemovedRow {
  readonly id: string;
  readonly queue: string;
  readonly state: JobState;
}

/**
 * Deletes the rows with what hangs off them and journals each as `removed` from its own state, in
 * the caller's transaction. `reason` is the event's error, when there is one. Returns how many.
 */
export async function removeEach(
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly RemovedRow[],
  reason: string | null,
  now: number
): Promise<number> {
  if (rows.length === 0) return 0;
  await deleteJobRows(
    tx,
    ctx.namespace,
    rows.map((row) => row.id)
  );
  await ctx.recorder.record(
    tx,
    rows.map((row) => ({
      type: 'removed' as const,
      queue: row.queue,
      jobId: row.id,
      state: row.state,
      ...(reason !== null && { error: reason }),
      removed: true as const,
    })),
    now
  );
  return rows.length;
}

/** `removeEach` for rows that were all in one `state`, with `reason` as the error. */
export async function removeAndRecord(
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly { readonly id: string; readonly queue: string }[],
  state: JobState,
  reason: string,
  now: number
): Promise<number> {
  return removeEach(
    tx,
    ctx,
    rows.map((row) => ({ ...row, state })),
    reason,
    now
  );
}
