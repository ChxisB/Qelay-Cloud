import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { LeaseLostError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { startFaultProxy } from '../../store-postgres/test/fault';
import type { FaultProxy } from '../../store-postgres/test/fault';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

/** Blocks the event loop, as a CPU-bound processor does. */
function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) Math.sqrt(Math.random());
}

describeDb('worker: the lease', () => {
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

  async function leaseOf(id: string) {
    const [row] = await f.fresh.sql<
      Array<{
        state: string;
        lease_owner: string | null;
        lease_token: string | null;
        attempts: number;
      }>
    >`SELECT state, lease_owner, lease_token, attempts FROM qcloud_jobs WHERE id = ${id}`;
    return row!;
  }

  test('a worker that loses its lease aborts the signal, keeps its slot until the processor returns, and writes nothing', async () => {
    const queue = f.queue('lost');
    let finish: (value: string) => void = () => {};
    const returned = new Promise<string>((resolve) => (finish = resolve));
    let signal: AbortSignal | undefined;
    const worker = kit.worker(
      'lost',
      (_job, context) => {
        signal = context.signal;
        return returned;
      },
      { lockDuration: 300 }
    );
    const events: string[] = [];
    worker.on('stalled', (id, reason) => events.push(`stalled:${id}:${reason}`));
    worker.on('completed', () => events.push('completed'));
    worker.on('failed', () => events.push('failed'));
    worker.on('error', (error) => events.push(`error:${error.name}`));
    await queue.add('x', {}, { jobId: 'j', attempts: 3 });
    await until('the job to be active', () => signal !== undefined);

    // Someone else takes the job: the holder releases it (the way a recovery would) and another owner claims it.
    const held = await leaseOf('j');
    await f.store.release({ jobId: 'j', token: held.lease_token!, owner: held.lease_owner! });
    const [stolen] = await f.store.claim('lost', 'thief', 1);
    expect(stolen!.id).toBe('j');

    await until('the worker to notice', () => events.includes('stalled:j:lease-lost'));
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBeInstanceOf(LeaseLostError);
    expect(worker.activeJobs).toBe(1);

    finish('too late');
    await until('the slot to be free', () => worker.activeJobs === 0);
    expect(events).toEqual(['stalled:j:lease-lost', 'error:LeaseLostError']);
    const after = await leaseOf('j');
    expect(after).toMatchObject({ state: 'active', lease_owner: 'thief' });
    expect((await f.store.complete(stolen!.lease, 'the thief did it')).ok).toBe(true);
  });

  test('a processor that fails after its lease was lost does not fail the job either', async () => {
    const queue = f.queue('lost');
    let fail: (error: Error) => void = () => {};
    const returned = new Promise<string>((_, reject) => (fail = reject));
    let started = false;
    const worker = kit.worker(
      'lost',
      () => {
        started = true;
        return returned;
      },
      { lockDuration: 300 }
    );
    const events: string[] = [];
    worker.on('stalled', () => events.push('stalled'));
    worker.on('failed', () => events.push('failed'));
    await queue.add('x', {}, { jobId: 'j', attempts: 1 });
    await until('active', () => started);
    const held = await leaseOf('j');
    await f.store.release({ jobId: 'j', token: held.lease_token!, owner: held.lease_owner! });
    await until('stalled', () => events.includes('stalled'));
    fail(new Error('aborted by the signal'));
    await until('slot free', () => worker.activeJobs === 0);
    expect(events).toEqual(['stalled']);
    expect(await leaseOf('j')).toMatchObject({ state: 'waiting', attempts: 0 });
  });

  test('a heartbeat that cannot be confirmed is a lost lease at the last confirmed beat plus the lease length', async () => {
    const proxy: FaultProxy = await startFaultProxy();
    try {
      const queue = f.queue('silent');
      let signal: AbortSignal | undefined;
      let startedAt = 0;
      const worker = kit.worker(
        'silent',
        (_job, context) => {
          signal = context.signal;
          startedAt = performance.now();
          return new Promise<string>(() => {});
        },
        { lockDuration: 600, databaseUrl: proxy.url }
      );
      let stalledAt = 0;
      let why = '';
      worker.on('stalled', (_id, reason) => {
        stalledAt = performance.now();
        why = reason;
      });
      worker.on('error', () => {});
      await queue.add('x', {}, { jobId: 'j', attempts: 2 });
      await until('the job to start', () => signal !== undefined);
      proxy.proxy.blackhole(true);
      await until('the watchdog', () => stalledAt > 0, 3000);
      // Never later than the lease the database granted from the claim, plus scheduling.
      expect(why).toBe('lease-unconfirmed');
      expect(stalledAt - startedAt).toBeLessThan(600 + 250);
      expect(signal!.aborted).toBe(true);
      proxy.proxy.blackhole(false);
      await pause(200);
      // The worker never wrote: the row is still active under the worker's lease until it expires.
      expect((await leaseOf('j')).state).toBe('active');
      await until('the lease to expire and be recovered', async () => {
        return (await f.store.recoverExpired()).recovered === 1;
      });
      expect(await leaseOf('j')).toMatchObject({
        state: expect.stringMatching(/waiting|delayed/),
        attempts: 1,
      });
    } finally {
      await kit.closeAll();
      await proxy.stop();
    }
  });

  test('a processor that works in slices keeps its lease for far longer than the lease length', async () => {
    const queue = f.queue('slices');
    const worker = kit.worker(
      'slices',
      async () => {
        const end = performance.now() + 1500;
        while (performance.now() < end) {
          spin(30);
          await new Promise((resolve) => setImmediate(resolve));
        }
        return 'done';
      },
      { lockDuration: 450 }
    );
    let stalled = 0;
    worker.on('stalled', () => (stalled += 1));
    await queue.add('x', {}, { jobId: 'j', attempts: 2 });
    // Someone is always recovering expired leases: only a beat that landed keeps the job.
    const recoverer = setInterval(() => void f.store.recoverExpired(), 40);
    try {
      await until('completion', async () => (await queue.getJobState('j')) === 'completed', 8000);
    } finally {
      clearInterval(recoverer);
    }
    expect(stalled).toBe(0);
    expect((await leaseOf('j')).attempts).toBe(0);
  });

  test('a processor that blocks the loop for less than the lease completes normally', async () => {
    const queue = f.queue('block');
    const worker = kit.worker(
      'block',
      () => {
        spin(300);
        return 'done';
      },
      { lockDuration: 1000 }
    );
    let stalled = 0;
    worker.on('stalled', () => (stalled += 1));
    await queue.add('x', {}, { jobId: 'j' });
    await until('completion', async () => (await queue.getJobState('j')) === 'completed');
    expect(stalled).toBe(0);
  });
});
