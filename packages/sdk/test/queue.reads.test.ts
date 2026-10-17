import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

describeDb('queue: listing and counting', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
    await f.fresh.sql`TRUNCATE qcloud_workers`;
  });

  /** One job in each of waiting, delayed, active, completed and failed; returns the ids by state. */
  async function everyState() {
    const queue = f.queue();
    const done = await queue.add('c', 'completed');
    const bad = await queue.add('f', 'failed');
    const running = await queue.add('a', 'active');
    for (const claim of await f.store.claim('q', 'w', 3)) {
      if (claim.id === done.id) await f.store.complete(claim.lease, 'ok');
      if (claim.id === bad.id)
        await f.store.fail(claim.lease, { message: 'no', unrecoverable: true });
    }
    const waiting = await queue.add('w', 'waiting');
    const delayed = await queue.add('d', 'delayed', { delay: 60_000 });
    return {
      waiting: waiting.id,
      delayed: delayed.id,
      completed: done.id,
      failed: bad.id,
      active: running.id,
    };
  }

  describe('by state', () => {
    test('each getter returns the jobs of its state, and the Async variant the same', async () => {
      const ids = await everyState();
      const queue = f.queue();
      const idsOf = async (jobs: Promise<Array<{ id: string }>>) =>
        (await jobs).map((job) => job.id);
      expect(await idsOf(queue.getWaiting())).toEqual([ids.waiting]);
      expect(await idsOf(queue.getDelayed())).toEqual([ids.delayed]);
      expect(await idsOf(queue.getActive())).toEqual([ids.active]);
      expect(await idsOf(queue.getCompleted())).toEqual([ids.completed]);
      expect(await idsOf(queue.getFailed())).toEqual([ids.failed]);
      expect(await idsOf(queue.getWaitingAsync())).toEqual([ids.waiting]);
      expect(await idsOf(queue.getFailedAsync())).toEqual([ids.failed]);
      expect(await queue.getPrioritized()).toEqual([]);
      expect(await queue.getWaitingChildren()).toEqual([]);
    });

    test('a listed job is a full job: data, result, failure and timestamps', async () => {
      await everyState();
      const [failed] = await f.queue().getFailed<string>();
      expect(failed).toMatchObject({ name: 'f', data: 'failed', failedReason: 'no' });
      expect(failed!.finishedOn).toBeGreaterThan(0);
      const [completed] = await f.queue().getCompleted();
      expect(completed).toMatchObject({ returnvalue: 'ok' });
    });

    test('a job with a priority is prioritized, not waiting', async () => {
      const queue = f.queue();
      const job = await queue.add('p', 1, { priority: 4 });
      expect((await queue.getPrioritized()).map((one) => one.id)).toEqual([job.id]);
      expect(await queue.getWaiting()).toEqual([]);
      expect(await queue.getPrioritizedCount()).toBe(1);
    });

    test("another queue's jobs are never listed", async () => {
      await f.queue('one').add('a', 1);
      expect(await f.queue('two').getJobs()).toEqual([]);
      expect(await f.queue('two').count()).toBe(0);
    });
  });

  describe('getJobs paging', () => {
    test('walks the states in the order asked and pages across them', async () => {
      const queue = f.queue();
      const waiting = await queue.addBulk(
        Array.from({ length: 3 }, (_, n) => ({ name: 'w', data: n }))
      );
      const delayed = await queue.addBulk(
        Array.from({ length: 2 }, (_, n) => ({ name: 'd', data: n, opts: { delay: 60_000 } }))
      );
      const all = await queue.getJobs({ state: ['waiting', 'delayed'] });
      expect(all.map((job) => job.name)).toEqual(['w', 'w', 'w', 'd', 'd']);
      const page = await queue.getJobs({ state: ['waiting', 'delayed'], start: 2, end: 4 });
      expect(page.map((job) => job.id)).toEqual([waiting[2]!.id, all[3]!.id]);
      const skipped = await queue.getJobs({ state: ['waiting', 'delayed'], start: 3, end: 5 });
      expect(new Set(skipped.map((job) => job.id))).toEqual(new Set(delayed.map((job) => job.id)));
      expect(await queue.getJobs({ state: 'waiting', start: 3, end: 10 })).toEqual([]);
    });

    test('end is exclusive and defaults to 100', async () => {
      const queue = f.queue();
      await queue.addBulk(Array.from({ length: 120 }, (_, n) => ({ name: 'n', data: n })));
      expect(await queue.getJobs()).toHaveLength(100);
      expect(await queue.getJobs({ start: 5, end: 8 })).toHaveLength(3);
    });

    test('with no state, every state is read', async () => {
      await everyState();
      expect((await f.queue().getJobs()).map((job) => job.name).sort()).toEqual([
        'a',
        'c',
        'd',
        'f',
        'w',
      ]);
    });

    test('what Qelay accepted and this does not is refused, never read wrongly', async () => {
      const queue = f.queue();
      const refused = [
        { state: 'paused' },
        { state: 'nonsense' },
        { state: ['waiting', 'nonsense'] },
        { asc: true },
        { end: -1 },
        { start: -1 },
        { start: 5, end: 5 },
        { start: 0, end: 1001 },
        { start: 1.5 },
      ];
      for (const opts of refused) {
        await expect(queue.getJobs(opts as never)).rejects.toBeInstanceOf(UnsupportedOptionError);
      }
      await expect(queue.getWaiting(0, 1000)).resolves.toEqual([]);
    });
  });

  describe('counts', () => {
    test('getJobCounts has every state; the helpers and count() agree', async () => {
      await everyState();
      const queue = f.queue();
      const counts = await queue.getJobCounts();
      expect(counts).toEqual({
        waiting: 1,
        prioritized: 0,
        active: 1,
        completed: 1,
        failed: 1,
        delayed: 1,
        paused: 0,
        'waiting-children': 0,
      });
      expect(await queue.getJobCountsAsync()).toEqual(counts);
      expect(await queue.getWaitingCount()).toBe(1);
      expect(await queue.getActiveCount()).toBe(1);
      expect(await queue.getCompletedCount()).toBe(1);
      expect(await queue.getFailedCount()).toBe(1);
      expect(await queue.getDelayedCount()).toBe(1);
      expect(await queue.getWaitingChildrenCount()).toBe(0);
      expect(await queue.count()).toBe(2);
      expect(await queue.countAsync()).toBe(2);
    });

    test('while paused, the ready jobs are counted as paused and still counted by count()', async () => {
      const queue = f.queue();
      await queue.add('a', 1);
      await queue.add('b', 2, { priority: 3 });
      await queue.pause();
      expect(await queue.getJobCounts()).toMatchObject({ waiting: 0, prioritized: 0, paused: 2 });
      expect(await queue.count()).toBe(2);
      await queue.resume();
      expect(await queue.getJobCounts()).toMatchObject({ waiting: 1, prioritized: 1, paused: 0 });
    });
  });

  describe('workers', () => {
    test('getWorkers lists the workers that take this queue, and getWorkersCount counts them', async () => {
      await f.store.workers.register({ id: 'w1', queues: ['q', 'other'], concurrency: 4 });
      await f.store.workers.register({ id: 'w2', queues: ['other'] });
      const queue = f.queue();
      expect((await queue.getWorkers()).map((worker) => worker.id)).toEqual(['w1']);
      expect(await queue.getWorkersCount()).toBe(1);
      expect(await f.queue('nobody').getWorkersCount()).toBe(0);
    });
  });
});
