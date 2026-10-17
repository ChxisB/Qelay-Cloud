import type { ClaimedJob, ClaimOptions } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { CandidateRow } from './claimSelect';
import { hasClaimableGroup, selectCandidates } from './claimSelect';
import type { StoreContext } from './context';
import { commitGroupClaims, ensureGroupStates, refreshGroupRateWindows } from './groupState';
import { claimLeaseUntil, requestedLeaseMs } from './leaseRules';
import { identifier } from './prepare';
import type { Envelope } from './prepare';
import { countActive, lockQueueState, refreshRateWindow } from './queueState';
import { runTransaction } from './retry';

/** Most jobs one claim takes. A larger request is clamped: a claim may always return fewer than `n`. */
export const MAX_CLAIM = 1000;

interface Attempt {
  readonly claimed: ClaimedJob[];
  /** The shared attempt found a limit or a group to account for, which only an exclusive lock may do. */
  readonly needExclusive: boolean;
}

/**
 * Leases up to `n` claimable jobs. Adapted from Qelay's `claims.ts` and `claimBatch.ts`.
 *
 * Every limit is enforced inside this transaction, under a lock on the queue's state row: a claim
 * that must count against the rate or concurrency limit, or rotate groups, locks it exclusively, so
 * two claimers cannot both see room for the last slot. A queue with neither takes the lock shared,
 * so unlimited claimers run together (`FOR UPDATE SKIP LOCKED` hands each different jobs). The
 * first attempt is shared; it gives up (nothing written) as soon as it finds a limit or a group
 * and the claim reruns exclusive.
 */
export async function claimJobs(
  ctx: StoreContext,
  queueName: string,
  ownerName: string,
  n: number,
  options?: ClaimOptions
): Promise<ClaimedJob[]> {
  const queue = identifier('queue', queueName);
  const owner = identifier('owner', ownerName);
  const count = Math.min(MAX_CLAIM, Math.floor(n));
  if (!(count > 0)) return [];
  const leaseMs = requestedLeaseMs(options?.leaseMs, ctx.leaseMs);
  const input = { queue, owner, count, leaseMs, group: options?.group };
  return ctx.db.run('claim', async (sql) => {
    const shared = await runTransaction(sql, (tx) => attempt(ctx, tx, input, false));
    if (!shared.needExclusive) return shared.claimed;
    return (await runTransaction(sql, (tx) => attempt(ctx, tx, input, true))).claimed;
  });
}

interface ClaimInput {
  readonly queue: string;
  readonly owner: string;
  readonly count: number;
  readonly leaseMs: number;
  readonly group: ClaimOptions['group'];
}

const EMPTY: Attempt = { claimed: [], needExclusive: false };
const RETRY_EXCLUSIVE: Attempt = { claimed: [], needExclusive: true };

async function attempt(
  ctx: StoreContext,
  tx: TransactionSQL,
  input: ClaimInput,
  exclusive: boolean
): Promise<Attempt> {
  const { namespace } = ctx;
  const { queue, count, group } = input;
  const now = await ctx.db.time.now(tx);
  let state = await lockQueueState(tx, namespace, queue, exclusive);
  if (!exclusive && (state.rateLimit !== null || state.concurrencyLimit !== null)) {
    return RETRY_EXCLUSIVE;
  }
  if (exclusive) state = await refreshRateWindow(tx, namespace, state, now);
  if (state.paused) return EMPTY;

  const active = state.concurrencyLimit === null ? 0 : await countActive(tx, namespace, queue, now);
  const concurrencyRoom =
    state.concurrencyLimit === null ? count : Math.max(0, state.concurrencyLimit - active);
  const rateRoom =
    state.rateLimit === null ? count : Math.max(0, state.rateLimit - state.rateCount);
  const capacity = Math.min(count, concurrencyRoom, rateRoom);
  if (capacity <= 0) return EMPTY;

  // A group affinity of `null` asks for no grouped job, so no group needs accounting for.
  const groups = group?.affinity !== null && (await hasClaimableGroup(tx, namespace, queue, now));
  if (!exclusive && groups) return RETRY_EXCLUSIVE;
  let sequence = state.groupSequence;
  if (groups) {
    sequence = await ensureGroupStates(tx, namespace, queue, sequence);
    await refreshGroupRateWindows(tx, namespace, queue, group, now);
  }

  const rows = await selectCandidates(tx, namespace, { queue, now, capacity, options: group });
  if (rows.length === 0) return EMPTY;
  const claimed = await lease(ctx, tx, rows, input, now);
  await commitGroupClaims(tx, namespace, { queue, rows, options: group, sequence });
  if (state.rateLimit !== null) {
    await tx`
      UPDATE qcloud_queue_state SET rate_count = rate_count + ${claimed.length}
      WHERE namespace = ${namespace} AND queue = ${queue}`;
  }
  await ctx.recorder.record(
    tx,
    claimed.map((job) => ({
      type: 'pulled' as const,
      queue,
      jobId: job.id,
      state: 'active' as const,
    })),
    now
  );
  return { claimed, needExclusive: false };
}

/**
 * Turns the selected rows (already locked) into leases: one token per job, a deadline per job from
 * its own stall and processing timeouts. The claim does not count an attempt, and it clears
 * `rung_at`, because the bell that led here has been consumed.
 */
async function lease(
  ctx: StoreContext,
  tx: TransactionSQL,
  rows: readonly CandidateRow[],
  input: ClaimInput,
  now: number
): Promise<ClaimedJob[]> {
  const { owner, leaseMs } = input;
  const claimed = rows.map((row): ClaimedJob => {
    const envelope = ctx.codec.decode(row.payload) as Envelope;
    const token = crypto.randomUUID();
    return {
      id: row.id,
      queue: row.queue,
      name: envelope.name,
      data: envelope.data,
      attempts: row.attempts,
      lease: { jobId: row.id, token, owner },
      leaseUntil: claimLeaseUntil(now, leaseMs, {
        timeout: row.timeout === null ? null : Number(row.timeout),
        stallTimeout: envelope.stallTimeout,
      }),
      ...(envelope.trace !== undefined && { trace: envelope.trace }),
    };
  });
  const updated = await tx<{ id: string }[]>`
    UPDATE qcloud_jobs AS job
    SET state = 'active', started_at = ${now}, lease_owner = ${owner},
        lease_token = batch.token, lease_until = batch.lease_until, lease_renewals = 0,
        rung_at = NULL, version = job.version + 1
    FROM unnest(
      ${tx.array(
        claimed.map((job) => job.id),
        'TEXT'
      )},
      ${tx.array(
        claimed.map((job) => job.lease.token),
        'TEXT'
      )},
      ${tx.array(
        claimed.map((job) => job.leaseUntil),
        'BIGINT'
      )}
    ) AS batch(id, token, lease_until)
    WHERE job.namespace = ${ctx.namespace} AND job.id = batch.id
    RETURNING job.id`;
  if (updated.length !== claimed.length) {
    throw new Error('claimed rows changed while they were locked');
  }
  return claimed;
}
