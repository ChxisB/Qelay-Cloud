import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { FlakyTransport, NAMESPACE, openFixture, recorded, resetFixture, rungOf } from './support';

describeDb('queue: ringing after the commit', () => {
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

  test('a ring call that throws does not fail add: the job is stored unrung and the failure is logged and counted', async () => {
    const seen = recorded();
    const queue = f.queue('q', { logger: seen.logger, metrics: seen.metrics });
    f.transport.throwNext();
    const job = await queue.add('a', 1);
    expect(await queue.getJobState(job.id)).toBe('waiting');
    expect(await rungOf(f, [job.id])).toEqual({ [job.id]: false });
    expect(f.transport.buffered('q').ready).toBe(0);
    expect(seen.warnings).toContain('ring failed');
    expect(seen.counts.get('qcloud.ring.failed')).toBe(1);
    expect(seen.counts.get('qcloud.ring.rung')).toBeUndefined();
  });

  test('a half-failed batch marks exactly the bells the broker took', async () => {
    const seen = recorded();
    const queue = f.queue('q', { logger: seen.logger, metrics: seen.metrics });
    f.transport.failWhere((item) => item.bell.jobId === 'j1', 'rejected');
    f.transport.failWhere((item) => item.bell.jobId === 'j3', 'unreachable');
    const jobs = await queue.addBulk(
      [0, 1, 2, 3].map((n) => ({ name: 'n', data: n, opts: { jobId: `j${n}` } }))
    );
    expect(jobs.map((job) => job.id)).toEqual(['j0', 'j1', 'j2', 'j3']);
    expect(await rungOf(f, ['j0', 'j1', 'j2', 'j3'])).toEqual({
      j0: true,
      j1: false,
      j2: true,
      j3: false,
    });
    expect(f.transport.buffered('q').ready).toBe(2);
    expect(seen.counts.get('qcloud.ring.failed')).toBe(2);
    expect(seen.counts.get('qcloud.ring.rung')).toBe(2);
  });

  test('a delay beyond what the transport can hold is not an error: the tick rings it nearer its time', async () => {
    const seen = recorded();
    const queue = f.queue('q', { logger: seen.logger, metrics: seen.metrics });
    f.transport.refuseNext('delay-too-long');
    const job = await queue.add('a', 1, { delay: 5_000 });
    expect(await queue.getJobState(job.id)).toBe('delayed');
    expect(await rungOf(f, [job.id])).toEqual({ [job.id]: false });
    expect(seen.counts.get('qcloud.ring.deferred')).toBe(1);
    expect(seen.counts.get('qcloud.ring.failed')).toBeUndefined();
    expect(seen.warnings).toEqual([]);
  });

  test('a transport with a short window gets no ring for a job beyond it', async () => {
    const transport = new FlakyTransport({ capabilities: { maxDeliverDelayMs: 1_000 } });
    const queue = f.queue('q', { transport });
    const near = await queue.add('a', 1, { delay: 500 });
    const far = await queue.add('a', 1, { delay: 60_000 });
    expect(transport.buffered('q')).toMatchObject({ ready: 0, delayed: 1 });
    expect(await rungOf(f, [near.id, far.id])).toEqual({ [near.id]: true, [far.id]: false });
  });

  test('a batch is split by the transport maxRingBatch', async () => {
    const transport = new FlakyTransport({ capabilities: { maxRingBatch: 2 } });
    const queue = f.queue('q', { transport });
    await queue.addBulk(Array.from({ length: 5 }, (_, n) => ({ name: 'n', data: n })));
    expect(transport.batches).toEqual([2, 2, 1]);
    expect(transport.buffered('q').ready).toBe(5);
  });

  test('a call that throws in one chunk leaves the other chunks rung', async () => {
    const transport = new FlakyTransport({ capabilities: { maxRingBatch: 2 } });
    const queue = f.queue('q', { transport });
    transport.throwNext();
    const jobs = await queue.addBulk(Array.from({ length: 4 }, (_, n) => ({ name: 'n', data: n })));
    expect(transport.buffered('q').ready).toBe(2);
    const rung = await rungOf(
      f,
      jobs.map((job) => job.id)
    );
    expect(Object.values(rung).filter(Boolean)).toHaveLength(2);
  });

  test('a store that cannot record the rung bells does not fail add', async () => {
    const seen = recorded();
    const store = new PostgresStore({ db: f.fresh.db, namespace: NAMESPACE });
    store.markRung = async () => {
      throw new Error('database went away');
    };
    const queue = f.queue('q', { store, logger: seen.logger, metrics: seen.metrics });
    const job = await queue.add('a', 1);
    expect(await queue.getJobState(job.id)).toBe('waiting');
    expect(seen.warnings).toContain('could not record rung bells');
    expect(seen.counts.get('qcloud.ring.mark_failed')).toBe(1);
  });

  test('a broken logger or metrics sink does not fail add', async () => {
    const queue = f.queue('q', {
      logger: {
        warn: () => {
          throw new Error('logger');
        },
      },
      metrics: {
        increment: () => {
          throw new Error('metrics');
        },
      },
    });
    f.transport.throwNext();
    const job = await queue.add('a', 1);
    expect(await queue.getJobState(job.id)).toBe('waiting');
  });

  test('a bell is never rung for a duplicate', async () => {
    const queue = f.queue();
    await queue.add('a', 1, { jobId: 'x' });
    await queue.add('a', 1, { jobId: 'x' });
    expect(f.transport.batches).toEqual([1]);
  });
});
