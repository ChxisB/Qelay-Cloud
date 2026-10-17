import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { StoreContext } from './context';

/** The answer to a lease request: who leads now, and until when (database time, ms). */
export interface TickLease {
  readonly held: boolean;
  readonly leader: string | null;
  readonly expiresAt: number;
  /** Database time of the request. */
  readonly at: number;
}

/** What the tick's row says, for the control API and the alerts. Database time, ms; null when never. */
export interface TickStatus {
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly leader: string | null;
  readonly leaderExpiresAt: number | null;
  /** Database time of the read, so an age needs no clock of the caller's. */
  readonly now: number;
}

interface LeaseRow {
  readonly leader: string | null;
  readonly leader_expires_at: number | string | bigint;
}

/**
 * Takes the tick's leader lease if it is free, expired (against the database clock) or already
 * ours, and renews it to `ttlMs` from now. A clock read and one upsert, neither of which needs
 * session state, so it is safe behind any pooler. The lease is an efficiency device only: the tick
 * is safe to run from several processes at once, and a process that is wrongly believed to lead
 * costs repeated work, not a wrong result.
 */
export async function acquireTickLease(
  ctx: StoreContext,
  holder: string,
  ttlMs: number
): Promise<TickLease> {
  if (holder === '') throw new UnsupportedOptionError('holder', 'must not be empty');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new UnsupportedOptionError('ttlMs', 'must be a positive integer');
  }
  return ctx.db.run('acquireTickLease', async (sql) => {
    const at = await ctx.db.time.now(sql);
    const taken = await sql<LeaseRow[]>`
      INSERT INTO qcloud_tick_state AS state (namespace, leader, leader_expires_at)
      VALUES (${ctx.namespace}, ${holder}, ${at + ttlMs})
      ON CONFLICT (namespace) DO UPDATE
        SET leader = EXCLUDED.leader, leader_expires_at = EXCLUDED.leader_expires_at
        WHERE state.leader = EXCLUDED.leader OR state.leader_expires_at <= ${at}
      RETURNING leader, leader_expires_at`;
    if (taken[0]) return { held: true, leader: holder, expiresAt: at + ttlMs, at };
    const [current] = await sql<LeaseRow[]>`
      SELECT leader, leader_expires_at FROM qcloud_tick_state WHERE namespace = ${ctx.namespace}`;
    return {
      held: false,
      leader: current?.leader ?? null,
      expiresAt: Number(current?.leader_expires_at ?? 0),
      at,
    };
  });
}

/** Gives the lease up now if it is ours, so a follower can take over on its next tick. */
export async function releaseTickLease(ctx: StoreContext, holder: string): Promise<boolean> {
  return ctx.db.run('releaseTickLease', async (sql) => {
    const released = await sql<Array<{ namespace: string }>>`
      UPDATE qcloud_tick_state SET leader_expires_at = 0
      WHERE namespace = ${ctx.namespace} AND leader = ${holder} AND leader_expires_at > 0
      RETURNING namespace`;
    return released.length === 1;
  });
}

/** Records that a tick ran to the end (`true`) or failed (`false`), at the database's time. */
export async function recordTick(ctx: StoreContext, ok: boolean): Promise<void> {
  await ctx.db.run('recordTick', async (sql) => {
    const at = await ctx.db.time.now(sql);
    const success = ok ? at : null;
    const failure = ok ? null : at;
    // GREATEST ignores NULL, so a success leaves the failure time alone and the other way round, and
    // two ticks recording out of order cannot move either timestamp back.
    await sql`
      INSERT INTO qcloud_tick_state AS state (namespace, last_success_at, last_failure_at)
      VALUES (${ctx.namespace}, ${success}, ${failure})
      ON CONFLICT (namespace) DO UPDATE
        SET last_success_at = GREATEST(state.last_success_at, EXCLUDED.last_success_at),
            last_failure_at = GREATEST(state.last_failure_at, EXCLUDED.last_failure_at)`;
  });
}

/** The tick's row, or all nulls when no tick ever recorded. Never throws for a missing row. */
export async function tickStatus(ctx: StoreContext): Promise<TickStatus> {
  return ctx.db.run('tickStatus', async (sql) => {
    const now = await ctx.db.time.now(sql);
    const [row] = await sql<
      Array<
        LeaseRow & {
          last_success_at: number | string | null;
          last_failure_at: number | string | null;
        }
      >
    >`
      SELECT leader, leader_expires_at, last_success_at, last_failure_at
      FROM qcloud_tick_state WHERE namespace = ${ctx.namespace}`;
    const number = (value: number | string | bigint | null | undefined): number | null =>
      value === null || value === undefined ? null : Number(value);
    return {
      lastSuccessAt: number(row?.last_success_at),
      lastFailureAt: number(row?.last_failure_at),
      leader: row?.leader ?? null,
      leaderExpiresAt: row === undefined ? null : number(row.leader_expires_at),
      now,
    };
  });
}
