import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, recording, resetTables } from './finishHelpers';
import { makeFlow, remainingIds } from './flowFixtures';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

describeDb('control: remove one job', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  test.each([
    ['waiting', {}, 'waiting'],
    ['prioritized', { priority: 2 }, 'prioritized'],
    ['delayed', { delay: 60_000 }, 'delayed'],
  ] as const)(
    'deletes a %s job with its logs and journals it as removed',
    async (_name, options, state) => {
      const [id] = await enqueueN(t.store, 1, options);
      await t.store.logs.add(id!, 'a line');
      log.events.length = 0;
      expect(await t.store.control.remove(id!)).toBe('removed');
      expect(await t.store.getJob(id!)).toBeNull();
      expect(await t.store.logs.list(id!)).toEqual([]);
      expect(log.events).toEqual([
        { type: 'removed', queue: 'q', jobId: id!, state, removed: true },
      ]);
    }
  );

  test('deletes a completed job and a failed one; the completion record stays', async () => {
    const done = await claimOne(t);
    await t.store.complete(done.lease, 'r');
    const failed = await claimOne(t);
    await t.store.fail(failed.lease, { message: 'x', unrecoverable: true });
    expect(await t.store.control.remove(done.id)).toBe('removed');
    expect(await t.store.control.remove(failed.id)).toBe('removed');
    expect(await remainingIds(t)).toEqual([]);
    const completions = await t.fresh.sql`SELECT job_id FROM qcloud_completions`;
    expect(completions.map((row: { job_id: string }) => row.job_id)).toEqual([done.id]);
  });

  test('an active job is refused: its worker holds the lease', async () => {
    const job = await claimOne(t);
    log.events.length = 0;
    expect(await t.store.control.remove(job.id)).toBe('active');
    expect(await t.store.getJob(job.id)).toMatchObject({ state: 'active' });
    expect(log.events).toEqual([]);
    expect((await t.store.complete(job.lease, null)).ok).toBe(true);
  });

  test('an unknown id is not-found', async () => {
    expect(await t.store.control.remove('missing')).toBe('not-found');
  });

  test('a job a live flow parent waits on is protected, pending or finished', async () => {
    const flow = await makeFlow(t, { children: 2 });
    const [first] = await t.store.claim('q', 'w', 1);
    await t.store.complete(first!.lease, 'child result');
    expect(await t.store.control.remove(first!.id)).toBe('protected');
    const second = flow.children.find((id) => id !== first!.id)!;
    expect(await t.store.control.remove(second)).toBe('protected');
    expect(await remainingIds(t)).toEqual([flow.parent, ...flow.children].sort());
  });

  test('a flow parent can be removed, which takes its dependencies; then its children can', async () => {
    const flow = await makeFlow(t, { children: 2 });
    expect(await t.store.control.remove(flow.parent)).toBe('removed');
    const edges = await t.fresh.sql`SELECT 1 FROM qcloud_dependencies`;
    expect(edges).toHaveLength(0);
    for (const child of flow.children) expect(await t.store.control.remove(child)).toBe('removed');
    expect(await remainingIds(t)).toEqual([]);
  });

  test('a child whose parent row is gone is not protected', async () => {
    const flow = await makeFlow(t);
    await t.fresh.sql`DELETE FROM qcloud_jobs WHERE id = ${flow.parent}`;
    expect(await t.store.control.remove(flow.children[0]!)).toBe('removed');
  });
});
