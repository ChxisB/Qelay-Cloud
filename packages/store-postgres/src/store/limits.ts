import type { RateLimit } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { identifier } from './prepare';
import { DEFAULT_RATE_DURATION_MS } from './queueState';

/**
 * Queue-level controls: pause, resume and the rate and concurrency limits. Adapted from Qelay's
 * `control.ts`. Each is one write to the queue's state row, which a claim locks, so a change takes
 * effect for every claim that starts after it commits and waits for a claim that is mid-flight.
 */

/**
 * Clears `rung_at` of pending jobs whose bell was due. While a queue is paused or at its limit a
 * delivered bell claims nothing and is spent, so after the change the tick must ring those jobs
 * again. A bell that is not due yet (a delayed job's pre-ring) is still in flight and stays.
 */
async function clearDueBells(
  tx: TransactionSQL,
  namespace: string,
  queue: string,
  now: number
): Promise<void> {
  await tx`
    UPDATE qcloud_jobs SET rung_at = NULL
    WHERE namespace = ${namespace} AND queue = ${queue}
      AND state IN ('waiting', 'prioritized', 'delayed')
      AND rung_at IS NOT NULL AND rung_at <= ${now}`;
}

export async function pauseQueue(ctx: StoreContext, name: string): Promise<void> {
  const queue = identifier('queue', name);
  await ctx.db.run('pause', async (sql) => {
    await sql`
      INSERT INTO qcloud_queue_state (namespace, queue, paused)
      VALUES (${ctx.namespace}, ${queue}, TRUE)
      ON CONFLICT (namespace, queue) DO UPDATE SET paused = TRUE`;
  });
}

export async function resumeQueue(ctx: StoreContext, name: string): Promise<void> {
  const queue = identifier('queue', name);
  await ctx.db.run('resume', (sql) =>
    sql.begin(async (tx) => {
      const now = await ctx.db.time.now(tx);
      await tx`
        INSERT INTO qcloud_queue_state (namespace, queue, paused)
        VALUES (${ctx.namespace}, ${queue}, FALSE)
        ON CONFLICT (namespace, queue) DO UPDATE SET paused = FALSE`;
      await clearDueBells(tx, ctx.namespace, queue, now);
    })
  );
}

function positiveInteger(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(name, 'must be a positive integer');
  }
  return value;
}

function positiveMs(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UnsupportedOptionError(name, 'must be a positive number of milliseconds');
  }
  return Math.ceil(value);
}

/** Sets or, with null, removes the queue's rate limit, and starts a fresh window. */
export async function setRateLimit(
  ctx: StoreContext,
  name: string,
  limit: RateLimit | null
): Promise<void> {
  const queue = identifier('queue', name);
  const max = limit === null ? null : positiveInteger('rateLimit.max', limit.max);
  const durationMs =
    limit === null
      ? null
      : limit.durationMs === undefined
        ? DEFAULT_RATE_DURATION_MS
        : positiveMs('rateLimit.durationMs', limit.durationMs);
  const ttlMs = limit?.ttlMs === undefined ? null : positiveMs('rateLimit.ttlMs', limit.ttlMs);
  await ctx.db.run('setRateLimit', (sql) =>
    sql.begin(async (tx) => {
      const now = await ctx.db.time.now(tx);
      await tx`
        INSERT INTO qcloud_queue_state
          (namespace, queue, rate_limit, rate_duration_ms, rate_window_started_at,
           rate_expires_at, rate_count)
        VALUES (${ctx.namespace}, ${queue}, ${max}, ${durationMs}, ${max === null ? null : now},
                ${ttlMs === null ? null : now + ttlMs}, 0)
        ON CONFLICT (namespace, queue) DO UPDATE SET
          rate_limit = excluded.rate_limit,
          rate_duration_ms = excluded.rate_duration_ms,
          rate_window_started_at = excluded.rate_window_started_at,
          rate_expires_at = excluded.rate_expires_at,
          rate_count = 0`;
      await clearDueBells(tx, ctx.namespace, queue, now);
    })
  );
}

/** Sets or, with null, removes how many jobs of the queue may be active at once. */
export async function setConcurrencyLimit(
  ctx: StoreContext,
  name: string,
  limit: number | null
): Promise<void> {
  const queue = identifier('queue', name);
  const value = limit === null ? null : positiveInteger('concurrencyLimit', limit);
  await ctx.db.run('setConcurrencyLimit', (sql) =>
    sql.begin(async (tx) => {
      const now = await ctx.db.time.now(tx);
      await tx`
        INSERT INTO qcloud_queue_state (namespace, queue, concurrency_limit)
        VALUES (${ctx.namespace}, ${queue}, ${value})
        ON CONFLICT (namespace, queue) DO UPDATE SET concurrency_limit = excluded.concurrency_limit`;
      await clearDueBells(tx, ctx.namespace, queue, now);
    })
  );
}
