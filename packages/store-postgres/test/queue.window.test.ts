import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { countStatements } from './statementCount';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// START is 08:00 UTC; the window is 12:00 to 13:00 UTC every day.
const NOON = START + 4 * HOUR;
const NIGHTLY = { cron: '0 12 * * *', durationMs: HOUR, timezone: 'UTC' };
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('queue run window', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 10_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const at = (ms: number) => t.clock.advance(ms - t.clock.now());
  const claim = async (queue = 'q') => (await t.store.claim(queue, 'w', 10)).length;
  const tick = () => t.store.tick(BUDGET);

  test('a window is read back, replaced whole and removed, with where it stands', async () => {
    expect(await t.store.queues.runWindow('q')).toBeNull();
    expect(await t.store.queues.setRunWindow('q', NIGHTLY)).toEqual({
      ...NIGHTLY,
      open: false,
      opensAt: NOON,
      closesAt: NOON + HOUR,
    });
    expect(await t.store.queues.runWindow('q')).toMatchObject({ open: false, opensAt: NOON });
    at(NOON + 1);
    expect(await t.store.queues.runWindow('q')).toMatchObject({ open: true });
    const hourly = { cron: '0 * * * *', durationMs: 600_000, timezone: 'UTC' };
    expect(await t.store.queues.setRunWindow('q', hourly)).toMatchObject({ ...hourly, open: true });
    expect(await t.store.queues.setRunWindow('q', null)).toBeNull();
    expect(await t.store.queues.runWindow('q')).toBeNull();
  });

  test('the time zone decides when it opens', async () => {
    const state = await t.store.queues.setRunWindow('q', {
      ...NIGHTLY,
      timezone: 'America/New_York',
    });
    // 12:00 in New York in January is 17:00 UTC.
    expect(state?.opensAt).toBe(START + 9 * HOUR);
  });

  test('a window that cannot be saved is refused by field, and the stored one stays', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    for (const [window, option] of [
      [{ ...NIGHTLY, cron: 'not a cron' }, 'runWindow'],
      [{ ...NIGHTLY, cron: '0 0 31 2 *' }, 'runWindow'],
      [{ ...NIGHTLY, durationMs: 1000 }, 'durationMs'],
      [{ ...NIGHTLY, timezone: 'Mars/Base' }, 'runWindow'],
    ] as const) {
      const error = await t.store.queues.setRunWindow('q', window).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect((error as UnsupportedOptionError).option).toBe(option);
    }
    expect(await t.store.queues.runWindow('q')).toMatchObject(NIGHTLY);
  });

  test('outside the window a claim finds nothing and the job waits; inside, it runs', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    const [id] = await enqueueN(t.store, 1);
    expect(await claim()).toBe(0);
    at(NOON - 1);
    expect(await claim()).toBe(0);
    at(NOON);
    const [job] = await t.store.claim('q', 'w', 10);
    expect(job?.id).toBe(id!);
  });

  test('a job that is running when the window closes finishes, and nothing new starts', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 2);
    at(NOON);
    const [first] = await t.store.claim('q', 'w', 1);
    at(NOON + HOUR);
    expect(await claim()).toBe(0);
    await t.store.complete(first!.lease, 'done');
    expect(await claim()).toBe(0);
  });

  test('pause beats an open window, and a window beats nothing else', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 1);
    at(NOON);
    await t.store.pause('q');
    expect(await claim()).toBe(0);
    await t.store.resume('q');
    expect(await claim()).toBe(1);
  });

  test('a queue with a rate limit is held by the window too', async () => {
    await t.store.setRateLimit('q', { max: 5, durationMs: 1000 });
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 1);
    expect(await claim()).toBe(0);
    at(NOON);
    expect(await claim()).toBe(1);
  });

  test('other queues are not held, and removing the window frees the queue', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 1);
    await enqueueN(t.store, 1, {}, 'free');
    expect(await claim('free')).toBe(1);
    expect(await claim()).toBe(0);
    await t.store.queues.setRunWindow('q', null);
    expect(await claim()).toBe(1);
  });

  test('the tick moves the window to the next day, and a day is not skipped', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 1);
    at(NOON + HOUR);
    expect(await tick()).toMatchObject({ moreWork: false });
    expect(await t.store.queues.runWindow('q')).toMatchObject({
      open: false,
      opensAt: NOON + DAY,
      closesAt: NOON + DAY + HOUR,
    });
    expect(await claim()).toBe(0);
    at(NOON + DAY);
    expect(await claim()).toBe(1);
  });

  test('a tick that was down through the opening still opens the window when it returns', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    await enqueueN(t.store, 2);
    // Two days and a half later, in the middle of that day's window, and no tick ran in between.
    at(NOON + 2 * DAY + HOUR / 2);
    expect(await claim()).toBe(0);
    await tick();
    expect(await t.store.queues.runWindow('q')).toMatchObject({
      open: true,
      opensAt: NOON + 2 * DAY,
    });
    expect(await claim()).toBe(2);
  });

  test('two ticks at once move a window once', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    at(NOON + HOUR);
    const [a, b] = await Promise.all([tick(), tick()]);
    expect(a!.moreWork || b!.moreWork).toBe(false);
    expect(await t.store.queues.runWindow('q')).toMatchObject({ opensAt: NOON + DAY });
  });

  test('a job added while the window is closed is not rung; the tick rings it when it opens', async () => {
    await t.store.queues.setRunWindow('q', NIGHTLY);
    const [added] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
    expect(added?.ring).toBeNull();
    const [free] = await t.store.enqueue([{ queue: 'free', data: 1 }]);
    expect(free?.ring).not.toBeNull();
    at(NOON - 10_000);
    expect((await tick()).rings.map((ring) => ring.bell.queue)).toEqual(['free']);
    at(NOON);
    expect((await tick()).rings.map((ring) => ring.bell.jobId)).toContain(added!.id);
  });

  test('a job that was rung before the window closed is rung again once it opens', async () => {
    const [id] = await enqueueN(t.store, 1);
    await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
    await t.store.queues.setRunWindow('q', NIGHTLY);
    at(NOON - 1_000);
    // Closed: its old bell would be spent on an empty claim, so the queue is left alone however old the bell is.
    expect(await tick()).toMatchObject({ rings: [] });
    at(NOON);
    expect((await tick()).rings.map((ring) => ring.bell.jobId)).toEqual([id!]);
  });

  test('an enqueue costs no statement more for a queue with a window', async () => {
    const counted = countStatements(t.fresh.db);
    const store = t.another({ db: counted.db });
    await store.enqueue([{ queue: 'plain', data: 1 }]);
    const plain = counted.count();
    await t.store.queues.setRunWindow('with', NIGHTLY);
    counted.reset();
    await store.enqueue([{ queue: 'with', data: 1 }]);
    expect(counted.count()).toBe(plain);
  });
});
