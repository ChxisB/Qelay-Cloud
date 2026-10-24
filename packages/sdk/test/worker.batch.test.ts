import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { UnrecoverableError } from '../src';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

describeDb('worker: batch processing', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });
  afterEach(async () => {
    await kit.closeAll();
  });

  const addAll = (queue: ReturnType<typeof f.queue<number>>, n: number, opts = {}) =>
    Promise.all(Array.from({ length: n }, (_, i) => queue.add('x', i, opts)));
  const counts = (queue: ReturnType<typeof f.queue<number>>) => queue.getJobCounts();

  test('25 waiting jobs and size 10 make three calls, 10, 10 and 5, and the last one waits for maxWaitMs', async () => {
    const queue = f.queue<number>('b');
    await addAll(queue, 25);
    const calls: Array<{ size: number; at: number }> = [];
    kit
      .batchWorker<number>(
        'b',
        (jobs) => void calls.push({ size: jobs.length, at: performance.now() }),
        { size: 10, maxWaitMs: 300 },
        { autorun: false }
      )
      .run();
    await until('all completed', async () => (await counts(queue)).completed === 25);
    expect(calls.map((call) => call.size)).toEqual([10, 10, 5]);
    expect(calls[1]!.at - calls[0]!.at).toBeLessThan(250);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(250);
  });

  test('a mixed result completes some jobs and fails others, each with its own error, result and attempts', async () => {
    const queue = f.queue<number>('mixed');
    const jobs = await Promise.all([0, 1, 2, 3].map((n) => queue.add('x', n, { attempts: 1 })));
    kit
      .batchWorker<number, string>(
        'mixed',
        (batch) =>
          batch.map((job) =>
            job.data === 1
              ? new Error('one is bad')
              : job.data === 3
                ? new UnrecoverableError('three is hopeless')
                : `ok ${job.data}`
          ),
        { size: 4 },
        { autorun: false }
      )
      .run();
    await until('settled', async () => {
      const c = await counts(queue);
      return c.completed + c.failed === 4;
    });
    const read = await Promise.all(jobs.map((job) => queue.getJob(job.id)));
    expect(read.map((job) => job?.returnvalue)).toEqual(['ok 0', undefined, 'ok 2', undefined]);
    expect(read.map((job) => job?.failedReason)).toEqual([
      undefined,
      'one is bad',
      undefined,
      'three is hopeless',
    ]);
  });

  test('a throw fails every job by its own attempts and backoff, and the retry is a new batch', async () => {
    const queue = f.queue<number>('throws');
    await addAll(queue, 3, { attempts: 3, backoff: { type: 'fixed', delay: 50 } });
    const seen: number[][] = [];
    kit
      .batchWorker<number>(
        'throws',
        (jobs) => {
          seen.push(jobs.map((job) => job.attemptsMade));
          if (seen.length === 1) throw new Error('the whole batch failed');
        },
        { size: 3, maxWaitMs: 200 },
        { autorun: false }
      )
      .run();
    await until('retried and completed', async () => (await counts(queue)).completed === 3);
    // The retries fall due a few milliseconds apart and are rung by the tick, so they may reach the handler as one batch
    // or as two: what holds is that none repeats attempt 0 and all three come back.
    expect(seen[0]).toEqual([0, 0, 0]);
    expect(seen.slice(1).flat()).toEqual([1, 1, 1]);
  });

  test('a result that does not line up with the jobs fails them all and completes none', async () => {
    const queue = f.queue<number>('shape');
    const jobs = await addAll(queue, 3, { attempts: 1 });
    kit.batchWorker<number, number>('shape', () => [1, 2], { size: 3 }, { autorun: false }).run();
    await until('failed', async () => (await counts(queue)).failed === 3);
    const job = await queue.getJob(jobs[0]!.id);
    expect(job?.failedReason).toContain('one entry per job');
    expect((await counts(queue)).completed).toBe(0);
  });

  test('concurrency counts batches: no more handler calls at once than that, and the free ones are used', async () => {
    const queue = f.queue<number>('par');
    await addAll(queue, 12);
    let inFlight = 0;
    let peak = 0;
    kit
      .batchWorker<number>(
        'par',
        async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await pause(60);
          inFlight -= 1;
        },
        { size: 3, maxWaitMs: 50 },
        { concurrency: 2, autorun: false }
      )
      .run();
    await until('all completed', async () => (await counts(queue)).completed === 12);
    expect(peak).toBe(2);
  });

  test('the completes of a batch share one transaction, and groupComplete: false turns that off', async () => {
    const completeMany = spyOn(f.store, 'completeMany');
    try {
      for (const groupComplete of [undefined, false]) {
        completeMany.mockClear();
        const queue = f.queue<number>(`group-${groupComplete}`, { store: f.store });
        await addAll(queue, 6);
        kit
          .batchWorker<number>(
            queue.name,
            () => {},
            { size: 6 },
            {
              store: f.store,
              autorun: false,
              ...(groupComplete === undefined ? {} : { groupComplete }),
            }
          )
          .run();
        await until('completed', async () => (await counts(queue)).completed === 6);
        expect(completeMany.mock.calls.length > 0).toBe(groupComplete === undefined);
      }
    } finally {
      completeMany.mockRestore();
    }
  });

  test('close lets a short batch run inside the grace instead of waiting out maxWaitMs', async () => {
    const queue = f.queue<number>('closing');
    await addAll(queue, 3);
    const sizes: number[] = [];
    const worker = kit.batchWorker<number>(
      'closing',
      (jobs) => void sizes.push(jobs.length),
      { size: 10, maxWaitMs: 60_000 },
      { autorun: false }
    );
    worker.run();
    await until('three claimed', () => worker.activeJobs === 3);
    await worker.close({ graceMs: 5000 });
    expect(sizes).toEqual([3]);
    expect((await counts(queue)).completed).toBe(3);
  });

  test('a worker that closes out of grace aborts the handler and releases every job without a failure', async () => {
    const queue = f.queue<number>('abort');
    await addAll(queue, 3, { attempts: 1 });
    let aborted = false;
    const worker = kit.batchWorker<number>(
      'abort',
      (_jobs, { signal }) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('stopped'));
            },
            { once: true }
          )
        ),
      { size: 3 },
      { autorun: false }
    );
    worker.run();
    await until('three claimed', () => worker.activeJobs === 3);
    await pause(50);
    await worker.close({ graceMs: 0 });
    expect(aborted).toBe(true);
    const c = await counts(queue);
    expect([c.failed, c.completed, c.active]).toEqual([0, 0, 0]);
    expect(c.waiting).toBe(3);
  });

  test('the options are checked when the worker is made', () => {
    const make = (batch: unknown) =>
      kit.batchWorker('v', () => {}, batch as { size: number }, { autorun: false });
    for (const batch of [
      { size: 0 },
      { size: 1001 },
      { size: 1.5 },
      { size: 2, maxWaitMs: -1 },
      { size: 2, maxWaitMs: 60_001 },
      { size: 2, wait: 5 },
      { maxWaitMs: 5 },
      5,
    ]) {
      expect(() => make(batch)).toThrow(UnsupportedOptionError);
    }
    expect(() => make({ size: 1000, maxWaitMs: 60_000 })).not.toThrow();
  });

  test('without batch the worker runs one job per call, as before', async () => {
    const queue = f.queue<number>('plain');
    await addAll(queue, 3);
    const seen: number[] = [];
    kit.worker<number>('plain', (job) => void seen.push(job.data), { autorun: false }).run();
    await until('all completed', async () => (await counts(queue)).completed === 3);
    expect(seen.sort()).toEqual([0, 1, 2]);
  });
});
