import type { Lease } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';

/** What completion, failure and recovery read of a job that holds a lease. */
export interface HeldRow {
  readonly id: string;
  readonly queue: string;
  readonly payload: Uint8Array;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly started_at: number | string | bigint | null;
  readonly timeout: number | string | bigint | null;
  readonly parent_id: string | null;
  readonly lease_until: number | string | bigint | null;
  readonly dlq_retry_state: Uint8Array | null;
}

/** The columns of `HeldRow`, for `sql.unsafe`. A constant, never built from input. */
export const HELD_COLUMNS = `id, queue, payload, priority, attempts, max_attempts, started_at, timeout,
  parent_id, lease_until, dlq_retry_state`;

/**
 * Locks the job the lease names and returns it with the database time, or null when the lease does
 * not hold it: no such job, not active, another token, or a deadline that has passed. The time is
 * read after the lock is won, so the check and the write that follows see one instant, and a
 * recovery that got the row first (and moved it on) is seen as the lost lease it is.
 */
export async function lockHeldJob(
  tx: TransactionSQL,
  ctx: StoreContext,
  lease: Lease
): Promise<{ readonly row: HeldRow; readonly now: number } | null> {
  const [row] = await tx<Array<HeldRow & { state: string; lease_token: string | null }>>`
    SELECT ${tx.unsafe(HELD_COLUMNS)}, state, lease_token FROM qcloud_jobs
    WHERE namespace = ${ctx.namespace} AND id = ${lease.jobId}
    FOR UPDATE`;
  const now = await ctx.db.time.now(tx);
  if (
    row?.state !== 'active' ||
    row.lease_token !== lease.token ||
    row.lease_until === null ||
    Number(row.lease_until) <= now
  ) {
    return null;
  }
  return { row, now };
}
