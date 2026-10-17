import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture, rungOf } from './support';

describeDb('queue: add', () => {
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

  test('add stores the job, rings its bell and marks it rung', async () => {
    const queue = f.queue<{ n: number }>('telemetry');
    const job = await queue.add('reading', { n: 1 }, { attempts: 5 });
    expect(job).toMatchObject({
      name: 'reading',
      queueName: 'telemetry',
      data: { n: 1 },
      attemptsMade: 0,
      progress: 0,
      duplicated: false,
    });
    expect(job.opts.attempts).toBe(5);
    expect(await queue.getJobState(job.id)).toBe('waiting');
    expect(f.transport.buffered('telemetry').ready).toBe(1);
    expect(await rungOf(f, [job.id])).toEqual({ [job.id]: true });
  });

  test('defaultJobOptions sit under the options of each call', async () => {
    const queue = f.queue('q', { defaultJobOptions: { attempts: 3, priority: 2 } });
    const plain = await queue.add('a', 1);
    const own = await queue.add('b', 2, { attempts: 7 });
    expect(plain.opts).toMatchObject({ attempts: 3, priority: 2 });
    expect(own.opts).toMatchObject({ attempts: 7, priority: 2 });
    expect((await queue.getJob(own.id))!.priority).toBe(2);
  });

  test('a delayed job is stored delayed and rung with its delay', async () => {
    const queue = f.queue();
    const job = await queue.add('later', 1, { delay: 60_000 });
    expect(await queue.getJobState(job.id)).toBe('delayed');
    expect(f.transport.buffered('q')).toMatchObject({ ready: 0, delayed: 1 });
  });

  test('a custom id is the job id, and adding it again returns the live job as a duplicate', async () => {
    const queue = f.queue();
    const first = await queue.add('a', 1, { jobId: 'order-1' });
    const again = await queue.add('a', 2, { jobId: 'order-1' });
    expect(first.id).toBe('order-1');
    expect(again).toMatchObject({ id: 'order-1', duplicated: true, data: 1 });
    expect(await queue.count()).toBe(1);
  });

  test('a deduplication key returns the live job and leaves one job', async () => {
    const queue = f.queue();
    const first = await queue.add('a', 1, { deduplication: { id: 'k' } });
    const again = await queue.add('a', 2, { deduplication: { id: 'k' } });
    expect(again).toMatchObject({ id: first.id, duplicated: true });
    expect(await queue.count()).toBe(1);
  });

  test('concurrent adds of one custom id from separate queue objects create one job', async () => {
    const queues = Array.from({ length: 6 }, () => f.queue());
    const jobs = await Promise.all(queues.map((queue, n) => queue.add('a', n, { jobId: 'race' })));
    expect(jobs.filter((job) => !job.duplicated)).toHaveLength(1);
    expect(new Set(jobs.map((job) => job.id))).toEqual(new Set(['race']));
    expect(await queues[0]!.count()).toBe(1);
    expect(f.transport.buffered('q').ready).toBe(1);
  });

  test('a custom id held by a live job of another queue is refused, not handed back', async () => {
    await f.queue('one').add('a', 1, { jobId: 'shared' });
    const other = f.queue('two');
    const refused = other.add('a', 2, { jobId: 'shared' });
    await expect(refused).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(refused).rejects.toThrow(/queue "one"/);
    expect(await other.getJob('shared')).toBeNull();
    expect(await f.queue('one').getJob('shared')).not.toBeNull();
  });

  test('addBulk adds in order, rings each job once and returns the jobs in order', async () => {
    const queue = f.queue();
    const jobs = await queue.addBulk([
      { name: 'a', data: 1 },
      { name: 'b', data: 2, opts: { priority: 4 } },
      { name: 'c', data: 3, opts: { delay: 30_000 } },
    ]);
    expect(jobs.map((job) => job.name)).toEqual(['a', 'b', 'c']);
    expect(jobs.map((job) => job.priority)).toEqual([0, 4, 0]);
    expect(f.transport.buffered('q')).toMatchObject({ ready: 2, delayed: 1 });
  });

  test('addBulk of nothing resolves to nothing and touches nothing', async () => {
    expect(await f.queue().addBulk([])).toEqual([]);
  });

  test('one bad option rejects the whole addBulk before anything is stored', async () => {
    const queue = f.queue();
    await expect(
      queue.addBulk([
        { name: 'ok', data: 1 },
        { name: 'bad', data: 2, opts: { repeat: { every: 10 } } as never },
      ])
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    expect(await queue.count()).toBe(0);
  });

  test('options the store does not support are refused with UnsupportedOptionError', async () => {
    const queue = f.queue();
    for (const opts of [
      { repeat: {} },
      { debounce: {} },
      { parent: {} },
      { keepLogs: 3 },
      { timestamp: 1 },
    ]) {
      await expect(queue.add('a', 1, opts as never)).rejects.toBeInstanceOf(UnsupportedOptionError);
    }
    expect(await queue.count()).toBe(0);
  });

  test('a non-string job name is refused', async () => {
    await expect(f.queue().add(7 as never, 1)).rejects.toBeInstanceOf(UnsupportedOptionError);
  });

  test('a delay beyond a year is refused, a negative one is spent as none', async () => {
    const queue = f.queue();
    await expect(queue.add('a', 1, { delay: 400 * 86_400_000 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    expect(await queue.getJobState((await queue.add('a', 1, { delay: -5 })).id)).toBe('waiting');
  });
});
