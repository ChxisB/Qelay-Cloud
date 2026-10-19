import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, readJob, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('ring query: which jobs need a bell', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 60_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const ids = async (query?: Parameters<typeof t.store.dueForRing>[0]) =>
    (await t.store.dueForRing(query)).map((ring) => ring.bell.jobId);
  const NO_GRACE = { graceMs: 0 };

  describe('jobs that were never rung', () => {
    test('a claimable job is returned as a bell with dueInMs 0', async () => {
      const [id] = await enqueueN(t.store, 1);
      expect(await t.store.dueForRing(NO_GRACE)).toEqual([
        { bell: { namespace: 'test', queue: 'q', jobId: id! }, dueInMs: 0 },
      ]);
    });

    test('a job inside the grace is left alone, and found once the grace has passed', async () => {
      const [id] = await enqueueN(t.store, 1);
      t.clock.advance(1_999);
      expect(await ids({ graceMs: 2_000 })).toEqual([]);
      t.clock.advance(1);
      expect(await ids({ graceMs: 2_000 })).toEqual([id!]);
    });

    test('the default grace is 2 seconds', async () => {
      await enqueueN(t.store, 1);
      t.clock.advance(1_999);
      expect(await ids()).toEqual([]);
      t.clock.advance(1);
      expect(await ids()).toHaveLength(1);
    });

    test('returns a rung job to the query only when its bell has aged', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      expect(await ids({ ...NO_GRACE, reRingAfterMs: 5_000 })).toEqual([]);
      t.clock.advance(4_999);
      expect(await ids({ ...NO_GRACE, reRingAfterMs: 5_000 })).toEqual([]);
      t.clock.advance(1);
      expect(await ids({ ...NO_GRACE, reRingAfterMs: 5_000 })).toEqual([id!]);
    });

    test('a bell that is rung again is quiet for another threshold', async () => {
      const [id] = await enqueueN(t.store, 1);
      const options = { ...NO_GRACE, reRingAfterMs: 5_000 };
      t.clock.advance(5_000);
      expect(await ids(options)).toEqual([id!]);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      expect(await ids(options)).toEqual([]);
      t.clock.advance(5_000);
      expect(await ids(options)).toEqual([id!]);
    });

    test('a retried job (rung_at cleared) is returned at once: it has no timestamp of its own', async () => {
      const job = await claimOne(t, { attempts: 3, backoff: 0 });
      await t.store.markRung([{ jobId: job.id, deliverAfterMs: 0 }]);
      await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
      expect((await readJob(t, job.id))?.rung_at).toBeNull();
      expect(await ids({ graceMs: 2_000 })).toEqual([]);
      t.clock.advance(10_000);
      expect(await ids({ graceMs: 2_000 })).toEqual([job.id]);
    });
  });

  describe('delayed jobs', () => {
    test('one inside the window is returned with the wait until its time', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 30_000 });
      expect(await t.store.dueForRing(NO_GRACE)).toEqual([
        { bell: { namespace: 'test', queue: 'q', jobId: id! }, dueInMs: 30_000 },
      ]);
    });

    test('one beyond the window is not returned until it comes inside', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 90_000 });
      expect(await ids(NO_GRACE)).toEqual([]);
      t.clock.advance(30_000);
      expect(await t.store.dueForRing(NO_GRACE)).toMatchObject([{ dueInMs: 60_000 }]);
      expect(await ids(NO_GRACE)).toEqual([id!]);
    });

    test('the caller can narrow the window, and cannot widen it past the transport', async () => {
      await enqueueN(t.store, 1, { delay: 30_000 });
      expect(await ids({ ...NO_GRACE, windowMs: 10_000 })).toEqual([]);
      expect(await ids({ ...NO_GRACE, windowMs: 30_000 })).toHaveLength(1);
      await enqueueN(t.store, 1, { delay: 90_000 });
      expect(await ids({ ...NO_GRACE, windowMs: 1_000_000 })).toHaveLength(1);
    });

    test('a transport with no window rings a delayed job only once it is due', async () => {
      const bare = t.another({ ringWindowMs: 0 });
      const [id] = await enqueueN(t.store, 1, { delay: 1_000 });
      expect(await bare.dueForRing(NO_GRACE)).toEqual([]);
      t.clock.advance(1_000);
      expect((await bare.dueForRing(NO_GRACE)).map((ring) => ring.bell.jobId)).toEqual([id!]);
    });

    test('a pre-rung delayed job is quiet until its bell, rung for run_at, has aged', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 30_000 });
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 30_000 }]);
      const options = { ...NO_GRACE, reRingAfterMs: 5_000 };
      t.clock.advance(30_000);
      expect(await ids(options)).toEqual([]);
      t.clock.advance(4_999);
      expect(await ids(options)).toEqual([]);
      t.clock.advance(1);
      expect(await t.store.dueForRing(options)).toMatchObject([
        { bell: { jobId: id! }, dueInMs: 0 },
      ]);
    });

    test('a due job still stored as delayed is rung like a claimable one', async () => {
      const [id] = await enqueueN(t.store, 1, { delay: 1_000 });
      t.clock.advance(1_000);
      expect((await readJob(t, id!))?.state).toBe('delayed');
      expect(await t.store.dueForRing(NO_GRACE)).toMatchObject([
        { bell: { jobId: id! }, dueInMs: 0 },
      ]);
    });
  });

  describe('what is never rung', () => {
    test('active, completed, failed and waiting-children jobs', async () => {
      await claimOne(t);
      const done = await claimOne(t);
      await t.store.complete(done.lease, null);
      const failed = await claimOne(t, { attempts: 1 });
      await t.store.fail(failed.lease, { message: 'x', unrecoverable: true });
      const [parked] = await enqueueN(t.store, 1);
      await t.fresh.sql`UPDATE qcloud_jobs SET state = 'waiting-children' WHERE id = ${parked!}`;
      t.clock.advance(60_000);
      expect(await ids({ ...NO_GRACE, reRingAfterMs: 0 })).toEqual([]);
    });

    test('a paused queue: its bells would be empty claims, and resume clears them', async () => {
      await enqueueN(t.store, 2, {}, 'held');
      const [open] = await enqueueN(t.store, 1, {}, 'open');
      await t.store.pause('held');
      expect(await ids(NO_GRACE)).toEqual([open!]);
      await t.store.resume('held');
      expect(await ids(NO_GRACE)).toHaveLength(3);
    });

    test('another namespace is invisible', async () => {
      await enqueueN(t.store, 2);
      const other = t.another({ namespace: 'elsewhere' });
      expect(await other.dueForRing(NO_GRACE)).toEqual([]);
    });
  });

  describe('the cap', () => {
    test('a backlog of N rings at most the cap per queue, never-rung jobs oldest first', async () => {
      const alpha = await enqueueN(t.store, 25, {}, 'alpha');
      const beta = await enqueueN(t.store, 7, {}, 'beta');
      const rings = await t.store.dueForRing({ ...NO_GRACE, perQueueCap: 10 });
      const byQueue = (queue: string) =>
        rings.filter((ring) => ring.bell.queue === queue).map((ring) => ring.bell.jobId);
      expect(byQueue('alpha')).toEqual(alpha.slice(0, 10));
      expect(byQueue('beta')).toEqual(beta);
    });

    test('never-rung jobs come before stale bells, so a lost bell never starves a new job', async () => {
      const old = await enqueueN(t.store, 5);
      await t.store.markRung(old.map((jobId) => ({ jobId, deliverAfterMs: 0 })));
      t.clock.advance(5_000);
      const fresh = await enqueueN(t.store, 3);
      t.clock.advance(5_000);
      const rings = await ids({ ...NO_GRACE, reRingAfterMs: 5_000, perQueueCap: 4 });
      expect(rings.slice(0, 3)).toEqual(fresh);
      expect(rings).toHaveLength(4);
      expect(old).toContain(rings[3]!);
    });

    test('a backlog is fully rung after ceil(N / cap) ticks, each tick one threshold apart', async () => {
      const all = await enqueueN(t.store, 23);
      const options = { ...NO_GRACE, reRingAfterMs: 5_000, perQueueCap: 10 };
      const seen = new Set<string>();
      let ticks = 0;
      while (seen.size < all.length && ticks < 10) {
        const rings = await t.store.dueForRing(options);
        expect(rings.length).toBeLessThanOrEqual(10);
        await t.store.markRung(
          rings.map((ring) => ({ jobId: ring.bell.jobId!, deliverAfterMs: 0 }))
        );
        for (const ring of rings) seen.add(ring.bell.jobId!);
        t.clock.advance(5_000);
        ticks++;
      }
      expect(ticks).toBe(3);
      expect(seen.size).toBe(23);
    });
  });

  test('staleCap limits the re-rings of old bells, not the first rings of jobs that never had one', async () => {
    const rung = await enqueueN(t.store, 8);
    await t.store.markRung(rung.map((jobId) => ({ jobId, deliverAfterMs: 0 })));
    t.clock.advance(5_000);
    const fresh = await enqueueN(t.store, 3);
    t.clock.advance(1);
    const rings = await ids({ ...NO_GRACE, reRingAfterMs: 5_000, perQueueCap: 20, staleCap: 2 });
    expect(rings.filter((id) => fresh.includes(id!))).toHaveLength(3);
    expect(rings.filter((id) => rung.includes(id!))).toHaveLength(2);
  });

  test.each([
    ['perQueueCap', { perQueueCap: 0 }],
    ['perQueueCap', { perQueueCap: 1.5 }],
    ['staleCap', { staleCap: 0 }],
    ['reRingAfterMs', { reRingAfterMs: -1 }],
    ['graceMs', { graceMs: Number.NaN }],
    ['windowMs', { windowMs: -5 }],
  ])('rejects an unusable %s', async (name, query) => {
    const error = await t.store.dueForRing(query).catch((caught) => caught);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(name);
  });

  test('reads only: it changes no row', async () => {
    await enqueueN(t.store, 5);
    const before = await t.fresh.sql`SELECT id, rung_at, version FROM qcloud_jobs ORDER BY id`;
    await t.store.dueForRing(NO_GRACE);
    expect(await t.fresh.sql`SELECT id, rung_at, version FROM qcloud_jobs ORDER BY id`).toEqual(
      before
    );
    expect(t.clock.now()).toBe(START);
  });
});
