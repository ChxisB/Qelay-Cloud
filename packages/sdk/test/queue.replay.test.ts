import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

/**
 * The producer side of the two upstream examples, ported to the constructor of this package: what
 * an `examples/mqtt-bridge` gateway and an `examples/postgres-multibroker` client do with a `Queue`.
 */
describeDb('queue: upstream examples replayed', () => {
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

  interface SensorReading {
    topic: string;
    payload: unknown;
    receivedAt: number;
  }

  test('mqtt-bridge: a gateway enqueues readings with attempts 5 and closes the queue', async () => {
    const queue = f.queue<SensorReading>('telemetry');
    const errors: unknown[] = [];
    const readings = ['a1', 'a2', 'a3'].map((sensor) =>
      queue
        .add(
          'reading',
          { topic: `sensors/${sensor}`, payload: { value: 21.5 }, receivedAt: Date.now() },
          { attempts: 5 }
        )
        .catch((error: unknown) => void errors.push(error))
    );
    await Promise.all(readings);
    expect(errors).toEqual([]);
    expect(await queue.getWaitingCount()).toBe(3);
    const [job] = await queue.getWaiting();
    expect(job).toMatchObject({ name: 'reading', opts: { attempts: 5 } });
    expect(job!.data.topic).toMatch(/^sensors\//);
    expect(f.transport.buffered('telemetry').ready).toBe(3);
    await queue.close();
  });

  test('mqtt-bridge: a broker outage does not make the gateway lose a reading', async () => {
    const queue = f.queue<SensorReading>('telemetry');
    f.transport.throwNext(3);
    for (let n = 0; n < 3; n += 1) {
      await queue.add(
        'reading',
        { topic: `t${n}`, payload: n, receivedAt: Date.now() },
        { attempts: 5 }
      );
    }
    expect(await queue.getWaitingCount()).toBe(3);
    expect(f.transport.buffered('telemetry').ready).toBe(0);
  });

  test("multibroker: two queue objects on one queue see each other's jobs and state", async () => {
    const primary = f.queue('payments');
    const peer = f.queue('payments');
    const jobs = await primary.addBulk([
      { name: 'charge', data: { amount: 1 } },
      { name: 'charge', data: { amount: 2 } },
    ]);
    expect(await Promise.all(jobs.map((job) => peer.getJobState(job.id)))).toEqual([
      'waiting',
      'waiting',
    ]);
    await primary.pause();
    expect((await peer.getJobCountsAsync()).paused).toBe(2);
    expect(await peer.isPaused()).toBe(true);
    await peer.resume();
    expect((await primary.getJobCountsAsync()).waiting).toBe(2);
  });

  test('multibroker: the same custom id added by both at once is one job', async () => {
    const primary = f.queue('payments');
    const peer = f.queue('payments');
    const [a, b] = await Promise.all([
      primary.add('charge', { amount: 49 }, { jobId: 'invoice-7' }),
      peer.add('charge', { amount: 49 }, { jobId: 'invoice-7' }),
    ]);
    expect(a.id).toBe('invoice-7');
    expect([a.duplicated, b.duplicated].sort()).toEqual([false, true]);
    expect(await primary.count()).toBe(1);
  });

  test('multibroker: durable, which a Qelay client could pass, is refused with a reason', async () => {
    const queue = f.queue('payments');
    const refused = queue.add('charge', { amount: 49 }, { durable: true } as never);
    await expect(refused).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(refused).rejects.toThrow(/durable/);
  });

  test('multibroker: a queue with a global concurrency and rate limit reports them to a peer', async () => {
    const primary = f.queue('payments');
    const peer = f.queue('payments');
    await primary.setGlobalConcurrency(2);
    await primary.setGlobalRateLimit(1, 5_000);
    expect(await peer.getGlobalConcurrency()).toBe(2);
    expect(await peer.getGlobalRateLimit()).toEqual({ max: 1, duration: 5_000 });
  });
});
