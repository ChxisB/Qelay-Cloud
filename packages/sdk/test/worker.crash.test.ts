import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JOURNAL_START } from '@qelay-cloud/store-postgres';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { Lines } from './childLines';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

const CHILD = `${import.meta.dir}/crashWorker.ts`;
const LEASE_MS = 400;
/** A recovered job is retried after its backoff; the child rings once, so the test waits it out. */
const BACKOFF_MS = 100;

describeDb('worker: crashes', () => {
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

  /** A worker process on the fixture's schema; it has claimed a job when `STARTED` is printed. */
  function spawnWorker(queue: string, graceMs = 100) {
    const child = Bun.spawn(
      [
        'bun',
        CHILD,
        testDatabaseUrl(),
        f.fresh.name,
        NAMESPACE,
        queue,
        String(LEASE_MS),
        String(graceMs),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' }
    );
    children.push(child);
    return { child, lines: new Lines(child.stdout as ReadableStream<Uint8Array>) };
  }

  async function row(id: string) {
    const [found] = await f.fresh.sql<
      Array<{ state: string; lease_owner: string | null; attempts: number }>
    >`SELECT state, lease_owner, attempts FROM qcloud_jobs WHERE id = ${id}`;
    return found!;
  }

  async function journal(queue: string, jobId: string): Promise<string[]> {
    const page = await f.store.events.read(JOURNAL_START, { queue, limit: 5000 });
    return page.events.filter((e) => e.jobId === jobId).map((e) => e.type);
  }

  test('SIGKILL mid-job: the tick recovers it, an attempt is counted per crash, and it completes exactly once', async () => {
    const queue = f.queue('crash');
    await queue.add(
      'x',
      { n: 1 },
      { jobId: 'j', attempts: 4, backoff: { type: 'fixed', delay: BACKOFF_MS } }
    );

    for (const crash of [0, 1]) {
      const { child, lines } = spawnWorker('crash');
      expect(await lines.next('READY')).toBe('READY');
      expect(await lines.next('the job to start')).toBe(`STARTED j ${crash}`);
      child.kill('SIGKILL');
      await child.exited;
      // Dead, but still `active` under its lease: nobody can claim it until the lease expires.
      expect((await row('j')).state).toBe('active');
      await until('recovery', async () => (await f.store.recoverExpired()).recovered === 1, 5000);
      expect((await row('j')).attempts).toBe(crash + 1);
      await pause(BACKOFF_MS + 50);
    }

    const completed: Array<[string, number]> = [];
    kit.worker('crash', (job) => {
      completed.push([job.id, job.attemptsMade]);
      return 'done';
    });
    await until('completion', async () => (await queue.getJobState('j')) === 'completed', 8000);
    expect(completed).toEqual([['j', 2]]);
    const types = await journal('crash', 'j');
    expect(types.filter((type) => type === 'completed')).toHaveLength(1);
    expect(types.filter((type) => type === 'stalled')).toHaveLength(2);
    expect(types.filter((type) => type === 'pulled')).toHaveLength(3);
  }, 30_000);

  test('a job that crashes its worker on its last attempt fails for good instead of looping', async () => {
    const queue = f.queue('crash');
    await queue.add('x', {}, { jobId: 'j', attempts: 1 });
    const { child, lines } = spawnWorker('crash');
    await lines.next('READY');
    await lines.next('the job to start');
    child.kill('SIGKILL');
    await child.exited;
    await until('recovery', async () => (await f.store.recoverExpired()).recovered === 1, 5000);
    expect(await queue.getJobState('j')).toBe('failed');
  });

  test('SIGTERM closes the worker: the job is released with no failure and no lease, and the process exits 0', async () => {
    const queue = f.queue('term');
    await queue.add('x', {}, { jobId: 'j', attempts: 1 });
    const { child, lines } = spawnWorker('term');
    await lines.next('READY');
    await lines.next('the job to start');
    child.kill('SIGTERM');
    expect(await lines.next('CLOSED')).toBe('CLOSED');
    expect(await child.exited).toBe(0);
    expect(await row('j')).toMatchObject({ state: 'waiting', lease_owner: null, attempts: 0 });
    expect(await journal('term', 'j')).toEqual(['pushed', 'pulled', 'released']);
  });
});
