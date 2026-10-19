import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

describeDb('worker: groupComplete', () => {
  let f: SdkFixture;
  let completeMany: ReturnType<typeof spyOn<typeof f.store, 'completeMany'>>;
  const kit = workerKit(() => f);
  const sizes = () => completeMany.mock.calls.map(([items]) => items.length);

  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
    completeMany = spyOn(f.store, 'completeMany');
  });
  afterEach(async () => {
    await kit.closeAll();
    completeMany.mockRestore();
  });

  /** Eight jobs finish at the same moment: the first complete is stored alone, the rest share one write. */
  async function finishTogether(extra: Parameters<typeof kit.worker>[2]) {
    const queue = f.queue<number>('g', { store: f.store });
    let open = false;
    kit.worker<number, number>(
      'g',
      async (job) => {
        while (!open) await pause(5);
        return job.data * 2;
      },
      { store: f.store, concurrency: 8, ...extra }
    );
    const jobs = await Promise.all(Array.from({ length: 8 }, (_, n) => queue.add('x', n)));
    await until('eight running', async () => (await queue.getJobCounts()).active === 8);
    open = true;
    await until('eight completed', async () => (await queue.getJobCounts()).completed === 8);
    return jobs;
  }

  test('jobs that finish together share one completeMany, and each keeps its own result', async () => {
    const jobs = await finishTogether({ groupComplete: true });
    expect(sizes().reduce((a, b) => a + b, 0)).toBe(8);
    expect(Math.max(...sizes())).toBeGreaterThan(1);
    const results = await Promise.all(
      jobs.map((job) => f.queue('g', { store: f.store }).getJob(job.id))
    );
    expect(results.map((job) => job?.returnvalue)).toEqual(jobs.map((job) => job.data * 2));
  });

  test('without the option the store gets one complete per job', async () => {
    await finishTogether({});
    expect(completeMany).not.toHaveBeenCalled();
  });

  test('maxJobs is checked when the worker is made', () => {
    for (const maxJobs of [0, 1001, 1.5]) {
      expect(() =>
        kit.worker('g', () => {}, { store: f.store, groupComplete: { maxJobs } })
      ).toThrow(UnsupportedOptionError);
    }
  });
});
