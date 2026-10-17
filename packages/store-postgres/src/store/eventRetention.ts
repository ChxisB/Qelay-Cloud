import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import { advisoryLockName } from './locks';
import { runTransaction } from './retry';

/**
 * Retention of the event journal, run by the tick in bounded steps. Adapted from Qelay's
 * `eventRetention.ts`, `eventPruneWatermarks.ts` and `eventJournal.ts` (see docs/PORTING.md).
 *
 * Two rules delete events: an event older than `eventRetentionMs` goes, and a queue keeps at most
 * `maxQueueEvents`, oldest first. Inside the window nothing is deleted except by the cap, which
 * bounds a burst's storage; it is also the only way an event a reader has not read can go. Every
 * delete records a prune watermark in the same transaction, per queue, with the newest commit it
 * took events from, and `readEvents` turns it into `gap` for any reader still behind that commit.
 * So the journal never loses an unread event silently: a reader inside the window and under the cap
 * reads everything, and any other reader is told.
 */

type Count = number | string | bigint;

/** Events a queue keeps: past it, the oldest go. */
export const DEFAULT_MAX_QUEUE_EVENTS = 10_000;
/** How long an event is kept: 24 hours. */
export const DEFAULT_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Events or commit envelopes one retention pass deletes. */
export const DEFAULT_EVENT_TRIM_LIMIT = 1_000;

export interface EventTrim {
  /** Events deleted. */
  readonly removed: number;
  /** A cap was hit, so another pass has work. */
  readonly more: boolean;
}

interface Removed {
  id: Count;
  queue: string;
  commit_seq: Count | null;
}

/** The newest event id and commit each queue lost in a delete, as the watermark wants them. */
function summarize(rows: readonly Removed[]): Map<string, { through: number; commit: number }> {
  const byQueue = new Map<string, { through: number; commit: number }>();
  for (const row of rows) {
    const seen = byQueue.get(row.queue) ?? { through: 0, commit: 0 };
    byQueue.set(row.queue, {
      through: Math.max(seen.through, Number(row.id)),
      commit: Math.max(seen.commit, Number(row.commit_seq ?? 0)),
    });
  }
  return byQueue;
}

/**
 * Records, for one queue, that events through `through` were deleted, the newest of them from
 * commit `commit`. One row per queue survives: a later prune supersedes the earlier ones and
 * carries their commit positions forward, so a reader far behind is still told.
 */
async function recordPrune(
  tx: TransactionSQL,
  ctx: StoreContext,
  queue: string,
  through: number,
  commit: number
): Promise<void> {
  await tx`
    WITH inserted AS (
      INSERT INTO qcloud_event_prune_watermarks
        (namespace, queue, source_event_id, pruned_through, pruned_commit_seq,
         self_pruned_commit_seq, prunes_current_transaction)
      SELECT ${ctx.namespace}::text, ${queue}::text, ${through}::bigint, ${through}::bigint,
             GREATEST(${commit}::bigint, COALESCE((
               SELECT MAX(existing.pruned_commit_seq) FROM qcloud_event_prune_watermarks AS existing
               WHERE existing.namespace = ${ctx.namespace} AND existing.queue = ${queue}
             ), 0)),
             COALESCE((
               SELECT MAX(existing.self_pruned_commit_seq) FROM qcloud_event_prune_watermarks AS existing
               WHERE existing.namespace = ${ctx.namespace} AND existing.queue = ${queue}
             ), 0),
             FALSE
      ON CONFLICT (namespace, queue, source_event_id) DO UPDATE SET
        pruned_through = GREATEST(qcloud_event_prune_watermarks.pruned_through, excluded.pruned_through),
        pruned_commit_seq = GREATEST(
          COALESCE(qcloud_event_prune_watermarks.pruned_commit_seq, 0),
          COALESCE(excluded.pruned_commit_seq, 0)
        ),
        self_pruned_commit_seq = GREATEST(
          COALESCE(qcloud_event_prune_watermarks.self_pruned_commit_seq, 0),
          COALESCE(excluded.self_pruned_commit_seq, 0)
        ),
        transaction_id = pg_current_xact_id()::text::bigint,
        commit_seq = NULL
      RETURNING namespace, queue, source_event_id, pruned_through
    )
    DELETE FROM qcloud_event_prune_watermarks AS previous
    USING inserted AS latest
    WHERE previous.namespace = latest.namespace AND previous.queue = latest.queue
      AND previous.source_event_id <> latest.source_event_id
      AND previous.pruned_through <= latest.pruned_through`;
}

async function recordPrunes(
  tx: TransactionSQL,
  ctx: StoreContext,
  rows: readonly Removed[]
): Promise<void> {
  const byQueue = [...summarize(rows)].sort(([left], [right]) => (left < right ? -1 : 1));
  for (const [queue, { through, commit }] of byQueue) {
    await recordPrune(tx, ctx, queue, through, commit);
  }
}

