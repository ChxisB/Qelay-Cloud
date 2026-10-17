import type { DlqEntry } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { hasLiveConsumer } from './flowGuard';
import { DEFAULT_DLQ_MAX_AGE_MS, decodeDlqConfig } from './policies';
import { identifier } from './prepare';
import { removeAndRecord } from './remove';
import { runTransaction } from './retry';

/**
 * The dead-letter queue is the queue's `failed` jobs: one row each, written once by the failure that
 * ended the job (`dlq_entry` holds the final error and the attempt history). The limit, the purge
 * and the age expiry below delete rows, and each deletion is journaled as a `removed` event in the
 * same transaction. Retrying a DLQ entry is not here: it stays fail-closed (task 14 Result, task 32).
 */

type Count = number | string | bigint;
type Time = number | string | bigint | null;

interface DlqRow {
  readonly id: string;
  readonly queue: string;
  readonly attempts: number;
  readonly completed_at: Time;
  readonly failure_reason: string | null;
  readonly error: string | null;
}

const toEntry = (row: DlqRow): DlqEntry => ({
  jobId: row.id,
  queue: row.queue,
  attempts: row.attempts,
  failedAt: Number(row.completed_at ?? 0),
  reason: row.failure_reason ?? row.error ?? '',
});

/** Every entry of the queue, oldest failure first. Bounded by the queue's `maxEntries`. */
export async function listDlq(ctx: StoreContext, queue: string): Promise<DlqEntry[]> {
  return ctx.db.run('listDlq', async (sql) => {
    const rows = await sql<DlqRow[]>`
      SELECT id, queue, attempts, completed_at, failure_reason, error FROM qcloud_jobs
      WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
      ORDER BY completed_at, id`;
    return rows.map(toEntry);
  });
}

export interface DlqPage {
  readonly items: readonly DlqEntry[];
  /** Entries in the whole DLQ of the queue, not in the page. */
  readonly total: number;
}

/** One page of the queue's entries in the same order as `listDlq`, with the total. */
export async function listDlqPage(
  ctx: StoreContext,
  queue: string,
  page: { readonly limit: number; readonly offset?: number }
): Promise<DlqPage> {
  const limit = Math.max(1, Math.floor(page.limit));
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  return ctx.db.run('listDlqPage', async (sql) => {
    const rows = await sql<DlqRow[]>`
      SELECT id, queue, attempts, completed_at, failure_reason, error FROM qcloud_jobs
      WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
      ORDER BY completed_at, id
      LIMIT ${limit} OFFSET ${offset}`;
    const [row] = await sql<{ total: Count }[]>`
      SELECT count(*)::bigint AS total FROM qcloud_jobs
      WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'`;
    return { items: rows.map(toEntry), total: Number(row!.total) };
  });
}

export interface DlqStats {
  readonly total: number;
  readonly oldestFailedAt: number | null;
  readonly newestFailedAt: number | null;
  /** Entries per failure reason (`explicit_fail`, `max_attempts_exceeded`, `timeout`, `stalled`). */
  readonly byReason: Readonly<Record<string, number>>;
}

export async function dlqStats(ctx: StoreContext, queue: string): Promise<DlqStats> {
  return ctx.db.run('dlqStats', async (sql) => {
    const [summary] = await sql<{ total: Count; oldest: Time; newest: Time }[]>`
      SELECT count(*)::bigint AS total, min(completed_at) AS oldest, max(completed_at) AS newest
      FROM qcloud_jobs WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'`;
    const reasons = await sql<{ reason: string; total: Count }[]>`
      SELECT COALESCE(failure_reason, 'unknown') AS reason, count(*)::bigint AS total
      FROM qcloud_jobs WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
      GROUP BY 1`;
    return {
      total: Number(summary!.total),
      oldestFailedAt: summary!.oldest === null ? null : Number(summary!.oldest),
      newestFailedAt: summary!.newest === null ? null : Number(summary!.newest),
      byReason: Object.fromEntries(reasons.map((row) => [row.reason, Number(row.total)])),
    };
  });
}

/** Deletes the rows and journals each as removed from `failed`. Returns how many. */
const removeFailed = (
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly { readonly id: string; readonly queue: string }[],
  reason: string,
  now: number
): Promise<number> => removeAndRecord(tx, ctx, rows, 'failed', reason, now);

/**
 * Keeps the newest `maxEntries` failed jobs of the queue (at least 1) and deletes the older ones,
 * inside the transaction that added an entry, so the DLQ never holds more than the limit. Rows that
 * another transaction holds locked are skipped: that transaction is deleting them or moving them,
 * and the next failure enforces the limit again. A failed child a live flow parent still waits for is
 * never deleted (`flowGuard.ts`), so a DLQ of such children may hold more than the limit until the
 * parent is cancelled. Returns how many were deleted.
 */
