import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Delivery, SubscribeOptions, Subscription } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { FlakyTransport, NAMESPACE, openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

/** A transport that ignores `capacity`, as a broker that pushes does. */
class OverDelivering extends FlakyTransport {
  override subscribe(
    queue: string,
    handler: (delivery: Delivery) => Promise<void>,
    options: SubscribeOptions
  ): Subscription {
    return super.subscribe(queue, handler, { ...options, capacity: () => 100 });
  }
}

/** Runs `n` jobs that each hold their slot until `release()`, and reports how many ran at once. */
function gate() {
  let open = false;
  let running = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    get running() {
      return running;
    },
    release: () => void (open = true),
    async hold(): Promise<void> {
      running += 1;
      peak = Math.max(peak, running);
      try {
        while (!open) await pause(5);
      } finally {
        running -= 1;
      }
    },
  };
}

describeDb('worker: slots, bells and registration', () => {
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

  test('twenty jobs run three at a time and all complete', async () => {
    const queue = f.queue('slots');
    const slots = gate();
    kit.worker('slots', () => slots.hold(), { concurrency: 3 });
    await Promise.all(Array.from({ length: 20 }, (_, n) => queue.add('x', { n })));
    await until('three running', () => slots.running === 3);
    await pause(100);
    expect(slots.peak).toBe(3);
    slots.release();
    await until('all complete', async () => (await queue.getJobCounts()).completed === 20, 10_000);
    expect(slots.peak).toBe(3);
  });

  test('a transport that over-delivers is nacked: the slots are never exceeded and every job still runs', async () => {
    const transport = new OverDelivering();
    const over = f.queue('over', { transport });
    const slots = gate();
    kit.worker('over', () => slots.hold(), { concurrency: 2, transport });
    await Promise.all(Array.from({ length: 10 }, (_, n) => over.add('x', { n })));
    await until('two running', () => slots.running === 2);
    await pause(400);
    expect(slots.peak).toBe(2);
    slots.release();
    await until('all complete', async () => (await over.getJobCounts()).completed === 10, 10_000);
    expect(slots.peak).toBe(2);
  });

  test('a bell is a nudge, not a job: one bell takes every job the free slots allow, and a lost bell costs nothing', async () => {
    const queue = f.queue('nudge');
    await queue.add('x', 1, { jobId: 'a' });
    await queue.add('x', 2, { jobId: 'b' });
    await queue.add('x', 3, { jobId: 'c' });
    f.transport.dropNext(2);
    const seen: string[] = [];
    kit.worker('nudge', (job) => void seen.push(job.id), { concurrency: 3, autorun: false }).run();
    await until('three completions', async () => (await queue.getJobCounts()).completed === 3);
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  test('pause stops taking jobs, the running ones continue, and resume takes the rest', async () => {
    const queue = f.queue('pause');
    const slots = gate();
    const worker = kit.worker('pause', () => slots.hold(), { concurrency: 1 });
    await queue.add('x', 1, { jobId: 'a' });
    await until('first running', () => slots.running === 1);
    worker.pause();
    expect(worker.isPaused()).toBe(true);
    await queue.add('x', 2, { jobId: 'b' });
    slots.release();
    await until('first completed', async () => (await queue.getJobState('a')) === 'completed');
    await pause(200);
    expect(await queue.getJobState('b')).toBe('waiting');
    worker.resume();
    await until('second completed', async () => (await queue.getJobState('b')) === 'completed');
  });

  test('drained is emitted once the queue is empty and the worker idle, and again after new work', async () => {
    const queue = f.queue('drain');
    let drained = 0;
    const worker = kit.worker('drain', () => {}, { drainedAfterMs: 50 });
    worker.on('drained', () => (drained += 1));
    await queue.add('x', 1);
    await until('first drained', () => drained === 1);
    await pause(200);
    expect(drained).toBe(1);
    await queue.add('x', 2);
    await until('second drained', () => drained === 2);
  });

  test('the worker is a row in qcloud_workers while it runs, with its counters, and the row is gone after close', async () => {
    const queue = f.queue('row');
    const worker = kit.worker('row', () => 'ok', {
      concurrency: 4,
      heartbeatInterval: 30,
      workerName: 'named',
    });
    await worker.waitUntilReady();
    await queue.add('x', 1);
    const row = await until('the row with a completed job', async () => {
      const rows = await f.store.workers.list();
      return rows.find((r) => r.id === worker.id && r.processed === 1);
    });
    expect(row).toMatchObject({ name: 'named', queues: ['row'], concurrency: 4, activeJobs: 0 });
    await worker.close();
    expect((await f.store.workers.list()).some((r) => r.id === worker.id)).toBe(false);
  });

  test("the worker's group limits reach the claim: one job of a group at a time, the rest wait", async () => {
    const queue = f.queue('groups');
    const slots = gate();
    kit.worker('groups', () => slots.hold(), { concurrency: 5, group: { concurrency: 1 } });
    await Promise.all(
      Array.from({ length: 6 }, (_, n) => queue.add('x', n, { group: { id: 'tenant' } }))
    );
    await until('the first job to run', () => slots.running === 1);
    // While the first job holds its group, every bell finds the group full, however often it is
    // delivered or rechecked: nothing else runs and the five stay waiting.
    await pause(400);
    expect(slots.peak).toBe(1);
    expect(await queue.getJobCounts()).toMatchObject({ active: 1, waiting: 5, completed: 0 });
    slots.release();
    // A job that ends rings nothing for its group: the rest run as bells or the tick return, which
    // the loop below plays (DESIGN.md, "Doorbell edge cases").
    const bell = { namespace: NAMESPACE, queue: 'groups' };
    const tick = setInterval(() => void f.transport.ring([{ bell }]), 30);
    try {
      await until(
        'six completions',
        async () => (await queue.getJobCounts()).completed === 6,
        10_000
      );
    } finally {
      clearInterval(tick);
    }
    expect(slots.peak).toBe(1);
  });

  test('a borrowed store must have the worker’s lease length: a mismatch is refused, a match is used', async () => {
    const store = new PostgresStore({ db: f.fresh.db, namespace: 'test', leaseMs: 1234 });
    expect(() =>
      kit.worker('lease', () => {}, { store, lockDuration: 999, autorun: false })
    ).toThrow(UnsupportedOptionError);
    const worker = kit.worker('lease', () => {}, { store, lockDuration: 1234, autorun: false });
    expect(worker.concurrency).toBe(1);
  });
});
