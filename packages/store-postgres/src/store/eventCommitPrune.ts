import type { StoreContext } from './context';

/**
 * Commit envelopes examined per row the pass may delete. A pass looks at a window of the oldest
 * envelopes after its cursor, not at all of them: the journal keeps up to `maxQueueEvents` per queue,
 * so an envelope is live until its events go, and a scan for the dead ones that started at the oldest
 * and ran through every live one cost time proportional to the journal on every pass (240 ms at 200,000
 * envelopes, and over the 10 s statement deadline under load: task 22's load check).
 */
const SCAN_PER_DELETE = 10;

/** Where the last pass of each store stopped, as a `commit_seq`. In memory: a restart begins at the oldest. */
const cursors = new WeakMap<StoreContext, string>();

interface Step {
  readonly deleted: number;
  readonly examined: number;
  readonly last: string | null;
}

async function pruneWindow(
  ctx: StoreContext,
  after: string,
  window: number,
  cap: number
): Promise<Step> {
  return ctx.db.run('pruneEventCommits', async (sql) => {
    const [row] = await sql<Array<{ deleted: number; examined: number; last: string | null }>>`
      WITH scan AS MATERIALIZED (
        SELECT namespace, transaction_id, commit_seq FROM qcloud_event_commits
        WHERE namespace = ${ctx.namespace} AND commit_seq IS NOT NULL AND commit_seq > ${after}::bigint
        ORDER BY commit_seq
        LIMIT ${window}
      ), candidates AS MATERIALIZED (
        SELECT journal.namespace, journal.transaction_id
        FROM qcloud_event_commits AS journal
        JOIN scan ON scan.namespace = journal.namespace AND scan.transaction_id = journal.transaction_id
        WHERE NOT EXISTS (
            SELECT 1 FROM qcloud_events AS event
            WHERE event.namespace = journal.namespace AND event.transaction_id = journal.transaction_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM qcloud_event_prune_watermarks AS watermark
            WHERE watermark.namespace = journal.namespace
              AND watermark.transaction_id = journal.transaction_id
          )
        ORDER BY journal.commit_seq
        LIMIT ${cap}
        FOR UPDATE OF journal SKIP LOCKED
      ), removed AS (
        DELETE FROM qcloud_event_commits AS journal USING candidates
        WHERE journal.namespace = candidates.namespace
          AND journal.transaction_id = candidates.transaction_id
        RETURNING journal.transaction_id
      )
      SELECT (SELECT count(*) FROM removed)::int AS deleted,
             (SELECT count(*) FROM scan)::int AS examined,
             (SELECT max(commit_seq) FROM scan)::text AS last`;
    return { deleted: row!.deleted, examined: row!.examined, last: row!.last };
  });
}

/**
 * Deletes commit envelopes whose events and watermarks are all gone, at most `limit`: without it
 * `qcloud_event_commits` would grow by one row per event-writing transaction forever. Returns how
 * many it deleted. A step of `tick`.
 *
 * One call examines at most ten times `limit` envelopes, resuming after the last one the previous
 * call examined and starting over at the oldest when it reaches the end, so every envelope is looked
 * at in turn and a live one at the head cannot hide the dead ones behind it. A call that deleted
 * `limit` stays where it is: the same window may hold more.
 */
export async function pruneEventCommits(ctx: StoreContext, limit: number): Promise<number> {
  const cap = Math.max(1, Math.floor(limit));
  let window = cap * SCAN_PER_DELETE;
  let from = cursors.get(ctx) ?? '0';
  let deleted = 0;
  // At most two windows: the one after the cursor, and, when that ran off the end, one from the start.
  for (let round = 0; round < 2 && window > 0 && deleted < cap; round++) {
    const step = await pruneWindow(ctx, from, window, cap - deleted);
    deleted += step.deleted;
    if (deleted >= cap) break;
    window -= step.examined;
    if (window > 0) {
      // Ran off the end of the journal: the next call starts at the oldest, and this one may wrap now.
      cursors.set(ctx, '0');
      if (from === '0') break;
      from = '0';
    } else {
      cursors.set(ctx, step.last ?? '0');
    }
  }
  return deleted;
}
