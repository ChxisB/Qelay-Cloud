import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { CronSpec } from '../src/cron/types';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const MINUTE = 60_000;
const BASE: CronSpec = { name: 'report', queue: 'reports', repeatEvery: MINUTE, data: { n: 1 } };

describeDb('crons: definitions', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_crons`;
  });

  test('upsert returns the stored record, and get and list read it back', async () => {
    const created = await t.store.crons.upsert({ ...BASE, priority: 2, maxLimit: 5 });
    expect(created).toMatchObject({
      name: 'report',
      queue: 'reports',
      jobName: 'default',
      data: { n: 1 },
      schedule: null,
      repeatEvery: MINUTE,
      timezone: null,
      priority: 2,
      maxLimit: 5,
      uniqueKey: null,
      preventOverlap: true,
      skipIfNoWorker: false,
      nextRun: START + MINUTE,
      executions: 0,
      updatedAt: START,
    });
    expect(await t.store.crons.get('report')).toEqual(created);
    expect(await t.store.crons.list()).toEqual([created]);
    expect(await t.store.crons.get('nope')).toBeNull();
  });

  test('list is ordered by name and holds only this namespace', async () => {
    await t.store.crons.upsert({ ...BASE, name: 'b' });
    await t.store.crons.upsert({ ...BASE, name: 'a' });
    const other = t.another({ namespace: 'other' });
    await other.crons.upsert({ ...BASE, name: 'c' });
    expect((await t.store.crons.list()).map((cron) => cron.name)).toEqual(['a', 'b']);
    expect((await other.crons.list()).map((cron) => cron.name)).toEqual(['c']);
  });

  test('delete says whether there was a cron, and leaves the jobs it made', async () => {
    await t.store.crons.upsert({ ...BASE, immediately: true });
    await t.store.crons.claimDue();
    expect(await t.store.crons.delete('report')).toBe(true);
    expect(await t.store.crons.delete('report')).toBe(false);
    expect(await t.store.counts('reports')).toMatchObject({ waiting: 1 });
  });

  test('a cron schedule gets its first run from now', async () => {
    const cron = await t.store.crons.upsert({ name: 'daily', queue: 'q', schedule: '@daily' });
    expect(cron.nextRun).toBeGreaterThan(START);
    expect(cron.nextRun % 86_400_000).toBe(0);
    expect(cron.nextRun - START).toBeLessThanOrEqual(86_400_000);
  });

  test('a six-field schedule with leading seconds is accepted', async () => {
    const cron = await t.store.crons.upsert({ name: 's', queue: 'q', schedule: '*/15 * * * * *' });
    expect(cron.nextRun - START).toBeLessThanOrEqual(15_000);
    expect(cron.nextRun % 15_000).toBe(0);
  });

  test('re-upserting unchanged timing keeps next_run and executions', async () => {
    await t.store.crons.upsert({ ...BASE, immediately: true });
    await t.store.crons.claimDue();
    const fired = await t.store.crons.get('report');
    expect(fired).toMatchObject({ executions: 1, nextRun: START + MINUTE });
    t.clock.advance(10_000);
    const again = await t.store.crons.upsert({ ...BASE, data: { n: 2 }, priority: 3 });
    expect(again).toMatchObject({
      data: { n: 2 },
      priority: 3,
      executions: 1,
      nextRun: START + MINUTE,
      updatedAt: START + 10_000,
    });
  });

  test('changing the timing recomputes next_run from now, and keeps executions', async () => {
    await t.store.crons.upsert({ ...BASE, immediately: true });
    await t.store.crons.claimDue();
    t.clock.advance(10_000);
    const changed = await t.store.crons.upsert({ ...BASE, repeatEvery: 5 * MINUTE });
    expect(changed).toMatchObject({ executions: 1, nextRun: START + 10_000 + 5 * MINUTE });
  });

  test('immediately makes a new cron due now, not a replaced one', async () => {
    expect(await t.store.crons.upsert({ ...BASE, immediately: true })).toMatchObject({
      nextRun: START,
    });
    t.clock.advance(1_000);
    expect(
      await t.store.crons.upsert({ ...BASE, repeatEvery: 2 * MINUTE, immediately: true })
    ).toMatchObject({ nextRun: START + 1_000 + 2 * MINUTE });
  });

  test('lowering maxLimit to the executions closes the cron', async () => {
    await t.store.crons.upsert({ ...BASE, immediately: true });
    await t.store.crons.claimDue();
    await t.store.crons.upsert({ ...BASE, maxLimit: 1 });
    t.clock.advance(MINUTE);
    expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0 });
  });

  test.each<[string, Partial<CronSpec>, string]>([
    ['neither schedule nor repeatEvery', { repeatEvery: undefined }, 'schedule'],
    ['both schedule and repeatEvery', { schedule: '* * * * *' }, 'schedule'],
    ['a zero interval', { repeatEvery: 0 }, 'repeatEvery'],
    ['a fractional interval', { repeatEvery: 1.5 }, 'repeatEvery'],
    ['an interval past a year', { repeatEvery: 366 * 86_400_000 }, 'repeatEvery'],
    ['a timezone on an interval', { timezone: 'UTC' }, 'timezone'],
    ['a bad expression', { repeatEvery: undefined, schedule: 'not a cron' }, 'schedule'],
    ['five fields of nonsense', { repeatEvery: undefined, schedule: '99 * * * *' }, 'schedule'],
    [
      'an unknown time zone',
      { repeatEvery: undefined, schedule: '* * * * *', timezone: 'Mars/Base' },
      'schedule',
    ],
    [
      'a schedule with no future occurrence',
      { repeatEvery: undefined, schedule: '0 0 31 2 *' },
      'schedule',
    ],
    ['a blank name', { name: '' }, 'name'],
    ['a blank queue', { queue: '' }, 'queue'],
    ['a zero maxLimit', { maxLimit: 0 }, 'maxLimit'],
    ['a fractional maxLimit', { maxLimit: 1.5 }, 'maxLimit'],
    ['a template key that is not allowed', { jobOptions: { priority: 1 } as never }, 'jobOptions'],
    ['a bad template value', { jobOptions: { attempts: 0 } }, 'attempts'],
    [
      'dedup with no key and overlap allowed',
      { preventOverlap: false, dedup: { ttl: 1 } },
      'dedup',
    ],
    ['a non-boolean flag', { skipIfNoWorker: 'yes' as never }, 'skipIfNoWorker'],
    ['data that does not fit', { data: 'x'.repeat(2_000_000) }, ''],
  ])('rejects %s, and stores nothing', async (_label, patch, mention) => {
    const error = await t.store.crons.upsert({ ...BASE, ...patch }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    if (mention) {
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect(error.message).toContain(mention);
    }
    expect(await t.store.crons.list()).toEqual([]);
  });
});
