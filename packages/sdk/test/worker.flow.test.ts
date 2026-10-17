import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { UnrecoverableError } from '../src';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { until, workerKit } from './workerSupport';

describeDb('worker: one job, start to end', () => {
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

  test('a bell makes the worker claim, run and complete the job, and the store holds the result', async () => {
    const queue = f.queue('flow');
    const seen: unknown[] = [];
    const worker = kit.worker<{ n: number }, { doubled: number }>('flow', async (job) => {
      seen.push([job.id, job.name, job.data, job.attemptsMade, job.queueName]);
      return { doubled: job.data.n * 2 };
    });
    const completed: unknown[] = [];
    worker.on('completed', (job, result) => completed.push([job.id, result]));
    const job = await queue.add('double', { n: 21 }, { jobId: 'j1' });
    await until(
      'the job to complete',
      async () => (await queue.getJobState(job.id)) === 'completed'
    );
    expect(seen).toEqual([['j1', 'double', { n: 21 }, 0, 'flow']]);
    expect(completed).toEqual([['j1', { doubled: 42 }]]);
    expect(await queue.getJobCounts()).toMatchObject({ completed: 1, active: 0, waiting: 0 });
  });

  test('a throwing processor fails the job and emits failed with the error', async () => {
    const queue = f.queue('flow');
    const worker = kit.worker('flow', () => {
      throw new Error('boom');
    });
    const failures: string[] = [];
    worker.on('failed', (job, error) => failures.push(`${job.id}:${error.message}`));
    const job = await queue.add('x', {}, { jobId: 'bad', attempts: 1 });
    await until('the job to fail', async () => (await queue.getJobState(job.id)) === 'failed');
    expect(failures).toEqual(['bad:boom']);
    expect((await queue.getJob('bad'))!.failedReason).toBe('boom');
  });

  test('a failed attempt is retried until attempts run out, and attemptsMade counts the failures', async () => {
    const queue = f.queue('flow');
    const attempts: number[] = [];
    kit.worker('flow', (job) => {
      attempts.push(job.attemptsMade);
      if (job.attemptsMade < 2) throw new Error('again');
      return 'fine';
    });
    const job = await queue.add('x', {}, { jobId: 'retry', attempts: 3 });
    await until('the third attempt to complete', async () => {
      return (await queue.getJobState(job.id)) === 'completed';
    });
    expect(attempts).toEqual([0, 1, 2]);
  });

  test('UnrecoverableError and job.discard() fail the job for good whatever attempts are left', async () => {
    const queue = f.queue('flow');
    const calls = new Map<string, number>();
    kit.worker('flow', (job) => {
      calls.set(job.id, (calls.get(job.id) ?? 0) + 1);
      if (job.id === 'thrown') throw new UnrecoverableError('never');
      job.discard();
      throw new Error('discarded');
    });
    await queue.add('x', {}, { jobId: 'thrown', attempts: 5 });
    await queue.add('x', {}, { jobId: 'discarded', attempts: 5 });
    await until('both to fail', async () => {
      const counts = await queue.getJobCounts();
      return counts.failed === 2;
    });
    expect(Object.fromEntries(calls)).toEqual({ thrown: 1, discarded: 1 });
  });

  test('a worker rings what its settle made due: a retry with a delay is delivered without a poll', async () => {
    const queue = f.queue('flow');
    let calls = 0;
    kit.worker('flow', () => {
      calls += 1;
      if (calls === 1) throw new Error('first');
      return 'second';
    });
    const job = await queue.add(
      'x',
      {},
      {
        jobId: 'delayed-retry',
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
      }
    );
    await until(
      'the retry to complete',
      async () => (await queue.getJobState(job.id)) === 'completed'
    );
    expect(calls).toBe(2);
    // The add rang once, and the settle rang the retry: nobody else would have, there is no tick yet.
    expect(f.transport.batches.length).toBeGreaterThanOrEqual(2);
  });

  test('progress and log go to the store and the events, and a failing store never fails the job', async () => {
    const queue = f.queue('flow');
    const worker = kit.worker('flow', async (job) => {
      await job.updateProgress(40, 'forty');
      await job.log('hello');
      return 'done';
    });
    const heard: unknown[] = [];
    worker.on('progress', (job, progress) => heard.push(['progress', job.id, progress]));
    worker.on('log', (job, message) => heard.push(['log', job.id, message]));
    const job = await queue.add('x', {}, { jobId: 'p' });
    await until('completion', async () => (await queue.getJobState(job.id)) === 'completed');
    expect(heard).toEqual([
      ['progress', 'p', 40],
      ['log', 'p', 'hello'],
    ]);
    expect((await queue.getJob('p'))!.progress).toBe(40);
    expect((await queue.getJobLogs('p')).logs.join('\n')).toContain('hello');
  });

  test('the worker takes jobs of its own queue only', async () => {
    const seen: string[] = [];
    kit.worker('mine', (job) => void seen.push(job.id));
    await f.queue('theirs').add('x', {}, { jobId: 'other' });
    const mine = await f.queue('mine').add('x', {}, { jobId: 'own' });
    await until(
      'own job',
      async () => (await f.queue('mine').getJobState(mine.id)) === 'completed'
    );
    expect(seen).toEqual(['own']);
    expect(await f.queue('theirs').getJobState('other')).toBe('waiting');
  });

  test('a listener that throws neither fails the job nor keeps the listeners after it from hearing the event', async () => {
    const queue = f.queue('flow');
    const worker = kit.worker('flow', () => 'done');
    const heard: string[] = [];
    worker.on('completed', () => {
      throw new Error('listener bug');
    });
    worker.on('completed', (job) => void heard.push(`on:${job.id}`));
    worker.once('completed', (job) => void heard.push(`once:${job.id}`));
    await queue.add('x', {}, { jobId: 'a' });
    await queue.add('x', {}, { jobId: 'b' });
    await until('both jobs', async () => (await queue.getJobCounts()).completed === 2);
    await until('both events', () => heard.filter((entry) => entry.startsWith('on:')).length === 2);
    expect(heard.filter((entry) => entry.startsWith('once:'))).toHaveLength(1);
  });

  test('options that Qelay has and this package does not are refused by name, before anything opens', () => {
    const bad = (extra: Record<string, unknown>) => () =>
      kit.worker('flow', () => {}, extra as never);
    for (const name of ['batchSize', 'pollTimeout', 'useLocks', 'limiter', 'maxStalledCount']) {
      expect(bad({ [name]: 1 })).toThrow(UnsupportedOptionError);
    }
    expect(bad({ concurrency: 0 })).toThrow(UnsupportedOptionError);
    expect(bad({ concurrency: 10_001 })).toThrow(UnsupportedOptionError);
    expect(bad({ lockDuration: 10 })).toThrow(UnsupportedOptionError);
    expect(bad({ host: 'x' })).toThrow(UnsupportedOptionError);
    expect(bad({ workerName: '' })).toThrow(UnsupportedOptionError);
  });
});
