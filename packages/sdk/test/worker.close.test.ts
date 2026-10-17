import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { startFaultProxy } from '../../store-postgres/test/fault';
import type { ProcessorContext } from '../src';
import type { SdkFixture } from './support';
import { FlakyTransport } from './support';
import { openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

describeDb('worker: close', () => {
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

  /** A processor that holds its job until the signal aborts, then throws, as a well-behaved one does. */
  const untilAborted =
    (started: string[]) =>
    (job: { id: string }, { signal }: ProcessorContext) => {
      started.push(job.id);
      return new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      });
    };

  async function row(id: string) {
    const [found] = await f.fresh.sql<
      Array<{ state: string; lease_owner: string | null; attempts: number }>
    >`SELECT state, lease_owner, attempts FROM qcloud_jobs WHERE id = ${id}`;
    return found!;
  }

  test('close releases the running jobs without counting a failure and leaves none active', async () => {
    const queue = f.queue('close');
    const started: string[] = [];
    const worker = kit.worker('close', untilAborted(started), { concurrency: 2 });
    const failures: string[] = [];
    worker.on('failed', (job) => failures.push(job.id));
    await queue.add('x', {}, { jobId: 'a', attempts: 1 });
    await queue.add('x', {}, { jobId: 'b', attempts: 1 });
    await until('both running', () => started.length === 2);
    await worker.close({ graceMs: 50 });
    expect(worker.isClosed()).toBe(true);
    expect(failures).toEqual([]);
    for (const id of ['a', 'b']) {
      expect(await row(id)).toMatchObject({ state: 'waiting', lease_owner: null, attempts: 0 });
    }
    expect((await queue.getJobCounts()).active).toBe(0);
  });

  test('a job that finishes within the grace completes instead of being released', async () => {
    const queue = f.queue('close');
    let running = false;
    const worker = kit.worker('close', async () => {
      running = true;
      await pause(150);
      return 'finished';
    });
    await queue.add('x', {}, { jobId: 'a' });
    await until('running', () => running);
    await worker.close({ graceMs: 3000 });
    expect(await queue.getJobState('a')).toBe('completed');
  });

  test('a processor that ignores the signal is released when the grace and the wind-down run out, and its late result is dropped', async () => {
    const queue = f.queue('close');
    let finish: (value: string) => void = () => {};
    let started = false;
    const worker = kit.worker(
      'close',
      () => {
        started = true;
        return new Promise<string>((resolve) => (finish = resolve));
      },
      { lockDuration: 5000 }
    );
    const completed: string[] = [];
    worker.on('completed', (job) => completed.push(job.id));
    await queue.add('x', {}, { jobId: 'a' });
    await until('running', () => started);
    const began = performance.now();
    await worker.close({ graceMs: 50, timeout: 400 });
    expect(performance.now() - began).toBeLessThan(50 + 2 * 400 + 500);
    expect(await row('a')).toMatchObject({ state: 'waiting', lease_owner: null, attempts: 0 });
    finish('late');
    await pause(100);
    expect(completed).toEqual([]);
    expect((await row('a')).state).toBe('waiting');
  });

  test('close is idempotent, true means no grace, and the registry row is removed', async () => {
    const worker = kit.worker('close', () => {}, { heartbeatInterval: 30 });
    await worker.waitUntilReady();
    expect((await f.store.workers.list()).some((r) => r.id === worker.id)).toBe(true);
    const closed: string[] = [];
    worker.on('closed', () => closed.push('closed'));
    const first = worker.close(true);
    expect(worker.close()).toBe(first);
    await first;
    expect(closed).toEqual(['closed']);
    expect((await f.store.workers.list()).some((r) => r.id === worker.id)).toBe(false);
    await worker.close();
    expect(worker.isRunning()).toBe(false);
  });

  test('a closed worker takes no more bells', async () => {
    const queue = f.queue('close');
    const seen: string[] = [];
    const worker = kit.worker('close', (job) => void seen.push(job.id));
    await worker.close({ graceMs: 0 });
    await queue.add('x', {}, { jobId: 'late' });
    await pause(150);
    expect(seen).toEqual([]);
    expect(await queue.getJobState('late')).toBe('waiting');
  });

  test('the transport is closed only with closeTransport', async () => {
    const closes: string[] = [];
    class Spy extends FlakyTransport {
      override async close(): Promise<void> {
        closes.push('closed');
        await super.close();
      }
    }
    const left = new Spy();
    await kit.worker('close', () => {}, { transport: left }).close({ graceMs: 0 });
    expect(closes).toEqual([]);
    const owned = new Spy();
    await kit
      .worker('close', () => {}, { transport: owned, closeTransport: true })
      .close({ graceMs: 0 });
    expect(closes).toEqual(['closed']);
  });

  test('with a silent database, close still returns within the grace plus a bounded margin and leaves the lease to expire', async () => {
    const proxy = await startFaultProxy();
    try {
      const queue = f.queue('silent');
      let started = false;
      const worker = kit.worker(
        'silent',
        () => {
          started = true;
          return new Promise<string>(() => {});
        },
        { databaseUrl: proxy.url, lockDuration: 600 }
      );
      worker.on('error', () => {});
      await queue.add('x', {}, { jobId: 'j', attempts: 2 });
      await until('running', () => started);
      proxy.proxy.blackhole(true);
      const began = performance.now();
      await worker.close({ graceMs: 100, timeout: 300 });
      const took = performance.now() - began;
      expect(took).toBeLessThan(100 + 2 * 300 + 500);
      proxy.proxy.blackhole(false);
      // Nothing could be written, so the job is the tick's: the lease expires and recovery takes it.
      expect((await row('j')).state).toBe('active');
      await until('recovery', async () => (await f.store.recoverExpired()).recovered === 1, 4000);
    } finally {
      await kit.closeAll();
      await proxy.stop();
    }
  });
});
