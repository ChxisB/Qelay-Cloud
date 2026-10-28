import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const MINUTE = 60_000;
const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 200,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('crons: hundreds due in the same minute', () => {
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

  const define = async (count: number, queues: number) => {
    for (let from = 0; from < count; from += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, count - from) }, (_, k) => {
          const n = from + k;
          return t.store.crons.upsert({
            name: `c${String(n).padStart(4, '0')}`,
            queue: `q${n % queues}`,
            repeatEvery: MINUTE,
            preventOverlap: false,
            data: n,
          });
        })
      );
    }
  };
  const jobCount = async () =>
    Number((await t.fresh.sql<{ n: string }[]>`SELECT count(*) AS n FROM qcloud_jobs`)[0]!.n);

  for (const [count, queues] of [
    [250, 1],
    [250, 25],
    [1000, 50],
  ] as const) {
    test(`${count} crons on ${queues} queue(s): every one fires once, tick after tick`, async () => {
      await define(count, queues);
      for (let minute = 1; minute <= 3; minute++) {
        t.clock.advance(MINUTE);
        let fired = 0;
        let passes = 0;
        let more = true;
        while (more) {
          const report = await t.store.tick(BUDGET);
          fired += report.cronFired;
          more = report.moreWork;
          passes += 1;
        }
        expect(fired).toBe(count);
        // maxItems crons a pass: the catch-up is a bounded number of passes, not a growing one.
        expect(passes).toBeLessThanOrEqual(Math.ceil(count / BUDGET.maxItems) + 1);
        expect(await jobCount()).toBe(count * minute);
      }
      const runs = (await t.store.crons.list()).map((cron) => cron.executions);
      expect(runs).toEqual(Array(count).fill(3));
    }, 120_000);
  }
});
