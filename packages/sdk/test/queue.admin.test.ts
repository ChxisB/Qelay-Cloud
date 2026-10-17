import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { JobStateError, UnsupportedOptionError } from '@qelay-cloud/core';
import { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { freshSchema } from '../../store-postgres/test/helpers';
import { Queue } from '../src';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';

describeDb('queue: administration', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });

  /** Adds a job, runs it to the end as a worker would, and returns its id. */
  async function finish(how: 'complete' | 'fail', queue = 'q') {
    const job = await f.queue(queue).add('n', how);
    const claimed = (await f.store.claim(queue, 'w', 1))[0]!;
    if (how === 'complete') await f.store.complete(claimed.lease, 'ok');
    else await f.store.fail(claimed.lease, { message: 'no', unrecoverable: true });
    return job.id;
  }

  describe('pause and ready', () => {
    test('pause, isPaused and resume, with their Async names', async () => {
      const queue = f.queue();
      expect(await queue.isPaused()).toBe(false);
      await queue.pause();
      expect(await queue.isPausedAsync()).toBe(true);
      expect(await f.queue('other').isPaused()).toBe(false);
      await queue.resumeAsync();
      expect(await queue.isPaused()).toBe(false);
      await queue.pauseAsync();
      await queue.resume();
      expect(await queue.isPaused()).toBe(false);
    });

    test('a paused queue hands out no claim', async () => {
      const queue = f.queue();
      await queue.add('a', 1);
      await queue.pause();
      expect(await f.store.claim('q', 'w', 1)).toEqual([]);
    });

    test('waitUntilReady resolves on a migrated schema and rejects on one that was not migrated', async () => {
      await expect(f.queue().waitUntilReady()).resolves.toBeUndefined();
      const bare = await freshSchema();
      const queue = new Queue('q', {
        databaseUrl: testDatabaseUrl(),
        database: { schema: bare.name },
        transport: f.transport,
      });
      try {
        await expect(queue.waitUntilReady()).rejects.toThrow();
      } finally {
        await queue.close({ timeout: 1000 });
        await bare.drop();
      }
    });
  });

  describe('drain, clean and obliterate', () => {
    test('drain removes the waiting, prioritized and delayed jobs and no others', async () => {
      const queue = f.queue();
      const done = await finish('complete');
      await queue.add('a', 1);
      await queue.add('b', 2, { priority: 2 });
      await queue.add('c', 3, { delay: 60_000 });
      expect(await queue.drain()).toBe(3);
      expect(await queue.drainAsync()).toBe(0);
      expect(await queue.getJob(done)).not.toBeNull();
      expect(await queue.count()).toBe(0);
    });

    test('drain works in batches until nothing is left', async () => {
      const queue = f.queue();
      for (let round = 0; round < 3; round += 1) {
        await queue.addBulk(Array.from({ length: 700 }, (_, n) => ({ name: 'n', data: n })));
      }
      expect(await queue.drain()).toBe(2100);
      expect(await queue.getJobCounts()).toMatchObject({ waiting: 0 });
    });

    test('clean removes finished jobs older than the grace and returns their ids', async () => {
      const queue = f.queue();
      const a = await finish('complete');
      const b = await finish('complete');
      const failed = await finish('fail');
      expect(await queue.clean(3_600_000, 0)).toEqual([]);
      const first = await queue.clean(0, 1);
      expect(first).toHaveLength(1);
      const rest = await queue.cleanAsync(0, 0, 'completed');
      expect([...first, ...rest].sort()).toEqual([a, b].sort());
      expect(await queue.getCompletedCount()).toBe(0);
      expect(await queue.clean(0, 0, 'failed')).toEqual([failed]);
    });

    test('clean with limit 0 removes every match, past one batch', async () => {
      const queue = f.queue();
      for (let n = 0; n < 12; n += 1) await finish('complete');
      expect(await queue.clean(0, 0)).toHaveLength(12);
    });

    test('clean takes the pending states too, and refuses active, paused and anything else', async () => {
      const queue = f.queue();
      await queue.add('a', 1);
      await queue.add('b', 2, { priority: 1 });
      await queue.add('c', 3, { delay: 60_000 });
      expect(await queue.clean(0, 0, 'wait')).toHaveLength(1);
      expect(await queue.clean(0, 0, 'prioritized')).toHaveLength(1);
      expect(await queue.clean(0, 0, 'delayed')).toHaveLength(1);
      for (const type of ['active', 'paused', 'nonsense']) {
        await expect(queue.clean(0, 0, type)).rejects.toBeInstanceOf(UnsupportedOptionError);
      }
      await expect(queue.clean(-1, 0)).rejects.toBeInstanceOf(UnsupportedOptionError);
      await expect(queue.clean(0, -1)).rejects.toBeInstanceOf(UnsupportedOptionError);
      await expect(queue.clean(0, 1.5)).rejects.toBeInstanceOf(UnsupportedOptionError);
    });

    test('clean touches only its own queue', async () => {
      await finish('complete', 'one');
      expect(await f.queue('two').clean(0, 0)).toEqual([]);
      expect(await f.queue('one').getCompletedCount()).toBe(1);
    });

    test('obliterate removes the queue and leaves the others', async () => {
      await f.queue('one').add('a', 1);
      await finish('complete', 'one');
      await f.queue('two').add('a', 1);
      await f.queue('one').obliterate();
      expect(await f.queue('one').getJobCounts()).toMatchObject({ waiting: 0, completed: 0 });
      expect(await f.queue('two').count()).toBe(1);
    });

    test('obliterate refuses an active job unless forced', async () => {
      const queue = f.queue();
      await queue.add('a', 1);
      await f.store.claim('q', 'w', 1);
      await expect(queue.obliterate()).rejects.toBeInstanceOf(JobStateError);
      expect(await queue.getActiveCount()).toBe(1);
      await queue.obliterateAsync({ force: true });
      expect(await queue.getActiveCount()).toBe(0);
    });
  });

  describe('promoteJobs', () => {
    test('promotes up to count delayed jobs and rings them', async () => {
      const queue = f.queue();
      await queue.addBulk(
        Array.from({ length: 3 }, (_, n) => ({ name: 'n', data: n, opts: { delay: 60_000 } }))
      );
      expect(await queue.promoteJobs({ count: 2 })).toBe(2);
      expect(await queue.getWaitingCount()).toBe(2);
      expect(await queue.promoteJobs()).toBe(1);
      expect(f.transport.buffered('q').ready).toBe(3);
    });

    test('a count outside 1 to 1000 is refused', async () => {
      for (const count of [0, 1001, 1.5]) {
        await expect(f.queue().promoteJobs({ count })).rejects.toBeInstanceOf(
          UnsupportedOptionError
        );
      }
    });
  });

  describe('configuration', () => {
    test('stall and DLQ configuration are stored per queue and unknown keys are refused', async () => {
      const queue = f.queue();
      expect(await queue.setStallConfig({ maxStalls: 5 })).toEqual({ maxStalls: 5 });
      expect(await queue.getStallConfigAsync()).toEqual({ maxStalls: 5 });
      expect(await f.queue('other').getStallConfig()).not.toEqual({ maxStalls: 5 });
      expect(await queue.setDlqConfigAsync({ maxEntries: 7 })).toMatchObject({ maxEntries: 7 });
      expect(await queue.getDlqConfig()).toMatchObject({ maxEntries: 7 });
      await expect(queue.setStallConfig({ lockDuration: 1 } as never)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      await expect(queue.setDlqConfig({ retry: true } as never)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
    });

    test('global concurrency is set, read and removed', async () => {
      const queue = f.queue();
      expect(await queue.getGlobalConcurrency()).toBeNull();
      await queue.setGlobalConcurrency(3);
      expect(await queue.getGlobalConcurrency()).toBe(3);
      await queue.removeGlobalConcurrencyAsync();
      expect(await queue.getGlobalConcurrency()).toBeNull();
      await queue.setGlobalConcurrencyAsync(2);
      await queue.removeGlobalConcurrency();
      expect(await queue.getGlobalConcurrency()).toBeNull();
    });

    test('the global rate limit is set with its window, read and removed', async () => {
      const queue = f.queue();
      expect(await queue.getGlobalRateLimit()).toBeNull();
      await queue.setGlobalRateLimit(5, 2_000);
      expect(await queue.getGlobalRateLimit()).toEqual({ max: 5, duration: 2_000 });
      await queue.setGlobalRateLimitAsync(9);
      expect(await queue.getGlobalRateLimit()).toEqual({ max: 9, duration: 1_000 });
      await queue.removeGlobalRateLimit();
      expect(await queue.getGlobalRateLimit()).toBeNull();
      await queue.setGlobalRateLimit(1);
      await queue.removeGlobalRateLimitAsync();
      expect(await queue.getGlobalRateLimit()).toBeNull();
    });
  });

  describe('the names the task plan uses', () => {
    test('setConcurrency, clearConcurrency, setRateLimit and clearRateLimit are the global limits', async () => {
      const queue = f.queue();
      await queue.setConcurrency(4);
      await queue.setRateLimit(2, 3_000);
      expect(await queue.getGlobalConcurrency()).toBe(4);
      expect(await queue.getGlobalRateLimit()).toEqual({ max: 2, duration: 3_000 });
      await queue.clearConcurrency();
      await queue.clearRateLimit();
      expect(await queue.getGlobalConcurrency()).toBeNull();
      expect(await queue.getGlobalRateLimit()).toBeNull();
    });

    test('removeJob, promote, updateData, changePriority and changeDelay act on one job', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1, { delay: 60_000 });
      await queue.updateData(job.id, 2);
      await queue.changePriority(job.id, { priority: 3 });
      await queue.changeDelay(job.id, 120_000);
      const read = (await queue.getJob(job.id))!;
      expect(read).toMatchObject({ data: 2, priority: 3 });
      await queue.promote(job.id);
      expect(await queue.getJobState(job.id)).toBe('prioritized');
      await queue.removeJob(job.id);
      expect(await queue.getJob(job.id)).toBeNull();
    });
  });

  describe('the dead-letter queue', () => {
    test('a job that failed for good is listed, read, counted and removed', async () => {
      const queue = f.queue();
      const id = await finish('fail');
      expect((await queue.getDlq()).map((entry) => entry.jobId)).toEqual([id]);
      expect((await queue.getDlqAsync({ limit: 1, offset: 0 })).length).toBe(1);
      expect((await queue.getDlqJobsAsync()).map((job) => job.id)).toEqual([id]);
      expect(await queue.getDlqStats()).toMatchObject({ total: 1 });
      expect(await queue.getDlqStatsAsync()).toMatchObject({ total: 1 });
      expect(await queue.removeDlqJob('nope')).toBe(false);
      expect(await queue.removeDlqJobAsync(id)).toBe(true);
      expect(await queue.getDlq()).toEqual([]);
    });

    test("purgeDlq removes every entry of the queue and no other queue's", async () => {
      await finish('fail', 'one');
      await finish('fail', 'one');
      await finish('fail', 'two');
      expect(await f.queue('one').purgeDlq()).toBe(2);
      expect(await f.queue('one').purgeDlqAsync()).toBe(0);
      expect((await f.queue('two').getDlq()).length).toBe(1);
      expect(await f.queue('two').removeDlqJob('missing')).toBe(false);
    });

    test('a filter with a key other than limit and offset is refused', async () => {
      await expect(f.queue().getDlq({ reason: 'x' } as never)).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
    });
  });

  describe('closing', () => {
    test('close is idempotent, disconnect is the same, and the transport stays usable', async () => {
      const queue = f.queue();
      await queue.add('a', 1);
      await queue.close();
      await queue.close();
      await queue.disconnect();
      await expect(
        f.transport.ring([{ bell: { namespace: NAMESPACE, queue: 'q' } }])
      ).resolves.toEqual([{ ok: true }]);
    });

    test('a queue given a store leaves the store open', async () => {
      const store = new PostgresStore({ db: f.fresh.db, namespace: NAMESPACE });
      const queue = f.queue('q', { store });
      await queue.add('a', 1);
      await queue.close();
      expect(await store.counts('q')).toMatchObject({ waiting: 1 });
    });
  });
});
