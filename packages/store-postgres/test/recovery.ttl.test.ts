import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, metric, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('recovery: expiry of pending jobs by ttl', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  /** No job option sets a ttl yet (D6), so the tests write the column. */
  const setTtl = (ids: readonly string[], ttl: number | null) =>
    t.fresh
      .sql`UPDATE qcloud_jobs SET ttl = ${ttl} WHERE id = ANY(${t.fresh.sql.array([...ids], 'TEXT')})`;

  test('deletes a pending job once created_at + ttl has passed, and journals it as removed', async () => {
    const [id] = await enqueueN(t.store, 1);
    await setTtl([id!], 1_000);
    t.clock.advance(1_001);
    log.events.length = 0;
    expect(await t.store.expirePending()).toEqual({ expired: 1, more: false });
    expect(await readJob(t, id!)).toBeUndefined();
    expect(log.events).toEqual([
      {
        type: 'removed',
        queue: 'q',
        jobId: id!,
        state: 'waiting',
        error: 'Job TTL expired',
        removed: true,
      },
    ]);
  });

  test('keeps the job at exactly created_at + ttl: the comparison is strict', async () => {
    const [id] = await enqueueN(t.store, 1);
    await setTtl([id!], 1_000);
    t.clock.advance(1_000);
    expect(await t.store.expirePending()).toEqual({ expired: 0, more: false });
    t.clock.advance(1);
    expect(await t.store.expirePending()).toEqual({ expired: 1, more: false });
  });

  test('expires waiting, prioritized and delayed jobs, with the state each was in', async () => {
    const [a] = await enqueueN(t.store, 1);
    const [b] = await enqueueN(t.store, 1, { priority: 2 });
    const [c] = await enqueueN(t.store, 1, { delay: 60_000 });
    await setTtl([a!, b!, c!], 10);
    t.clock.advance(11);
    log.events.length = 0;
    expect(await t.store.expirePending()).toMatchObject({ expired: 3 });
    expect(Object.fromEntries(log.events.map((event) => [event.jobId, event.state]))).toEqual({
      [a!]: 'waiting',
      [b!]: 'prioritized',
      [c!]: 'delayed',
    });
  });

  test('never touches a job with no ttl, an active job, or a finished one', async () => {
    const [plain] = await enqueueN(t.store, 1);
    const active = await claimOne(t);
    const done = await claimOne(t, {}, 'other');
    await t.store.complete(done.lease, 1);
    const failed = await claimOne(t, { attempts: 1 }, 'third');
    await t.store.fail(failed.lease, { message: 'x', unrecoverable: false });
    await setTtl([active.id, done.id, failed.id], 1);
    t.clock.advance(1_000);
    expect(await t.store.expirePending()).toEqual({ expired: 0, more: false });
    for (const id of [plain!, active.id, done.id, failed.id])
      expect(await readJob(t, id)).toBeDefined();
  });

  test('removes the job logs with the job and counts no metric', async () => {
    const [id] = await enqueueN(t.store, 1);
    await t.fresh.sql`
      INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
      VALUES ('test', ${id!}, ${START}, 'info', 'hello')`;
    await setTtl([id!], 1);
    t.clock.advance(2);
    await t.store.expirePending();
    expect(await t.fresh.sql`SELECT 1 FROM qcloud_job_logs WHERE job_id = ${id!}`).toHaveLength(0);
    expect((await metric(t, 'q', 'failed')).total).toBe(0);
    expect((await metric(t, 'q', 'completed')).total).toBe(0);
  });

  test('takes at most the limit, oldest first, and says there is more', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      ids.push(...(await enqueueN(t.store, 1)));
      t.clock.advance(1);
    }
    await setTtl(ids, 1);
    t.clock.advance(100);
    expect(await t.store.expirePending(2)).toEqual({ expired: 2, more: true });
    expect(await readJob(t, ids[0]!)).toBeUndefined();
    expect(await readJob(t, ids[1]!)).toBeUndefined();
    expect(await readJob(t, ids[2]!)).toBeDefined();
    expect(await t.store.expirePending(2)).toEqual({ expired: 2, more: true });
    expect(await t.store.expirePending(2)).toEqual({ expired: 1, more: false });
  });

  test('a job another transaction holds locked is skipped, so a claim in flight is not deleted', async () => {
    const [id] = await enqueueN(t.store, 1);
    await setTtl([id!], 1);
    t.clock.advance(100);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM qcloud_jobs WHERE id = ${id!} FOR UPDATE`;
      locked();
      await held;
    });
    await ready;
    expect(await t.store.expirePending()).toEqual({ expired: 0, more: false });
    release();
    await holder;
    expect(await readJob(t, id!)).toBeDefined();
    expect(await t.store.expirePending()).toMatchObject({ expired: 1 });
  });

  test('a recorder that throws rolls the expiry back', async () => {
    const [id] = await enqueueN(t.store, 1);
    await setTtl([id!], 1);
    t.clock.advance(100);
    log.failWith(new Error('journal is down'));
    await expect(t.store.expirePending()).rejects.toThrow('journal is down');
    expect(await readJob(t, id!)).toBeDefined();
    log.failWith(null);
    expect(await t.store.expirePending()).toMatchObject({ expired: 1 });
  });
});