/** Deletes the oldest events past the window, at most `limit`, and records what it deleted. */
async function trimByAge(ctx: StoreContext, limit: number): Promise<number> {
  return ctx.db.run('trimEventsByAge', (sql) =>
    runTransaction(sql, async (tx) => {
      const now = await ctx.db.time.now(tx);
      // The oldest `limit` events by id, of which the expired are deleted: ids follow time, so the
      // expired ones are a prefix, and a pass reads `limit` index entries whatever is retained.
      const removed = await tx<Removed[]>`
        WITH oldest AS MATERIALIZED (
          SELECT id, namespace, occurred_at FROM qcloud_events
          WHERE namespace = ${ctx.namespace}
          ORDER BY id LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        ), gone AS (
          DELETE FROM qcloud_events AS event USING oldest
          WHERE event.id = oldest.id AND oldest.occurred_at < ${now - ctx.eventRetentionMs}
          RETURNING event.id, event.queue, event.transaction_id
        )
        SELECT gone.id, gone.queue, journal.commit_seq
        FROM gone LEFT JOIN qcloud_event_commits AS journal
          ON journal.namespace = ${ctx.namespace} AND journal.transaction_id = gone.transaction_id`;
      await recordPrunes(tx, ctx, removed);
      return removed.length;
    })
  );
}

/**
 * Folds the unfolded insert and delete counts of a queue into its retained count and returns it.
 * Rows of in-flight transactions are not visible yet, so the count can lag and never runs ahead.
 * Only `trimQueue` calls it, under the queue's retention lock, so no other fold runs on the queue.
 * The rows are deleted by their key alone: a statement that joined them to a set of rows it had
 * locked first was planned as a nested loop over every pair when the table had no statistics, and a
 * burst of 25,000 counts then took longer than the statement deadline.
 */
async function retainedCount(
  tx: TransactionSQL,
  ctx: StoreContext,
  queue: string
): Promise<number> {
  await tx`
    INSERT INTO qcloud_event_retention_state (namespace, queue, retained_count, last_event_id)
    VALUES (${ctx.namespace}, ${queue}, 0, 0)
    ON CONFLICT (namespace, queue) DO NOTHING`;
  const [row] = await tx<Array<{ retained_count: Count }>>`
    WITH consumed AS (
      DELETE FROM qcloud_event_retention_deltas AS delta
      WHERE delta.namespace = ${ctx.namespace} AND delta.queue = ${queue}
      RETURNING delta.delta_count, delta.last_event_id
    ), aggregate AS (
      SELECT COALESCE(SUM(delta_count), 0)::BIGINT AS delta_count,
             COALESCE(MAX(last_event_id), 0)::BIGINT AS last_event_id
      FROM consumed
    )
    UPDATE qcloud_event_retention_state AS state
    SET retained_count = GREATEST(0, state.retained_count + aggregate.delta_count),
        last_event_id = GREATEST(state.last_event_id, aggregate.last_event_id)
    FROM aggregate
    WHERE state.namespace = ${ctx.namespace} AND state.queue = ${queue}
    RETURNING state.retained_count`;
  return Number(row?.retained_count ?? 0);
}

/** Deletes a queue's oldest events past its cap, at most `limit`, unless another sweep has the queue. */
async function trimQueue(ctx: StoreContext, queue: string, limit: number): Promise<number> {
  return ctx.db.run('trimQueueEvents', (sql) =>
    runTransaction(sql, async (tx) => {
      const lock = advisoryLockName('event-retention', ctx.namespace, queue);
      const [{ acquired }] = await tx<[{ acquired: boolean }]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lock}, 0)) AS acquired`;
      if (!acquired) return 0;
      const excess = Math.max(0, (await retainedCount(tx, ctx, queue)) - ctx.maxQueueEvents);
      if (excess === 0) return 0;
      const removed = await tx<Removed[]>`
        WITH candidates AS MATERIALIZED (
          SELECT event.id FROM qcloud_events AS event
          WHERE event.namespace = ${ctx.namespace} AND event.queue = ${queue}
          ORDER BY event.id LIMIT ${Math.min(excess, limit)}
          FOR UPDATE OF event SKIP LOCKED
        ), gone AS (
          DELETE FROM qcloud_events AS event USING candidates
          WHERE event.id = candidates.id
          RETURNING event.id, event.queue, event.transaction_id
        )
        SELECT gone.id, gone.queue, journal.commit_seq
        FROM gone LEFT JOIN qcloud_event_commits AS journal
          ON journal.namespace = ${ctx.namespace} AND journal.transaction_id = gone.transaction_id`;
      await recordPrunes(tx, ctx, removed);
      await retainedCount(tx, ctx, queue);
      return removed.length;
    })
  );
}

/**
 * Deletes events past the window, then the oldest events of queues over their cap, at most `limit`
 * in all. A step of `tick`. Safe to run from any number of processes: rows are taken `SKIP LOCKED`
 * and a queue's cap sweep holds that queue's retention lock.
 */
export async function trimEvents(ctx: StoreContext, limit: number): Promise<EventTrim> {
  const cap = Math.max(1, Math.floor(limit));
  let removed = await trimByAge(ctx, cap);
  let more = removed >= cap;
  if (removed < cap) {
    // Queues written to since the last fold, and queues the last fold left over the cap. A queue
    // folded is no longer listed, so a long list is worked through over a few ticks.
    const queues = await ctx.db.run(
      'eventRetentionQueues',
      (sql) =>
        sql<Array<{ queue: string }>>`
        SELECT queue FROM qcloud_event_retention_deltas WHERE namespace = ${ctx.namespace}
        UNION
        SELECT queue FROM qcloud_event_retention_state
        WHERE namespace = ${ctx.namespace} AND retained_count > ${ctx.maxQueueEvents}::bigint
        ORDER BY queue LIMIT ${cap}`
    );
    more = queues.length >= cap;
    for (const { queue } of queues) {
      if (removed >= cap) break;
      removed += await trimQueue(ctx, queue, cap - removed);
    }
    more ||= removed >= cap;
  }
  return { removed, more };
}
