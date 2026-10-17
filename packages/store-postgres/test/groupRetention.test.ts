import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { insertGroup, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const SECOND = 1_000;

describeDb('maintenance: group scheduler state', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const prune = (limit?: number) => t.store.maintenance.pruneGroupStates(limit);
  const row = async (groupId: string, namespace = 'test') =>
    (
      await t.fresh.sql<Array<{ last_served: string | null }>>`
        SELECT last_served FROM qcloud_group_state
        WHERE namespace = ${namespace} AND queue = 'q' AND group_id = ${groupId}`
    )[0];
  const groupJob = (id: string, options: { delay?: number } = {}) =>
    enqueueN(t.store, 1, { group: { id }, ...options });

  test('an idle group with nothing set is deleted', async () => {
    await insertGroup(t, 'g1');
    expect(await prune()).toEqual({ removed: 1, more: false });
    expect(await row('g1')).toBeUndefined();
  });

  test.each<[string, () => Promise<unknown>]>([
    ['a waiting job', () => groupJob('g1')],
    ['a delayed job', () => groupJob('g1', { delay: 60 * SECOND })],
    [
      'an active job',
      async () => {
        await groupJob('g1');
        await t.store.claim('q', 'w', 1);
      },
    ],
  ])('a group with %s keeps its row and its position', async (_label, setUp) => {
    await insertGroup(t, 'g1', { last_served: 7 });
    await setUp();
    // Claiming may give the group a new position; what matters is that it keeps one.
    const before = await row('g1');
    expect(await prune()).toEqual({ removed: 0, more: false });
    expect(await row('g1')).toEqual(before);
    expect((await row('g1'))?.last_served).not.toBeNull();
  });

  test('a group whose only job is finished is idle', async () => {
    await insertGroup(t, 'g1');
    await groupJob('g1');
    const [job] = await t.store.claim('q', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    expect(await prune()).toEqual({ removed: 1, more: false });
    expect(await row('g1')).toBeUndefined();
  });

  test('a group whose only job waits for children is idle: it cannot be claimed yet', async () => {
    await insertGroup(t, 'g1');
    const [id] = await groupJob('g1');
    await t.fresh.sql`UPDATE qcloud_jobs SET state = 'waiting-children' WHERE id = ${id!}`;
    expect(await prune()).toEqual({ removed: 1, more: false });
    // When it becomes claimable the next claim gives the group a position again.
    await t.fresh.sql`UPDATE qcloud_jobs SET state = 'waiting' WHERE id = ${id!}`;
    const [job] = await t.store.claim('q', 'w', 1);
    expect(job!.id).toBe(id!);
    expect(await row('g1')).toMatchObject({ last_served: expect.anything() });
  });

  test.each<[string, Record<string, number | boolean | null>]>([
    ['a rate limit of its own', { rate_limit: 5, rate_duration_ms: 1_000 }],
    ['a concurrency limit', { concurrency_limit: 2 }],
    ['a pause', { paused: true }],
    ['a manual rate limit still running', { manual_rate_limit_until: START + 5 * SECOND }],
    [
      'a rate window that has not run out',
      { rate_window_started_at: START - SECOND, rate_effective_duration_ms: 5 * SECOND },
    ],
    ['a rate window with no known length', { rate_window_started_at: START - SECOND }],
  ])('an idle group with %s keeps its row but loses its position', async (_label, columns) => {
    await insertGroup(t, 'g1', { last_served: 9, ...columns });
    expect(await prune()).toEqual({ removed: 0, more: false });
    expect(await row('g1')).toEqual({ last_served: null });
    // With nothing left to drop, the next pass leaves it be.
    expect(await prune()).toEqual({ removed: 0, more: false });
    expect(await row('g1')).toBeDefined();
  });

  test.each<[string, Record<string, number | boolean | null>]>([
    ['a manual rate limit that ended', { manual_rate_limit_until: START }],
    [
      'a rate window that ran out',
      { rate_window_started_at: START - 5 * SECOND, rate_effective_duration_ms: 5 * SECOND },
    ],
  ])('an idle group with %s is deleted', async (_label, columns) => {
    await insertGroup(t, 'g1', columns);
    expect(await prune()).toEqual({ removed: 1, more: false });
    expect(await row('g1')).toBeUndefined();
  });

  test('a group with a limit of its own keeps its row however long it has been idle', async () => {
    await insertGroup(t, 'g1', { rate_limit: 5, rate_duration_ms: 1_000 });
    t.clock.advance(10 * SECOND);
    expect(await prune()).toEqual({ removed: 0, more: false });
    expect(await row('g1')).toBeDefined();
  });

  test('a pass handles at most its limit and says there is more', async () => {
    for (let i = 0; i < 5; i++) await insertGroup(t, `g${i}`);
    expect(await prune(2)).toEqual({ removed: 2, more: true });
    expect(await prune(2)).toEqual({ removed: 2, more: true });
    expect(await prune(2)).toEqual({ removed: 1, more: false });
    expect(await prune(2)).toEqual({ removed: 0, more: false });
  });

  test('a group row another transaction holds is skipped, not waited for', async () => {
    await insertGroup(t, 'g1');
    await insertGroup(t, 'g2');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const claimer = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM qcloud_group_state WHERE group_id = 'g1' FOR UPDATE`;
      locked();
      await held;
    });
    await acquired;
    expect(await prune()).toEqual({ removed: 1, more: false });
    expect(await row('g1')).toBeDefined();
    release();
    await claimer;
    expect(await prune()).toEqual({ removed: 1, more: false });
  });

  test('a group with a pending job is kept while its idle neighbour goes', async () => {
    await insertGroup(t, 'g1');
    await insertGroup(t, 'g2');
    await groupJob('g2');
    expect(await prune()).toEqual({ removed: 1, more: false });
    expect(await row('g1')).toBeUndefined();
    expect(await row('g2')).toBeDefined();
  });

  test('a pruned group is served again from the next job it gets', async () => {
    await groupJob('g1');
    const [first] = await t.store.claim('q', 'w', 1);
    await t.store.complete(first!.lease, 'ok');
    expect(await row('g1')).toBeDefined();
    expect(await prune()).toEqual({ removed: 1, more: false });
    const [id] = await groupJob('g1');
    const [again] = await t.store.claim('q', 'w', 1);
    expect(again!.id).toBe(id!);
    expect(await row('g1')).toBeDefined();
  });

  test('leaves other namespaces and queues’ groups alone', async () => {
    await insertGroup(t, 'g1');
    await insertGroup(t, 'g1', {}, { namespace: 'other' });
    await insertGroup(t, 'g1', {}, { queue: 'elsewhere' });
    expect(await prune()).toEqual({ removed: 2, more: false });
    expect(await row('g1', 'other')).toBeDefined();
  });

  test('two passes at once delete each row once', async () => {
    for (let i = 0; i < 40; i++) await insertGroup(t, `g${i}`);
    const reports = await Promise.all([prune(), t.another().maintenance.pruneGroupStates()]);
    expect(reports.reduce((sum, report) => sum + report.removed, 0)).toBe(40);
  });

  test('pruning while grouped jobs are enqueued, claimed and completed loses no job', async () => {
    const workers = [t.another(), t.another()];
    const ids = new Set<string>();
    for (let round = 0; round < 5; round++) {
      for (const group of ['a', 'b', 'c', 'd']) {
        for (const id of await groupJob(`${group}${round}`)) ids.add(id);
      }
    }
    const done = new Set<string>();
    let pruning = true;
    const pruner = (async () => {
      while (pruning) await t.another().maintenance.pruneGroupStates();
    })();
    await Promise.all(
      workers.map(async (worker, index) => {
        for (let idle = 0; idle < 20;) {
          const claimed = await worker.claim('q', `w${index}`, 2);
          idle = claimed.length === 0 ? idle + 1 : 0;
          for (const job of claimed) {
            expect(done.has(job.id)).toBe(false);
            done.add(job.id);
            await worker.complete(job.lease, 'ok');
          }
          if (claimed.length === 0) await Bun.sleep(5);
        }
      })
    );
    pruning = false;
    await pruner;
    expect(done).toEqual(ids);
  });
});
