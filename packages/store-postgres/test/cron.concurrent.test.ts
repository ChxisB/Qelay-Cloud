import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const MINUTE = 60_000;
const CRONS = 30;
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('crons: concurrent callers and the tick', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_crons, qcloud_workers`;
  });

  const define = (count: number, queue = 'cq') =>
    Promise.all(
      Array.from({ length: count }, (_, n) =>
        t.store.crons.upsert({
          name: `c${String(n).padStart(2, '0')}`,
          queue,
          repeatEvery: MINUTE,
          preventOverlap: false,
          data: n,
        })
      )
    );
  const jobCount = async () =>
    Number((await t.fresh.sql<{ n: string }[]>`SELECT count(*) AS n FROM qcloud_jobs`)[0]!.n);
  const executions = async () => (await t.store.crons.list()).map((cron) => cron.executions);
  const stores = () => [t.store, t.another(), t.another(), t.another()];

  test('four concurrent claimDue produce each occurrence exactly once', async () => {
    await define(CRONS);
    for (let round = 1; round <= 5; round++) {
      t.clock.advance(MINUTE);
      const firings = await Promise.all(stores().map((store) => store.crons.claimDue(100)));
      expect(firings.reduce((sum, firing) => sum + firing.fired, 0)).toBe(CRONS);
      expect(firings.reduce((sum, firing) => sum + firing.rings.length, 0)).toBe(CRONS);
      expect(await jobCount()).toBe(CRONS * round);
      expect(await executions()).toEqual(Array(CRONS).fill(round));
    }
  });

  test('with a small limit the callers take disjoint crons and finish them all', async () => {
    await define(CRONS);
    t.clock.advance(MINUTE);
    let fired = 0;
    for (let pass = 0; pass < 10 && fired < CRONS; pass++) {
      const firings = await Promise.all(stores().map((store) => store.crons.claimDue(7)));
      fired += firings.reduce((sum, firing) => sum + firing.fired, 0);
    }
    expect(fired).toBe(CRONS);
    expect(await jobCount()).toBe(CRONS);
    expect(await executions()).toEqual(Array(CRONS).fill(1));
  });

  test('four concurrent ticks fire each cron once', async () => {
    await define(CRONS);
    t.clock.advance(MINUTE);
    const reports = await Promise.all(stores().map((store) => store.tick(BUDGET)));
    expect(reports.reduce((sum, report) => sum + report.cronFired, 0)).toBe(CRONS);
    expect(await jobCount()).toBe(CRONS);
    expect(await executions()).toEqual(Array(CRONS).fill(1));
  });

  test('with preventOverlap, concurrent callers still leave one live job per cron', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        t.store.crons.upsert({ name: `o${n}`, queue: 'cq', repeatEvery: MINUTE })
      )
    );
    for (let round = 0; round < 3; round++) {
      t.clock.advance(MINUTE);
      await Promise.all(stores().map((store) => store.crons.claimDue(100)));
    }
    expect(await jobCount()).toBe(10);
    expect(await executions()).toEqual(Array(10).fill(1));
  });

  describe('as a step of the tick', () => {
    test('the report counts the crons fired, and rings their jobs even inside the grace', async () => {
      await define(3);
      t.clock.advance(MINUTE);
      const report = await t.store.tick({ ...BUDGET, ringGraceMs: 600_000 });
      expect(report.cronFired).toBe(3);
      expect(report.rings).toHaveLength(3);
      expect(report.rings.every((ring) => ring.dueInMs === 0)).toBe(true);
    });

    test('a job the tick created and the ring query also finds is listed once', async () => {
      await define(3);
      t.clock.advance(MINUTE);
      const { rings } = await t.store.tick(BUDGET);
      expect(rings).toHaveLength(3);
      expect(new Set(rings.map((ring) => ring.bell.jobId)).size).toBe(3);
    });

    test('until it is reported, the next tick rings the job again by the ordinary rule', async () => {
      await define(1);
      t.clock.advance(MINUTE);
      const first = await t.store.tick(BUDGET);
      await t.store.markRung(
        first.rings.map((ring) => ({ jobId: ring.bell.jobId!, deliverAfterMs: 0 }))
      );
      expect((await t.store.tick(BUDGET)).rings).toEqual([]);
    });

    test('a spent maxDurationMs skips the crons and says there is more work', async () => {
      await define(2);
      t.clock.advance(MINUTE);
      expect(await t.store.tick({ ...BUDGET, maxDurationMs: 0 })).toMatchObject({
        cronFired: 0,
        moreWork: true,
      });
      expect(await jobCount()).toBe(0);
    });

    test('maxItems caps the crons of one tick and reports more work', async () => {
      await define(5);
      t.clock.advance(MINUTE);
      expect(await t.store.tick({ ...BUDGET, maxItems: 2 })).toMatchObject({
        cronFired: 2,
        moreWork: true,
      });
      expect(await t.store.tick({ ...BUDGET, maxItems: 2 })).toMatchObject({ cronFired: 2 });
      expect(await t.store.tick({ ...BUDGET, maxItems: 2 })).toMatchObject({
        cronFired: 1,
        moreWork: false,
      });
    });

    test('a cron that fires is not due again in the same tick of a different caller', async () => {
      await define(1);
      t.clock.advance(MINUTE);
      await t.store.tick(BUDGET);
      expect(await t.another().tick(BUDGET)).toMatchObject({ cronFired: 0 });
    });

    test('also expires workers that stopped heartbeating', async () => {
      await t.store.workers.register({ id: 'gone', queues: ['cq'] });
      await t.store.workers.register({ id: 'alive', queues: ['cq'] });
      t.clock.advance(60_000);
      await t.store.workers.heartbeat('alive');
      t.clock.advance(60_000);
      await t.store.tick(BUDGET);
      expect((await t.store.workers.list()).map((worker) => worker.id)).toEqual(['alive']);
    });
  });
});
