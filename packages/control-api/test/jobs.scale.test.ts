import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';

const BIG = 100_000;
const FAT = 600;
const FAT_BYTES = 20_000;

describeDb('jobs and queues on a 100,000 job queue', () => {
  let f: JobsFixture;
  let api: JobsApi;

  beforeAll(async () => {
    f = await openJobsFixture();
    api = f.api();
    const sql = f.t.fresh.sql;
    // Rows are copied from one job the store wrote, so each has a real payload envelope.
    const [template] = await f.store.enqueue([
      { queue: 'template', name: 'job', data: { n: 1, text: 'sample' } },
    ]);
    // 80,000 waiting, 20,000 completed; ids sort in creation order.
    await sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, run_at, created_at,
                               completed_at)
      SELECT 'test', 'big-' || lpad(g::text, 7, '0'), 'big', source.payload,
             CASE WHEN g % 5 = 0 THEN 'completed' ELSE 'waiting' END, 0, g, g,
             CASE WHEN g % 5 = 0 THEN g END
      FROM generate_series(1, ${BIG}) g, (SELECT payload FROM qcloud_jobs WHERE id = '${template!.id}') source`);
    await sql.unsafe(`DELETE FROM qcloud_jobs WHERE id = '${template!.id}'`);
    await sql.unsafe(`DELETE FROM qcloud_queue_state WHERE queue = 'template'`);
    // A few hundred jobs with payloads far over the list budget, written through the store.
    for (let from = 0; from < FAT; from += 200) {
      await f.store.enqueue(
        Array.from({ length: 200 }, (_, offset) => ({
          queue: 'fat',
          name: 'fat',
          data: 'x'.repeat(FAT_BYTES),
          options: { jobId: `fat-${String(from + offset + 1).padStart(4, '0')}` },
        }))
      );
    }
    // Queues are listed from their state rows, which the store writes on first use.
    await sql.unsafe(`
      INSERT INTO qcloud_queue_state (namespace, queue, paused)
      VALUES ('test', 'big', false) ON CONFLICT DO NOTHING`);
    await sql.unsafe('ANALYZE qcloud_jobs');
  }, 180_000);
  afterAll(() => f.drop());

  const sizeOf = (answer: { body: unknown }) => JSON.stringify(answer.body).length;

  test('jobs list of the largest page stays within the size cap', async () => {
    const started = performance.now();
    const answer = await api.call('GET', '/queues/big/jobs/list?limit=1000');
    const took = performance.now() - started;
    expect(answer.status).toBe(200);
    expect(answer.body.limit).toBe(500);
    expect(answer.body.jobs).toHaveLength(500);
    expect(answer.body.total).toBe(BIG);
    expect(sizeOf(answer)).toBeLessThan(1_000_000);
    expect(took).toBeLessThan(5_000);
  });

  test('jobs list cuts large payloads to the list budget, so a page of them is bounded', async () => {
    const answer = await api.call('GET', '/queues/fat/jobs/list?limit=500');
    expect(answer.body.jobs).toHaveLength(500);
    expect(answer.body.jobs[0].truncated).toBe(true);
    expect(answer.body.jobs[0].data).toMatchObject({ $type: 'truncated', kind: 'string' });
    // 500 payloads of 20 KB would be 10 MB; the page is a tenth of that at most.
    expect(sizeOf(answer)).toBeLessThan(1_000_000);
  });

  test('jobs detail of a large payload is whole up to its own budget', async () => {
    const answer = await api.call('GET', '/jobs/fat-0001');
    expect(answer.body.job.truncated).toBe(false);
    expect((answer.body.job.data as string).length).toBe(FAT_BYTES);
  });

  test('jobs list pages deep by offset up to the bound and by cursor past it', async () => {
    const last = await api.call(
      'GET',
      '/queues/big/jobs/list?states=waiting,completed&limit=5&offset=99996'
    );
    expect(last.status).toBe(200);
    expect(last.body.jobs).toHaveLength(4);
    const past = await api.call('GET', '/queues/big/jobs/list?offset=100001');
    expect(past.status).toBe(400);
    expect(past.body.error.details.use).toBe('cursor');
    const seen = new Set<string>();
    let cursor = '';
    for (let page = 0; page < 3; page += 1) {
      const next = await api.call(
        'GET',
        `/queues/big/jobs/list?states=waiting&limit=100&cursor=${encodeURIComponent(cursor)}`
      );
      for (const job of next.body.jobs) seen.add(job.id);
      cursor = next.body.next;
      expect(cursor).toBeString();
    }
    expect(seen.size).toBe(300);
  });

  test('queues counts, summary and dashboard read the counters of the big queue quickly', async () => {
    const started = performance.now();
    const counts = await api.call('GET', '/queues/big/counts');
    const summary = await api.call<{ name: string; counts: Record<string, number> }[]>(
      'GET',
      '/queues/summary'
    );
    const dashboard = await api.call('GET', '/dashboard');
    const page = await api.call('GET', '/dashboard/queues/big');
    const took = performance.now() - started;
    expect(counts.body.counts).toMatchObject({ waiting: 80_000, completed: 20_000 });
    expect(summary.body.find((queue) => queue.name === 'big')?.counts.waiting).toBe(80_000);
    expect(dashboard.body.stats).toMatchObject({ waiting: 80_600, completed: 20_000 });
    expect(page.body.jobs.waiting).toHaveLength(20);
    expect(sizeOf(page)).toBeLessThan(100_000);
    expect(took).toBeLessThan(5_000);
  });
});
