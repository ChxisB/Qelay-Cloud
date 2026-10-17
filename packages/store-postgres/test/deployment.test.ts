import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { PostgresStore } from '../src/postgresStore';
import { LATEST_VERSION } from '../src/schema/migrations';
import { freshSchema } from './helpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

describeDb('deployment: what the Deployment page reads', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_group_state`;
    rewind(t);
  });

  describe('doorbellHealth', () => {
    test('an empty queue has nothing claimable and nothing unrung', async () => {
      expect(await t.store.deployment.doorbellHealth(['q'])).toEqual([
        {
          queue: 'q',
          claimable: 0,
          notRung: 0,
          reRingDue: 0,
          oldestNotRungAgeMs: null,
          paused: false,
          capped: false,
        },
      ]);
    });

    test('no queues is no query', async () => {
      expect(await t.store.deployment.doorbellHealth([])).toEqual([]);
    });

    test('a job with no bell is claimable but not rung once the grace has passed', async () => {
      await enqueueN(t.store, 3);
      const [fresh] = await t.store.deployment.doorbellHealth(['q']);
      // Inside the grace its publish may still be in flight, so it is not yet "not rung".
      expect(fresh).toMatchObject({ claimable: 3, notRung: 0, oldestNotRungAgeMs: null });
      t.clock.advance(2_500);
      const [late] = await t.store.deployment.doorbellHealth(['q']);
      expect(late).toMatchObject({ claimable: 3, notRung: 3, oldestNotRungAgeMs: 2_500 });
    });

    test('a rung job leaves the not-rung count and, once its bell is old, is due a re-ring', async () => {
      const ids = await enqueueN(t.store, 2);
      await t.store.markRung([{ jobId: ids[0]!, deliverAfterMs: 0 }]);
      t.clock.advance(3_000);
      const [row] = await t.store.deployment.doorbellHealth(['q']);
      expect(row).toMatchObject({ claimable: 2, notRung: 1, reRingDue: 0 });
      t.clock.advance(2_000);
      const [after] = await t.store.deployment.doorbellHealth(['q']);
      expect(after).toMatchObject({ claimable: 2, notRung: 1, reRingDue: 1 });
    });

    test('a delayed job is not claimable until its time has passed', async () => {
      await enqueueN(t.store, 1, { delay: 10_000 });
      t.clock.advance(5_000);
      expect((await t.store.deployment.doorbellHealth(['q']))[0]).toMatchObject({
        claimable: 0,
        notRung: 0,
      });
      t.clock.advance(5_000);
      expect((await t.store.deployment.doorbellHealth(['q']))[0]).toMatchObject({
        claimable: 1,
        notRung: 1,
      });
    });

    test('an active job is not counted', async () => {
      await enqueueN(t.store, 1);
      await t.store.claim('q', 'w', 1);
      t.clock.advance(5_000);
      expect((await t.store.deployment.doorbellHealth(['q']))[0]).toMatchObject({
        claimable: 0,
        notRung: 0,
      });
    });

    test('says which queues are paused, and counts only the queue asked about', async () => {
      await enqueueN(t.store, 2, {}, 'a');
      await enqueueN(t.store, 1, {}, 'b');
      await t.store.pause('b');
      const rows = await t.store.deployment.doorbellHealth(['a', 'b']);
      expect(rows.map((row) => [row.queue, row.claimable, row.paused])).toEqual([
        ['a', 2, false],
        ['b', 1, true],
      ]);
    });

    test('a count stops at the cap and says so', async () => {
      await enqueueN(t.store, 12);
      t.clock.advance(5_000);
      const [row] = await t.store.deployment.doorbellHealth(['q'], { countCap: 5 });
      expect(row).toMatchObject({ claimable: 5, notRung: 5, capped: true });
    });

    test.each([
      ['graceMs', { graceMs: -1 }],
      ['reRingAfterMs', { reRingAfterMs: Number.NaN }],
      ['countCap', { countCap: 0 }],
    ])('refuses a bad %s', async (_name, options) => {
      await expect(t.store.deployment.doorbellHealth(['q'], options)).rejects.toThrow();
    });
  });

  describe('schemaVersion', () => {
    test('is the highest migration the database records, which is what the code expects', async () => {
      expect(await t.store.deployment.schemaVersion()).toBe(LATEST_VERSION);
    });

    test('is 0 on a database nothing has migrated, not an error', async () => {
      const bare = await freshSchema();
      try {
        const store = new PostgresStore({ db: bare.db, namespace: 'test' });
        expect(await store.deployment.schemaVersion()).toBe(0);
      } finally {
        await bare.drop();
      }
    });
  });

  describe('connections', () => {
    test('counts the connections to this database against the cap', async () => {
      const usage = await t.store.deployment.connections();
      expect(usage.inUse).toBeGreaterThanOrEqual(1);
      expect(usage.maxConnections).toBeGreaterThan(usage.inUse - 1);
    });
  });

  describe('existing', () => {
    test('returns the ids that are jobs of the namespace and leaves the rest out', async () => {
      const ids = await enqueueN(t.store, 2);
      const found = await t.store.deployment.existing([...ids, 'nope']);
      expect([...found].sort()).toEqual([...ids].sort());
    });

    test('an empty list is no query', async () => {
      expect((await t.store.deployment.existing([])).size).toBe(0);
    });

    test('a job of another namespace is not found', async () => {
      const other = t.another({ namespace: 'elsewhere' });
      const [job] = await other.enqueue([{ queue: 'q', data: 1 }]);
      expect((await t.store.deployment.existing([job!.id])).size).toBe(0);
    });
  });
});