export async function enforceDlqLimit(
  tx: TransactionSQL,
  ctx: StoreContext,
  queue: string,
  maxEntries: number,
  now: number
): Promise<number> {
  const keep = Math.max(1, Math.floor(maxEntries));
  const [row] = await tx<{ total: Count }[]>`
    SELECT count(*)::bigint AS total FROM qcloud_jobs
    WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'`;
  const excess = Number(row!.total) - keep;
  if (excess <= 0) return 0;
  const oldest = await tx<{ id: string; queue: string }[]>`
    SELECT id, queue FROM qcloud_jobs AS job
    WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
      AND NOT ${tx.unsafe(hasLiveConsumer('job'))}
    ORDER BY completed_at ASC NULLS FIRST, id ASC
    LIMIT ${excess}
    FOR UPDATE SKIP LOCKED`;
  return removeFailed(tx, ctx, oldest, 'DLQ limit reached', now);
}

/**
 * Deletes the failed jobs of one queue: the ones named, or all of them. Returns how many were
 * deleted; an id that is not a failed job of the queue is ignored, and so is a failed child a live
 * flow parent still waits for (`flowGuard.ts`).
 */
export async function purgeDlq(
  ctx: StoreContext,
  queueName: string,
  jobIds?: readonly string[]
): Promise<number> {
  const queue = identifier('queue', queueName);
  if (jobIds?.length === 0) return 0;
  const ids = jobIds ? [...new Set(jobIds)] : null;
  return ctx.db.run('purgeDlq', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const rows = await tx<{ id: string; queue: string }[]>`
        SELECT id, queue FROM qcloud_jobs AS job
        WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
          AND (${ids === null}::boolean OR id = ANY(${tx.array(ids ?? [], 'TEXT')}))
          AND NOT ${tx.unsafe(hasLiveConsumer('job'))}
        ORDER BY id
        FOR UPDATE SKIP LOCKED`;
      return removeFailed(tx, ctx, rows, 'purged from the DLQ', now);
    })
  );
}

/**
 * Deletes failed jobs older than their queue's `maxAge` (a queue with no DLQ config has the
 * default of 7 days; a `maxAge` of null keeps entries for ever), at most `limit` in all. The age is
 * measured from the failure (`completed_at`), so a change of `maxAge` applies to entries already
 * there. The tick calls it (task 15). Returns how many were deleted.
 */
export async function purgeExpiredDlq(ctx: StoreContext, limit: number): Promise<number> {
  const cap = Math.max(1, Math.floor(limit));
  return ctx.db.run('purgeExpiredDlq', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      const configured = await tx<{ queue: string; dlq_config: Uint8Array }[]>`
        SELECT queue, dlq_config FROM qcloud_queue_state
        WHERE namespace = ${ctx.namespace} AND dlq_config IS NOT NULL
        ORDER BY queue`;
      const ages = configured.map((row) => ({
        queue: row.queue,
        maxAge: decodeDlqConfig(ctx.codec, row.dlq_config).maxAge,
      }));
      let removed = 0;
      for (const { queue, maxAge } of ages) {
        if (maxAge === null || removed >= cap) continue;
        const rows = await tx<{ id: string; queue: string }[]>`
          SELECT id, queue FROM qcloud_jobs AS job
          WHERE namespace = ${ctx.namespace} AND queue = ${queue} AND state = 'failed'
            AND completed_at <= ${now - maxAge}
            AND NOT ${tx.unsafe(hasLiveConsumer('job'))}
          ORDER BY completed_at, id LIMIT ${cap - removed}
          FOR UPDATE SKIP LOCKED`;
        removed += await removeFailed(tx, ctx, rows, 'DLQ entry expired', now);
      }
      if (removed < cap) {
        const rows = await tx<{ id: string; queue: string }[]>`
          SELECT id, queue FROM qcloud_jobs AS job
          WHERE namespace = ${ctx.namespace} AND state = 'failed'
            AND NOT ${tx.unsafe(hasLiveConsumer('job'))}
            AND queue <> ALL(${tx.array(
              ages.map((age) => age.queue),
              'TEXT'
            )})
            AND completed_at <= ${now - DEFAULT_DLQ_MAX_AGE_MS}
          ORDER BY completed_at, id LIMIT ${cap - removed}
          FOR UPDATE SKIP LOCKED`;
        removed += await removeFailed(tx, ctx, rows, 'DLQ entry expired', now);
      }
      return removed;
    })
  );
}
