import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Ring } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TerminalChange } from '../src/store/context';
import { claimOne, expireLease, metric, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('complete: all or nothing', () => {
  const log = recording();
  const seen: Array<{ changes: readonly TerminalChange[]; inTransaction: boolean }> = [];
  let hookFailure: Error | null = null;
  let hookRings: Ring[] = [];
  let t: TestStore;

  beforeAll(async () => {
    t = await openTestStore({
      recorder: log.recorder,
      leaseMs: 30_000,
      onTerminal: async (tx, changes) => {
        // The hook gets the transaction: a statement on it sees the rows this operation wrote.
        const [row] = await tx<{ state: string }[]>`
          SELECT state FROM qcloud_jobs WHERE id = ${changes[0]!.jobId}`;
        seen.push({ changes, inTransaction: row?.state !== 'active' });
        if (hookFailure) throw hookFailure;
        return hookRings;
      },
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`DROP TRIGGER IF EXISTS refuse_totals ON qcloud_metric_totals`;
    log.events.length = 0;
    log.failWith(null);
    seen.length = 0;
    hookFailure = null;
    hookRings = [];
  });

  const snapshot = async (id: string) => ({
    job: await readJob(t, id),
    completions: await t.fresh.sql`SELECT * FROM qcloud_completions`,
    totals: await t.fresh.sql`SELECT * FROM qcloud_metric_totals`,
  });

  test('a recorder that throws rolls back the completion, the record and the metric', async () => {
    const job = await claimOne(t);
    log.events.length = 0;
    const before = await snapshot(job.id);
    log.failWith(new Error('journal is down'));
    await expect(t.store.complete(job.lease, 'x')).rejects.toThrow('journal is down');
    expect(await snapshot(job.id)).toEqual(before);
    expect(before.job!.state).toBe('active');
  });

  test('after a failed attempt the same lease completes the job', async () => {
    const job = await claimOne(t);
    log.failWith(new Error('journal is down'));
    await expect(t.store.complete(job.lease, 'x')).rejects.toThrow();
    log.failWith(null);
    expect(await t.store.complete(job.lease, 'x')).toMatchObject({ ok: true });
    expect((await readJob(t, job.id))!.state).toBe('completed');
  });

  test('a metric write that fails rolls back everything before it', async () => {
    const job = await claimOne(t);
    const before = await snapshot(job.id);
    await t.fresh.sql.unsafe(`
      CREATE OR REPLACE FUNCTION refuse_totals() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'metrics refused'; END $$;
      CREATE TRIGGER refuse_totals BEFORE INSERT OR UPDATE ON qcloud_metric_totals
      FOR EACH ROW EXECUTE FUNCTION refuse_totals();`);
    await expect(t.store.complete(job.lease, 'x')).rejects.toThrow();
    expect(await snapshot(job.id)).toEqual(before);
    await t.fresh.sql`DROP TRIGGER refuse_totals ON qcloud_metric_totals`;
    expect(await t.store.complete(job.lease, 'x')).toMatchObject({ ok: true });
  });

  test('the terminal hook runs once, inside the transaction, with the change', async () => {
    const job = await claimOne(t);
    await t.store.complete(job.lease, 1);
    expect(seen).toEqual([
      {
        changes: [{ jobId: job.id, queue: 'q', parentId: null, outcome: 'completed' }],
        inTransaction: true,
      },
    ]);
  });

  test('the rings the hook returns come back from complete', async () => {
    const job = await claimOne(t);
    hookRings = [{ bell: { namespace: 'test', queue: 'q', jobId: 'parent' }, dueInMs: 0 }];
    expect(await t.store.complete(job.lease, 1)).toEqual({ ok: true, rings: hookRings });
  });

  test('a hook that throws rolls the completion back', async () => {
    const job = await claimOne(t);
    const before = await snapshot(job.id);
    hookFailure = new Error('parent promotion failed');
    await expect(t.store.complete(job.lease, 1)).rejects.toThrow('parent promotion failed');
    expect(await snapshot(job.id)).toEqual(before);
    hookFailure = null;
    expect(await t.store.complete(job.lease, 1)).toMatchObject({ ok: true });
  });

  test('the hook is not run for a lost lease', async () => {
    const job = await claimOne(t);
    await t.store.complete({ ...job.lease, token: 'stale' }, 1);
    expect(seen).toEqual([]);
  });
});

describeDb('complete: concurrent callers', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('the same lease completed ten times at once succeeds once', async () => {
    const job = await claimOne(t);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => t.store.complete(job.lease, i))
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await metric(t, 'q', 'completed')).total).toBe(1);
    const records = await t.fresh.sql`SELECT 1 FROM qcloud_completions`;
    expect(records).toHaveLength(1);
  });

  test('complete racing fail on the last attempt: one wins, the other is refused', async () => {
    for (let round = 0; round < 10; round++) {
      await resetTables(t);
      const job = await claimOne(t, { attempts: 1 });
      const [done, failed] = await Promise.all([
        t.store.complete(job.lease, 'x'),
        t.store.fail(job.lease, { message: 'boom', unrecoverable: false }),
      ]);
      expect([done.ok, failed.ok].sort()).toEqual([false, true]);
      const state = (await readJob(t, job.id))!.state;
      expect(state).toBe(done.ok ? 'completed' : 'failed');
      expect((await metric(t, 'q', 'completed')).total).toBe(done.ok ? 1 : 0);
      expect((await metric(t, 'q', 'failed')).total).toBe(done.ok ? 0 : 1);
    }
  });

  test('complete racing recovery at the instant the lease expires: the worker is refused, the job is recovered once', async () => {
    for (let round = 0; round < 10; round++) {
      await resetTables(t);
      const job = await claimOne(t, { attempts: 1 });
      expireLease(t, job);
      // At lease_until the fence refuses the worker and recovery takes the job: they never overlap.
      // A recovery that finds the row locked by the refused complete skips it; the next pass takes it.
      const [done, first] = await Promise.all([
        t.store.complete(job.lease, 'x'),
        t.store.recoverExpired(),
      ]);
      const second = await t.store.recoverExpired();
      expect(done.ok).toBe(false);
      expect(first.recovered + second.recovered).toBe(1);
      expect((await readJob(t, job.id))!.state).toBe('failed');
      expect((await metric(t, 'q', 'failed')).total).toBe(1);
      expect((await metric(t, 'q', 'completed')).total).toBe(0);
    }
  });
});
