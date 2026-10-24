import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { Lines } from './childLines';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

const CHILD = `${import.meta.dir}/crashWorker.ts`;
const LEASE_MS = 400;
const BACKOFF_MS = 100;

describeDb('worker: a crash in the middle of a batch', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
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
    for (const child of children.splice(0)) child.kill('SIGKILL');
    await kit.closeAll();
  });

  test('SIGKILL with a batch running: every job in it stalls, is recovered with an attempt counted, and completes once', async () => {
    const queue = f.queue<number>('crash');
    const opts = { attempts: 3, backoff: { type: 'fixed' as const, delay: BACKOFF_MS } };
    const jobs = await Promise.all([1, 2, 3, 4].map((n) => queue.add('x', n, opts)));
    const child = Bun.spawn(
      [
        'bun',
        CHILD,
        testDatabaseUrl(),
        f.fresh.name,
        NAMESPACE,
        'crash',
        String(LEASE_MS),
        '100',
        '4',
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' }
    );
    children.push(child);
    const lines = new Lines(child.stdout as ReadableStream<Uint8Array>);
    await lines.next('READY');
    const started = (await lines.next('the batch to start')).split(' ')[1]!.split(',').sort();
    expect(started).toEqual(jobs.map((job) => job.id).sort());
    child.kill('SIGKILL');
    await child.exited;

    // Dead, but every job is still `active` under its own lease until the tick finds them.
    expect((await queue.getJobCounts()).active).toBe(4);
    await until('recovery', async () => (await f.store.recoverExpired()).recovered === 4, 5000);
    await pause(BACKOFF_MS + 50);

    const seen: number[][] = [];
    kit.batchWorker<number>(
      'crash',
      (batch) => void seen.push(batch.map((job) => job.attemptsMade)),
      { size: 4, maxWaitMs: 200 }
    );
    await until('completion', async () => (await queue.getJobCounts()).completed === 4, 8000);
    expect(seen).toEqual([[1, 1, 1, 1]]);
  }, 30_000);
});
