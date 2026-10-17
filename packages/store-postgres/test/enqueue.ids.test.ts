import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

interface Row {
  id: string;
  state: string;
  custom_id: string | null;
  dlq_entry: Uint8Array | null;
  failure_reason: string | null;
}

describeDb('enqueue: custom ids', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh
      .sql`TRUNCATE qcloud_jobs, qcloud_job_logs, qcloud_completions, qcloud_dependencies, qcloud_flow_failures, qcloud_repeat_links`;
    rewind(t);
  });

  const sql = () => t.fresh.sql;
  const all = () => sql()<Row[]>`SELECT * FROM qcloud_jobs ORDER BY id`;
  const finish = (id: string, state: 'completed' | 'failed') =>
    sql()`UPDATE qcloud_jobs SET state = ${state}, completed_at = ${START}, unique_key = NULL,
                 unique_expires_at = NULL, failure_reason = ${state === 'failed' ? 'boom' : null},
                 dlq_entry = ${state === 'failed' ? Buffer.from([1, 2, 3]) : null}
          WHERE id = ${id}`;

  test('the custom id is the job id', async () => {
    const [job] = await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'order-17' } }]);
    expect(job).toMatchObject({ id: 'order-17', created: true, state: 'waiting' });
    expect((await all())[0]).toMatchObject({ id: 'order-17', custom_id: 'order-17' });
  });

  test('a live job with the id answers a second enqueue, whatever the second one says', async () => {
    const options = { jobId: 'a' };
    const [first] = await t.store.enqueue([{ queue: 'q', data: 'one', options }]);
    const [second] = await t.store.enqueue([
      { queue: 'q', data: 'two', options: { ...options, priority: 9, delay: 5_000 } },
    ]);
    expect(second).toEqual({ id: 'a', created: false, state: 'waiting', ring: null });
    expect(first!.created).toBe(true);
    expect((await t.store.getJob('a'))!.data).toBe('one');
    expect(await all()).toHaveLength(1);
  });

  test('a duplicate reports the state the live job is in now', async () => {
    await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'd', delay: 1_000 } }]);
    const [early] = await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'd' } }]);
    expect(early!.state).toBe('delayed');
    t.clock.advance(1_000);
    const [due] = await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'd' } }]);
    expect(due!.state).toBe('waiting');
    t.clock.advance(-1_000);
  });

  test.each(['waiting-children', 'active'] as const)('a job that is %s is live', async (state) => {
    await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'live' } }]);
    await sql()`UPDATE qcloud_jobs SET state = ${state} WHERE id = 'live'`;
    const [again] = await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'live' } }]);
    expect(again).toMatchObject({ created: false, state });
  });

  test.each(['completed', 'failed'] as const)(
    'a %s job with the id is replaced by a fresh one',
    async (state) => {
      const [old] = await t.store.enqueue([{ queue: 'q', data: 'old', options: { jobId: 'r' } }]);
      await finish(old!.id, state);
      const [fresh] = await t.store.enqueue([
        { queue: 'q', data: 'new', options: { jobId: 'r', priority: 1 } },
      ]);
      expect(fresh).toMatchObject({ id: 'r', created: true, state: 'prioritized' });
      const rows = await all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        state: 'prioritized',
        dlq_entry: null,
        failure_reason: null,
      });
      expect((await t.store.getJob('r'))!.data).toBe('new');
      expect(await t.store.listDlq('q')).toEqual([]);
    }
  );

  test('a failed job shows in the DLQ until its id is reused', async () => {
    const [old] = await t.store.enqueue([
      { queue: 'q', data: 1, options: { jobId: 'f', attempts: 3 } },
    ]);
    await sql()`UPDATE qcloud_jobs SET attempts = 3 WHERE id = 'f'`;
    await finish(old!.id, 'failed');
    expect(await t.store.listDlq('q')).toEqual([
      { jobId: 'f', queue: 'q', attempts: 3, failedAt: START, reason: 'boom' },
    ]);
    await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'f' } }]);
    expect(await t.store.listDlq('q')).toEqual([]);
  });

  test('reusing a finished id deletes what hung off the old generation, and only that', async () => {
    const seed = async (namespace: string, id: string, other: string) => {
      await sql()`INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
                  VALUES (${namespace}, ${id}, ${START}, 'info', 'x')`;
      await sql()`INSERT INTO qcloud_completions (namespace, job_id, queue, completed_at)
                  VALUES (${namespace}, ${id}, 'q', ${START})`;
      await sql()`INSERT INTO qcloud_dependencies (namespace, job_id, dependency_id)
                  VALUES (${namespace}, ${id}, ${other}), (${namespace}, ${other}, ${id})`;
      await sql()`INSERT INTO qcloud_flow_failures (namespace, parent_id, child_id, child_queue, mode, error, created_at)
                  VALUES (${namespace}, ${id}, ${other}, 'q', 'fail', 'e', ${START}),
                         (${namespace}, ${other}, ${id}, 'q', 'fail', 'e', ${START})`;
      await sql()`INSERT INTO qcloud_repeat_links (namespace, original_id, successor_id)
                  VALUES (${namespace}, ${id}, ${other}), (${namespace}, ${other}, ${id})`;
    };
    const counts = async () => {
      const [row] = await sql()<Array<Record<string, number>>>`
        SELECT (SELECT count(*) FROM qcloud_job_logs WHERE namespace = 'test' AND job_id = 'old')::int AS logs,
               (SELECT count(*) FROM qcloud_completions WHERE namespace = 'test' AND job_id = 'old')::int AS completions,
               (SELECT count(*) FROM qcloud_dependencies WHERE namespace = 'test' AND job_id = 'old')::int AS dependencies,
               (SELECT count(*) FROM qcloud_flow_failures WHERE namespace = 'test' AND parent_id = 'old')::int AS failures,
               (SELECT count(*) FROM qcloud_repeat_links WHERE namespace = 'test' AND (original_id = 'old' OR successor_id = 'old'))::int AS links,
               (SELECT count(*) FROM qcloud_job_logs)::int AS all_logs,
               (SELECT count(*) FROM qcloud_dependencies)::int AS all_dependencies,
               (SELECT count(*) FROM qcloud_flow_failures)::int AS all_failures,
               (SELECT count(*) FROM qcloud_repeat_links)::int AS all_links`;
      return row!;
    };
    const [old] = await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'old' } }]);
    await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'bystander' } }]);
    await finish(old!.id, 'completed');
    await seed('test', 'old', 'bystander');
    await seed('elsewhere', 'old', 'bystander');
    expect(await counts()).toMatchObject({
      logs: 1,
      completions: 1,
      dependencies: 1,
      failures: 1,
      links: 2,
      all_logs: 2,
      all_dependencies: 4,
      all_failures: 4,
      all_links: 4,
    });

    await t.store.enqueue([{ queue: 'q', data: 2, options: { jobId: 'old' } }]);

    expect(await counts()).toMatchObject({
      logs: 0,
      completions: 0,
      dependencies: 0,
      failures: 0,
      links: 0,
      all_logs: 1,
      all_dependencies: 3,
      all_failures: 3,
      all_links: 2,
    });
    expect((await t.store.getJob('bystander'))!.state).toBe('waiting');
  });

  test('the same id in another queue of the namespace is the same job', async () => {
    await t.store.enqueue([{ queue: 'one', data: 1, options: { jobId: 'shared' } }]);
    const [other] = await t.store.enqueue([
      { queue: 'two', data: 2, options: { jobId: 'shared' } },
    ]);
    expect(other).toMatchObject({ id: 'shared', created: false });
    expect((await t.store.counts('two')).waiting).toBe(0);
  });

  describe('within one call', () => {
    test('two jobs with one id: the first is created, the second is its duplicate', async () => {
      const [a, b] = await t.store.enqueue([
        { queue: 'q', data: 'a', options: { jobId: 'x' } },
        { queue: 'q', data: 'b', options: { jobId: 'x' } },
      ]);
      expect([a!.created, b!.created]).toEqual([true, false]);
      expect(b).toMatchObject({ id: 'x', state: 'waiting', ring: null });
      expect((await t.store.getJob('x'))!.data).toBe('a');
    });

    test('over a finished generation, one fresh job is inserted and the rest duplicate it', async () => {
      const [old] = await t.store.enqueue([{ queue: 'q', data: 'old', options: { jobId: 'y' } }]);
      await finish(old!.id, 'completed');
      const results = await t.store.enqueue([
        { queue: 'q', data: 'a', options: { jobId: 'y' } },
        { queue: 'q', data: 'b', options: { jobId: 'y' } },
      ]);
      expect(results.map((r) => r.created)).toEqual([true, false]);
      expect((await t.store.getJob('y'))!.data).toBe('a');
    });
  });
});
