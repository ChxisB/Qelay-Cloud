import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { PayloadTooLargeError } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

describeDb('queue: groupCommit', () => {
  let f: SdkFixture;
  let enqueue: ReturnType<typeof spyOn<typeof f.store, 'enqueue'>>;
  const sizes = () => enqueue.mock.calls.map(([jobs]) => jobs.length);

  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
    enqueue = spyOn(f.store, 'enqueue');
  });
  afterEach(() => enqueue.mockRestore());

  const grouped = (maxJobs?: number, name = 'q') =>
    f.queue<number>(name, {
      store: f.store,
      groupCommit: maxJobs === undefined ? true : { maxJobs },
    });

  test('concurrent adds share one transaction and one ring call, and come back in order', async () => {
    const queue = grouped();
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, n) => queue.add('a', n)));
    expect(sizes()).toEqual([20]);
    expect(f.transport.batches).toEqual([20]);
    expect(jobs.map((job) => job.data)).toEqual(Array.from({ length: 20 }, (_, n) => n));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(20);
    expect(await queue.count()).toBe(20);
  });

  test('a caller that awaits each add is not delayed or batched', async () => {
    const queue = grouped();
    for (let n = 0; n < 3; n++) await queue.add('a', n);
    expect(sizes()).toEqual([1, 1, 1]);
  });

  test('maxJobs splits a burst into transactions of at most that size', async () => {
    const queue = grouped(5);
    await Promise.all(Array.from({ length: 12 }, (_, n) => queue.add('a', n)));
    expect(sizes()).toEqual([5, 5, 2]);
  });

  test('a bad option fails its own caller and the rest are stored', async () => {
    const queue = grouped();
    const results = await Promise.allSettled([
      queue.add('a', 1),
      queue.add('b', 2, { repeat: {} } as never),
      queue.add('c', 3),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(UnsupportedOptionError);
    expect(await queue.count()).toBe(2);
  });

  test('a job the store refuses on its own input fails alone, the others are stored together', async () => {
    const queue = f.queue<unknown>('q', { store: f.store, groupCommit: true });
    const huge = 'x'.repeat(1024 * 1024 + 1);
    const results = await Promise.allSettled([
      queue.add('a', 1),
      queue.add('big', huge),
      queue.add('c', 3),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(PayloadTooLargeError);
    expect(await queue.count()).toBe(2);
    expect(sizes()).toEqual([3, 2]);
  });

  test('a custom id held by a job of another queue is refused for that caller alone', async () => {
    await f.queue('one').add('a', 1, { jobId: 'shared' });
    const queue = grouped(undefined, 'two');
    const results = await Promise.allSettled([
      queue.add('a', 1),
      queue.add('a', 2, { jobId: 'shared' }),
      queue.add('a', 3),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(await queue.count()).toBe(2);
  });

  test('duplicates inside one group resolve to the one live job', async () => {
    const queue = grouped();
    const jobs = await Promise.all([
      queue.add('a', 1, { jobId: 'same' }),
      queue.add('a', 2, { jobId: 'same' }),
    ]);
    expect(jobs.map((job) => job.duplicated).sort()).toEqual([false, true]);
    expect(await queue.count()).toBe(1);
  });

  test('close stores the adds still waiting before it returns', async () => {
    const queue = grouped();
    let stored = false;
    const added = queue.add('a', 1).then(() => (stored = true));
    await queue.close();
    expect(stored).toBe(true);
    await added;
    expect(await f.store.counts('q')).toMatchObject({ waiting: 1 });
  });

  test('maxJobs must be an integer from 1 to 1000', () => {
    for (const maxJobs of [0, 1.5, 1001, Number.NaN]) {
      expect(() => grouped(maxJobs)).toThrow(UnsupportedOptionError);
    }
  });
});
