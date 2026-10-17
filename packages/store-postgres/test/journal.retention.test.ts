import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { EventCursor } from '../src/store/journal';
import { JOURNAL_START } from '../src/store/journal';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

const HOUR = 3_600_000;
const CAP = 5;
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('event journal: retention, gaps and commit cleanup', () => {
  let t: TestStore;
  let store: ReturnType<TestStore['another']>;
  beforeAll(async () => {
    t = await openTestStore();
    store = t.another({ eventRetentionMs: HOUR, maxQueueEvents: CAP });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** One commit per job, so retention can cut between commits. */
  async function oneByOne(count: number, queue = 'q'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(...(await enqueueN(store, 1, {}, queue)));
    return ids;
  }

  const remaining = async (queue = 'q') =>
    (
      await t.fresh.sql<Array<{ job_id: string }>>`
        SELECT job_id FROM qcloud_events WHERE queue = ${queue} ORDER BY id`
    ).map((row) => row.job_id);
  const envelopes = async () =>
    (await t.fresh.sql<[{ n: number }]>`SELECT count(*)::int AS n FROM qcloud_event_commits`)[0].n;
  const marks = async (queue = 'q') =>
    (
      await t.fresh.sql<[{ n: number }]>`
        SELECT count(*)::int AS n FROM qcloud_event_prune_watermarks WHERE queue = ${queue}`
    )[0].n;
  const counted = async (queue = 'q') =>
    Number(
      (
        await t.fresh.sql<Array<{ retained_count: string }>>`
          SELECT retained_count FROM qcloud_event_retention_state WHERE queue = ${queue}`
      )[0]?.retained_count ?? 0
    );

  test('events inside the window and under the cap are never deleted', async () => {
    await oneByOne(CAP);
    t.clock.advance(HOUR - 1);
    expect(await store.events.trim()).toEqual({ removed: 0, more: false });
    expect(await remaining()).toHaveLength(CAP);
    expect(await store.events.read(JOURNAL_START)).toMatchObject({ gap: false });
  });

  test('events past the window are deleted, and a reader behind them is told', async () => {
    await oneByOne(3);
    t.clock.advance(HOUR / 2);
    const later = await oneByOne(2);
    const readAll = await store.events.baseline();
    t.clock.advance(HOUR / 2 + 1);
    expect(await store.events.trim()).toEqual({ removed: 3, more: false });
    expect(await remaining()).toEqual(later);

    const behind = await store.events.read(JOURNAL_START);
    expect(behind).toMatchObject({ events: [], more: true, gap: true });
    // The reader reloads from the jobs and goes on from the cursor it was given.
    const onward = await store.events.read(behind.cursor);
    expect(onward.gap).toBe(false);
    expect(onward.events.map((event) => event.jobId)).toEqual(later);
    // A reader that had read everything is not told anything.
    expect(await store.events.read(readAll)).toMatchObject({ events: [], gap: false });
  });

  test('a reader that consumed the deleted commits is not told, one inside them is', async () => {
    await oneByOne(3);
    const cursors: EventCursor[] = [];
    for (const limit of [1, 2, 3]) {
      cursors.push((await store.events.read(JOURNAL_START, { limit })).cursor);
    }
    t.clock.advance(HOUR + 1);
    const [live] = await oneByOne(1);
    await store.events.trim();
    expect((await store.events.read(cursors[0]!)).gap).toBe(true);
    expect((await store.events.read(cursors[1]!)).gap).toBe(true);
    const clear = await store.events.read(cursors[2]!);
    expect(clear.gap).toBe(false);
    expect(clear.events.map((event) => event.jobId)).toEqual([live!]);
  });

  test('a queue over its cap loses its oldest events, and only readers of that queue are told', async () => {
    const q = await oneByOne(12, 'q');
    const other = await oneByOne(4, 'other');
    expect(await store.events.trim()).toMatchObject({ removed: 12 - CAP });
    expect(await remaining('q')).toEqual(q.slice(-CAP));
    expect(await remaining('other')).toEqual(other);
    expect(await counted('q')).toBe(CAP);
    expect(await counted('other')).toBe(4);

    expect((await store.events.read(JOURNAL_START, { queue: 'other' })).gap).toBe(false);
    const behind = await store.events.read(JOURNAL_START, { queue: 'q' });
    expect(behind.gap).toBe(true);
    expect((await store.events.read(JOURNAL_START)).gap).toBe(true);
    const onward = await store.events.read(behind.cursor, { queue: 'q' });
    expect(onward).toMatchObject({ gap: false });
    expect(onward.events.map((event) => event.jobId)).toEqual(q.slice(-CAP));
  });

  test('the cap is the one way an event inside the window goes, and it raises the flag', async () => {
    await oneByOne(CAP + 2);
    const reader: EventCursor = (await store.events.read(JOURNAL_START, { limit: 1 })).cursor;
    t.clock.advance(1_000);
    await store.events.trim();
    expect(await remaining()).toHaveLength(CAP);
    // Two events went and the reader had read one: the second is lost to it, so it is told.
    expect((await store.events.read(reader)).gap).toBe(true);
    // A reader that had read both is clear.
    const ahead = (await store.events.read(JOURNAL_START, { limit: 2 })).cursor;
    expect((await store.events.read(ahead)).gap).toBe(false);
  });

  test('a pass deletes at most its limit and says there is more', async () => {
    await oneByOne(12);
    expect(await store.events.trim(2)).toEqual({ removed: 2, more: true });
    let rounds = 0;
    while ((await store.events.trim(2)).more) rounds++;
    expect(rounds).toBeGreaterThan(0);
    expect(await remaining()).toHaveLength(CAP);
    expect(await counted()).toBe(CAP);
    expect(await store.events.trim(2)).toEqual({ removed: 0, more: false });
  });

  test('concurrent sweeps never delete more than the excess', async () => {
    await oneByOne(12);
    await Promise.all(
      [store, t.another({ maxQueueEvents: CAP }), t.another({ maxQueueEvents: CAP })].map((each) =>
        each.events.trim()
      )
    );
    expect(await remaining()).toHaveLength(CAP);
    expect(await counted()).toBe(CAP);
  });

  test('one watermark per queue survives however many sweeps ran', async () => {
    await oneByOne(8);
    await store.events.trim();
    await oneByOne(4);
    await store.events.trim();
    t.clock.advance(HOUR + 1);
    await store.events.trim();
    expect(await marks()).toBe(1);
    expect(await remaining()).toEqual([]);
    expect((await store.events.read(JOURNAL_START)).gap).toBe(true);
  });

  test('commit envelopes go once nothing refers to them, and not before', async () => {
    await oneByOne(3);
    t.clock.advance(HOUR + 1);
    await oneByOne(2);
    expect(await envelopes()).toBe(5);
    await store.events.trim();
    // Three envelopes of deleted events, two of live ones, and the pruning commit's own.
    expect(await envelopes()).toBe(6);
    expect(await store.events.pruneCommits()).toBe(3);
    expect(await envelopes()).toBe(3);
    expect(await store.events.pruneCommits()).toBe(0);
    // The watermark still tells a stale reader, and the live events still read.
    expect((await store.events.read(JOURNAL_START)).gap).toBe(true);

    t.clock.advance(HOUR + 1);
    await store.events.trim();
    // The first watermark was superseded and the two events are gone: only the new watermark's remains.
    expect(await store.events.pruneCommits()).toBe(3);
    expect(await envelopes()).toBe(1);
    expect((await store.events.read(JOURNAL_START)).gap).toBe(true);
  });

  test('pruning envelopes is bounded by its limit', async () => {
    await oneByOne(4);
    t.clock.advance(HOUR + 1);
    await store.events.trim();
    expect(await store.events.pruneCommits(2)).toBe(2);
    expect(await store.events.pruneCommits(2)).toBe(2);
    expect(await store.events.pruneCommits(2)).toBe(0);
  });

  test('one pass looks at a bounded number of envelopes, and the passes after it reach the rest', async () => {
    // 25 queues with one live event each put 25 live envelopes ahead of the dead one. A pass with
    // limit 2 looks at 20 envelopes, so the first cannot reach it and a later one must.
    for (let i = 0; i < 25; i++) await enqueueN(store, 1, {}, `quiet-${i}`);
    await oneByOne(CAP + 1);
    await store.events.trim();
    const before = await envelopes();
    expect(await store.events.pruneCommits(2)).toBe(0);
    let deleted = 0;
    for (let pass = 0; pass < 10 && deleted === 0; pass++) {
      deleted += await store.events.pruneCommits(2);
    }
    expect(deleted).toBe(1);
    expect(await envelopes()).toBe(before - 1);
    // Every other envelope is live, and the scan comes round to the start again without deleting one.
    for (let pass = 0; pass < 10; pass++) expect(await store.events.pruneCommits(2)).toBe(0);
    expect(await remaining('quiet-0')).toHaveLength(1);
  });

  test('folding a burst of counts takes time in proportion to the burst, whatever the planner knows', async () => {
    // A table nobody has analyzed, which is what the first burst after a quiet spell meets: the planner
    // thinks it holds a handful of rows. A fold that joins the rows it locked to the table is then
    // planned as a nested loop over every pair, and 25,000 counts take well over the statement deadline.
    await t.fresh.sql.unsafe(
      'ALTER TABLE qcloud_event_retention_deltas SET (autovacuum_enabled = false)'
    );
    await t.fresh.sql`
      INSERT INTO qcloud_event_retention_deltas
        (namespace, queue, transaction_id, delta_count, last_event_id)
      SELECT 'test', 'burst', n, 1, n FROM generate_series(1, 25000) AS n`;
    const started = performance.now();
    await store.events.trim(10);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await counted('burst')).toBe(25_000);
    const [left] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_event_retention_deltas WHERE queue = 'burst'`;
    expect(left.n).toBe(0);
  }, 60_000);

  test('the tick trims the journal and reports when it has more to do', async () => {
    await oneByOne(3);
    t.clock.advance(HOUR + 1);
    const report = await store.tick({ ...BUDGET, maxItems: 1 });
    expect(report.moreWork).toBe(true);
    expect(await remaining()).toHaveLength(2);
    const done = await store.tick(BUDGET);
    expect(done.moreWork).toBe(false);
    expect(await remaining()).toEqual([]);
  });

  test('retention leaves another namespace alone', async () => {
    const other = t.another({ namespace: 'other', eventRetentionMs: HOUR, maxQueueEvents: CAP });
    await enqueueN(other, 1, {}, 'q');
    await oneByOne(8);
    t.clock.advance(HOUR + 1);
    await store.events.trim();
    expect((await other.events.read(JOURNAL_START)).events).toHaveLength(1);
    expect((await other.events.read(JOURNAL_START)).gap).toBe(false);
  });
});
