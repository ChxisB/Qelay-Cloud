import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { Metrics, Tracing } from '../src';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { until, workerKit } from './workerSupport';

describeDb('worker and queue: metrics and tracing hooks', () => {
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

  function sink() {
    const counts: Array<[string, number, Record<string, string> | undefined]> = [];
    const observed: Array<[string, number]> = [];
    const metrics: Metrics = {
      increment: (name, value, tags) => void counts.push([name, value ?? 1, tags]),
      observe: (name, value) => void observed.push([name, value]),
    };
    return { counts, observed, metrics };
  }

  test('a claim that finds jobs and a claim that finds none are told apart, and each is timed', async () => {
    const { counts, observed, metrics } = sink();
    const queue = f.queue('m1');
    const done: string[] = [];
    const worker = kit.worker('m1', async () => 'ok', { metrics });
    worker.on('completed', () => done.push('x'));
    await queue.addBulk([
      { name: 'a', data: {} },
      { name: 'b', data: {} },
    ]);
    await until('both done', () => done.length === 2);
    const claims = counts.filter(([name]) => name === 'qcloud.worker.claims');
    expect(claims.some(([, , tags]) => tags?.result === 'jobs')).toBe(true);
    expect(
      counts.filter(([name]) => name === 'qcloud.worker.claimed').reduce((n, [, v]) => n + v, 0)
    ).toBe(2);
    expect(observed.filter(([name]) => name === 'qcloud.worker.claim_ms').length).toBe(
      claims.length
    );
    expect(observed.every(([, ms]) => ms >= 0)).toBe(true);
  });

  test('an add, a group commit and a complete are each timed', async () => {
    const { observed, metrics } = sink();
    const done: string[] = [];
    const worker = kit.worker('m3', async () => 'ok', { metrics });
    worker.on('completed', () => done.push('x'));
    const names = () => observed.map(([name]) => name);
    await f.queue('m3', { metrics }).add('a', {});
    await until('the job', () => done.length === 1);
    expect(names().filter((name) => name === 'qcloud.add.ms')).toHaveLength(1);
    expect(names().filter((name) => name === 'qcloud.worker.complete_ms')).toHaveLength(1);
    await Promise.all([
      f.queue('m3', { metrics, store: f.store, groupCommit: true }).add('b', {}),
      f.queue('m3', { metrics, store: f.store, groupCommit: true }).add('c', {}),
    ]);
    expect(names()).toContain('qcloud.add.group_size');
    expect(
      observed
        .filter(([name]) => name.endsWith('_ms') || name === 'qcloud.add.ms')
        .every(([, ms]) => ms >= 0)
    ).toBe(true);
  });

  test('a metrics sink without observe, or one that throws, does not stop the worker', async () => {
    const queue = f.queue('m2');
    const done: string[] = [];
    const worker = kit.worker('m2', async () => 'ok', {
      metrics: {
        increment() {
          throw new Error('sink down');
        },
        observe() {
          throw new Error('sink down');
        },
      },
    });
    worker.on('completed', () => done.push('x'));
    await queue.add('a', {});
    await until('the job', () => done.length === 1);
    const bare = kit.worker('m2b', async () => 'ok', { metrics: { increment() {} } });
    bare.on('completed', () => done.push('y'));
    await f.queue('m2b').add('b', {});
    await until('the second job', () => done.length === 2);
  });

  test('a tracer that throws before it starts the work does not fail an add or a job', async () => {
    const broken: Tracing = {
      produce() {
        throw new Error('tracer down');
      },
      consume() {
        throw new Error('tracer down');
      },
    };
    const done: string[] = [];
    const worker = kit.worker('t1', async () => 'ok', { tracing: broken });
    worker.on('completed', () => done.push('x'));
    await f.queue('t1', { tracing: broken }).add('a', {});
    await until('the job', () => done.length === 1);
  });

  test('the consume hook gets the stored traceparent, the attempt and the outcome', async () => {
    const seen: Array<{
      trace: string | undefined;
      attempt: number | undefined;
      jobName: string | undefined;
    }> = [];
    const outcomes: string[] = [];
    const tracing: Tracing = {
      produce: (_span, work) => work('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'),
      consume: (span, trace, work) => {
        seen.push({ trace, attempt: span.attempt, jobName: span.jobName });
        return work({
          event: (name) => void outcomes.push(name),
          fail: () => void outcomes.push('fail'),
        });
      },
    };
    const done: string[] = [];
    const worker = kit.worker(
      't2',
      async () => {
        if (seen.length === 1) throw new Error('boom');
        return 'ok';
      },
      { tracing }
    );
    worker.on('completed', () => done.push('x'));
    await f.queue('t2', { tracing }).add('retry-me', {}, { attempts: 2, backoff: 10 });
    await until('the retry', () => done.length === 1);
    expect(seen).toEqual([
      {
        trace: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        attempt: 0,
        jobName: 'retry-me',
      },
      {
        trace: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        attempt: 1,
        jobName: 'retry-me',
      },
    ]);
    expect(outcomes).toContain('fail');
  });

  test('a traceparent that is not one is refused at add, before anything is stored', async () => {
    const tracing: Tracing = {
      produce: (_span, work) => work('x'.repeat(300)),
      consume: (_s, _t, work) => work({ event() {}, fail() {} }),
    };
    await expect(f.queue('t3', { tracing }).add('a', {})).rejects.toThrow(/trace/);
    expect(await f.store.claim('t3', 'w', 1)).toEqual([]);
  });
});
