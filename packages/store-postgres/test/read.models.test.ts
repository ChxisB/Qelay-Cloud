import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { JobState } from '@qelay-cloud/core';
import { JOB_STATES, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_PAGE_OFFSET, MAX_PAGE_SIZE } from '../src/store/readModels';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const NO_JOBS = Object.fromEntries(JOB_STATES.map((state) => [state, 0])) as Record<
  JobState,
  number
>;

describeDb('read models: summaries, dashboard, jobs by state', () => {
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

  /** In queue `q`: 3 waiting, 2 prioritized, 2 delayed, 1 active, 2 completed, 1 failed, 1 waiting-children. */
  async function seed(queue = 'q') {
    // Claims first: `claimOne` takes the best claimable job, which must be the one it just added.
    const done = [await claimOne(t, {}, queue), await claimOne(t, {}, queue)];
    for (const job of done) await t.store.complete(job.lease, 'ok');
    const dead = await claimOne(t, { attempts: 1 }, queue);
    await t.store.fail(dead.lease, { message: 'x', unrecoverable: true });
    const running = await claimOne(t, {}, queue);
    const waiting = await enqueueN(t.store, 3, {}, queue);
    const prioritized = await enqueueN(t.store, 2, { priority: 5 }, queue);
    const delayed = await enqueueN(t.store, 2, { delay: 60_000 }, queue);
    const [child] = await enqueueN(t.store, 1, {}, queue);
    await t.fresh.sql`UPDATE qcloud_jobs SET state = 'waiting-children' WHERE id = ${child!}`;
    return { waiting, prioritized, delayed, done, dead, running, child: child! };
  }

  const SEEDED = {
    waiting: 3,
    prioritized: 2,
    delayed: 2,
    'waiting-children': 1,
    active: 1,
    completed: 2,
    failed: 1,
  };

  test('counts by state agree with the store contract, and with every state listing', async () => {
    await seed();
    expect(await t.store.counts('q')).toEqual(SEEDED);
    for (const state of JOB_STATES) {
      const page = await t.store.readModels.jobsByState('q', state, { limit: 100 });
      expect(page.total).toBe(SEEDED[state]);
      expect(page.items).toHaveLength(SEEDED[state]);
      expect(page.items.every((job) => job.state === state)).toBe(true);
    }
  });

  test('a stored delayed job past its time counts and lists as waiting', async () => {
    await enqueueN(t.store, 2, { delay: 10_000 }, 'q');
    t.clock.advance(10_000);
    expect(await t.store.counts('q')).toMatchObject({ waiting: 2, delayed: 0 });
    expect((await t.store.readModels.jobsByState('q', 'waiting')).total).toBe(2);
    expect((await t.store.readModels.jobsByState('q', 'delayed')).total).toBe(0);
  });

  test('claimable states come in claim order, delayed by due time, the rest newest first', async () => {
    const ids = await seed();
    const { readModels } = t.store;
    expect((await readModels.jobsByState('q', 'waiting')).items.map((job) => job.id)).toEqual(
      ids.waiting
    );
    expect((await readModels.jobsByState('q', 'prioritized')).items.map((job) => job.id)).toEqual(
      ids.prioritized
    );
    expect((await readModels.jobsByState('q', 'completed')).items.map((job) => job.id)).toEqual(
      [...ids.done.map((job) => job.id)].reverse()
    );
    const { items } = await readModels.jobsByState('q', 'delayed');
    expect(items.map((job) => job.runAt)).toEqual([...items.map((job) => job.runAt)].sort());
  });

  test('a higher priority comes first among prioritized jobs', async () => {
    const [low] = await enqueueN(t.store, 1, { priority: 1 }, 'q');
    const [high] = await enqueueN(t.store, 1, { priority: 9 }, 'q');
    const page = await t.store.readModels.jobsByState('q', 'prioritized');
    expect(page.items.map((job) => job.id)).toEqual([high!, low!]);
  });

  test('limit and offset page through a state, and the total does not move', async () => {
    const ids = await enqueueN(t.store, 7, {}, 'q');
    const seen: string[] = [];
    for (let offset = 0; offset < 8; offset += 3) {
      const page = await t.store.readModels.jobsByState('q', 'waiting', { limit: 3, offset });
      expect(page.total).toBe(7);
      seen.push(...page.items.map((job) => job.id));
    }
    expect(seen).toEqual(ids);
    expect(
      (await t.store.readModels.jobsByState('q', 'waiting', { limit: 3, offset: 50 })).items
    ).toEqual([]);
  });

  test('a job is returned with its payload and lease as the contract reads them', async () => {
    const ids = await seed();
    const [active] = (await t.store.readModels.jobsByState('q', 'active')).items;
    expect(active).toEqual((await t.store.getJob(ids.running.id))!);
    expect(active!.lease).not.toBeNull();
  });

  test('queues are separate, and an unknown queue is empty', async () => {
    await seed('a');
    await enqueueN(t.store, 1, {}, 'b');
    expect((await t.store.readModels.jobsByState('b', 'waiting')).total).toBe(1);
    expect(await t.store.readModels.jobsByState('none', 'waiting')).toEqual({
      items: [],
      total: 0,
    });
  });

  test('queue summaries list queues by name with their counts and pause state', async () => {
    await seed('b');
    await enqueueN(t.store, 2, {}, 'a');
    await t.store.pause('a');
    await t.store.queues.setStallConfig('c', { maxStalls: 1 });
    const { items, next } = await t.store.readModels.queueSummaries();
    expect(next).toBeNull();
    expect(items).toEqual([
      { queue: 'a', paused: true, counts: { ...NO_JOBS, waiting: 2 } },
      { queue: 'b', paused: false, counts: SEEDED },
      { queue: 'c', paused: false, counts: NO_JOBS },
    ]);
  });

  test('queue summaries page by name', async () => {
    for (const queue of ['q1', 'q2', 'q3', 'q4', 'q5']) await enqueueN(t.store, 1, {}, queue);
    const first = await t.store.readModels.queueSummaries({ limit: 2 });
    expect(first.items.map((item) => item.queue)).toEqual(['q1', 'q2']);
    const second = await t.store.readModels.queueSummaries({ limit: 2, after: first.next! });
    expect(second.items.map((item) => item.queue)).toEqual(['q3', 'q4']);
    const last = await t.store.readModels.queueSummaries({ limit: 2, after: second.next! });
    expect(last).toMatchObject({ items: [{ queue: 'q5' }], next: null });
  });

  test('queue summaries hold only the namespace', async () => {
    await enqueueN(t.store, 1, {}, 'mine');
    const other = t.another({ namespace: 'other' });
    await enqueueN(other, 1, {}, 'theirs');
    expect((await t.store.readModels.queueSummaries()).items.map((item) => item.queue)).toEqual([
      'mine',
    ]);
    expect((await other.readModels.dashboard()).counts.waiting).toBe(1);
  });

  test('the dashboard sums the queues', async () => {
    await seed('a');
    await seed('b');
    await t.store.pause('b');
    expect(await t.store.readModels.dashboard()).toEqual({
      queues: 2,
      pausedQueues: 1,
      counts: Object.fromEntries(JOB_STATES.map((state) => [state, 2 * SEEDED[state]])) as Record<
        JobState,
        number
      >,
    });
  });

  test('the dashboard of an empty namespace is zero', async () => {
    expect(await t.store.readModels.dashboard()).toEqual({
      queues: 0,
      pausedQueues: 0,
      counts: NO_JOBS,
    });
  });

  test('priority counts cover what a worker could claim now, by priority, and nothing else', async () => {
    await seed();
    // 3 waiting at priority 0, 2 prioritized at 5, and the 2 delayed jobs are not claimable yet.
    expect(await t.store.readModels.priorityCounts('q')).toEqual({ '0': 3, '5': 2 });
    expect(await t.store.readModels.priorityCounts('other')).toEqual({});
    await enqueueN(t.store, 1, { priority: 5 }, 'other');
    expect(await t.store.readModels.priorityCounts('q')).toEqual({ '0': 3, '5': 2 });
  });

  test('a job is found by its custom id in its own queue only', async () => {
    await t.store.enqueue([{ queue: 'a', data: 1, options: { jobId: 'order-17' } }]);
    const found = await t.store.readModels.jobByCustomId('a', 'order-17');
    expect(found).toMatchObject({ id: 'order-17', queue: 'a', state: 'waiting', data: 1 });
    expect(found).toEqual((await t.store.getJob('order-17'))!);
    expect(await t.store.readModels.jobByCustomId('b', 'order-17')).toBeNull();
    expect(await t.store.readModels.jobByCustomId('a', 'order-18')).toBeNull();
  });

  test('a finished job is still found by its custom id', async () => {
    await t.store.enqueue([{ queue: 'a', data: 1, options: { jobId: 'k' } }]);
    const [job] = await t.store.claim('a', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    expect(await t.store.readModels.jobByCustomId('a', 'k')).toMatchObject({ state: 'completed' });
  });

  test.each<[string, () => Promise<unknown>, string]>([
    ['a limit of 0', () => t.store.readModels.jobsByState('q', 'waiting', { limit: 0 }), 'limit'],
    [
      'a limit over the cap',
      () => t.store.readModels.jobsByState('q', 'waiting', { limit: MAX_PAGE_SIZE + 1 }),
      'limit',
    ],
    [
      'a negative offset',
      () => t.store.readModels.jobsByState('q', 'waiting', { offset: -1 }),
      'offset',
    ],
    [
      'an offset over the cap',
      () => t.store.readModels.jobsByState('q', 'waiting', { offset: MAX_PAGE_OFFSET + 1 }),
      'offset',
    ],
    [
      'a fractional offset',
      () => t.store.readModels.jobsByState('q', 'waiting', { offset: 1.5 }),
      'offset',
    ],
    ['an unknown state', () => t.store.readModels.jobsByState('q', 'done' as JobState), 'state'],
    ['a blank queue', () => t.store.readModels.jobsByState('', 'waiting'), 'queue'],
    ['a summary limit of 0', () => t.store.readModels.queueSummaries({ limit: 0 }), 'limit'],
    ['a blank custom id', () => t.store.readModels.jobByCustomId('q', ''), 'customId'],
  ])('refuses %s', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
  });

  test('the clock is the injected one', async () => {
    await enqueueN(t.store, 1, { delay: 1_000 }, 'q');
    expect((await t.store.counts('q')).delayed).toBe(1);
    t.clock.advance(1_000);
    expect((await t.store.counts('q')).delayed).toBe(0);
    expect(t.clock.now()).toBe(START + 1_000);
  });
});
