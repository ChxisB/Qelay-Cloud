import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import {
  claimOne,
  completeAndRemove,
  expireLease,
  insertGroup,
  resetTables,
} from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const BUDGET: TickBudget = {
  maxDurationMs: 60_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};
const KEEP = 2;

describeDb('tick: completion records and group state', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ maxCompletedJobs: KEEP, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const tick = (budget: Partial<TickBudget> = {}) => t.store.tick({ ...BUDGET, ...budget });
  const completions = async () =>
    (
      await t.fresh.sql<Array<{ job_id: string }>>`
        SELECT job_id FROM qcloud_completions ORDER BY completed_at`
    ).map((row) => row.job_id);
  const groups = async () =>
    (await t.fresh.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_group_state`)[0]!
      .n;

  test('prunes both, and reports no more work when it finished', async () => {
    const ids = await completeAndRemove(t, 5);
    for (let i = 0; i < 3; i++) await insertGroup(t, `g${i}`);
    expect(await tick()).toMatchObject({ moreWork: false });
    expect(await completions()).toEqual(ids.slice(-KEEP));
    expect(await groups()).toBe(0);
  });

  test('maxItems caps each prune and reports more work until both are done', async () => {
    const ids = await completeAndRemove(t, 7);
    for (let i = 0; i < 5; i++) await insertGroup(t, `g${i}`);
    expect(await tick({ maxItems: 2 })).toMatchObject({ moreWork: true });
    expect(await completions()).toHaveLength(5);
    expect(await groups()).toBe(3);
    expect(await tick({ maxItems: 2 })).toMatchObject({ moreWork: true });
    expect(await tick({ maxItems: 2 })).toMatchObject({ moreWork: false });
    expect(await completions()).toEqual(ids.slice(-KEEP));
    expect(await groups()).toBe(0);
  });

  test('a spent maxDurationMs skips both and says there is more', async () => {
    await completeAndRemove(t, 4);
    await insertGroup(t, 'g');
    expect(await tick({ maxDurationMs: 0 })).toMatchObject({ moreWork: true });
    expect(await completions()).toHaveLength(4);
    expect(await groups()).toBe(1);
  });

  test('a step that finds more work does not stop the steps after it from running', async () => {
    for (let i = 0; i < 3; i++) {
      const dead = await claimOne(t, { attempts: 3, backoff: 0 });
      expireLease(t, dead, 1);
    }
    for (let i = 0; i < 5; i++) await insertGroup(t, `g${i}`);
    // Recovery is capped at two of its three jobs and so reports more work; the prune still runs.
    const report = await tick({ maxItems: 2 });
    expect(report).toMatchObject({ recovered: 2, moreWork: true });
    expect(await groups()).toBe(3);
  });
});
