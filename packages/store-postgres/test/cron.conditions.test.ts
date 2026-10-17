import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { CronSpec } from '../src/cron/types';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const MINUTE = 60_000;
const EVERY_MINUTE: CronSpec = { name: 'tick', queue: 'cq', repeatEvery: MINUTE };

describeDb('crons: conditions', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_crons, qcloud_workers`;
  });

  const jobsOf = (queue = 'cq') =>
    t.store.listJobs({ queue, limit: 1000 }).then((page) => page.items);
  const cron = async (name = 'tick') => (await t.store.crons.get(name))!;

  describe('skipIfNoWorker', () => {
    test('skips, uncounted, while no worker serves the queue, and moves next_run on', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, skipIfNoWorker: true });
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0, skipped: 1 });
      expect(await jobsOf()).toEqual([]);
      expect(await cron()).toMatchObject({ executions: 0, nextRun: START + 2 * MINUTE });
    });

    test('fires when a worker for the queue has a recent heartbeat', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, skipIfNoWorker: true });
      await t.store.workers.register({ id: 'w1', queues: ['cq', 'other'] });
      t.clock.advance(MINUTE);
      await t.store.workers.heartbeat('w1');
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
    });

    test('a worker that stopped heartbeating does not count', async () => {
      await t.store.crons.upsert({ ...EVERY_MINUTE, skipIfNoWorker: true });
      await t.store.workers.register({ id: 'w1', queues: ['cq'] });
      t.clock.advance(MINUTE);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 0, skipped: 1 });
    });

    test('a worker for another queue does not count, and the other crons are unaffected', async () => {
      await t.store.workers.register({ id: 'w1', queues: ['elsewhere'] });
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'needs', skipIfNoWorker: true });
      await t.store.crons.upsert({ ...EVERY_MINUTE, name: 'free', queue: 'fq' });
      t.clock.advance(MINUTE - 1_000);
      await t.store.workers.heartbeat('w1');
      t.clock.advance(1_000);
      expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1, skipped: 1 });
      expect(await jobsOf('fq')).toHaveLength(1);
      expect(await jobsOf('cq')).toEqual([]);
    });
  });

  describe('time zones', () => {
    const setTo = (iso: string) => t.clock.advance(Date.parse(iso) - t.clock.now());
    const NY = 'America/New_York';

    test('a schedule is read in its zone', async () => {
      setTo('2027-06-01T00:00:00Z');
      const created = await t.store.crons.upsert({
        name: 'ny',
        queue: 'cq',
        schedule: '0 9 * * *',
        timezone: NY,
      });
      expect(new Date(created.nextRun).toISOString()).toBe('2027-06-01T13:00:00.000Z');
    });

    test('spring forward: a time that does not exist fires once that day, then the next', async () => {
      setTo('2027-03-13T12:00:00Z');
      await t.store.crons.upsert({
        name: 'ny',
        queue: 'cq',
        schedule: '30 2 * * *',
        timezone: NY,
        preventOverlap: false,
      });
      const fired: string[] = [];
      for (let n = 0; n < 4; n++) {
        const due = (await cron('ny')).nextRun;
        fired.push(new Date(due).toISOString());
        setTo(new Date(due).toISOString());
        expect(await t.store.crons.claimDue()).toMatchObject({ fired: 1 });
      }
      expect(fired.slice(0, 2)).toEqual(['2027-03-14T07:30:00.000Z', '2027-03-15T06:30:00.000Z']);
      expect(await jobsOf()).toHaveLength(4);
    });

    test('fall back: a repeated hour fires once, then the next day', async () => {
      setTo('2027-11-06T12:00:00Z');
      await t.store.crons.upsert({
        name: 'ny',
        queue: 'cq',
        schedule: '30 1 * * *',
        timezone: NY,
        preventOverlap: false,
      });
      const fired: string[] = [];
      for (let n = 0; n < 3; n++) {
        const due = (await cron('ny')).nextRun;
        fired.push(new Date(due).toISOString());
        setTo(new Date(due).toISOString());
        await t.store.crons.claimDue();
      }
      expect(fired).toEqual([
        '2027-11-07T05:30:00.000Z',
        '2027-11-08T06:30:00.000Z',
        '2027-11-09T06:30:00.000Z',
      ]);
      expect(await jobsOf()).toHaveLength(3);
    });

    test('an hourly schedule is continuous across the change', async () => {
      setTo('2027-03-14T05:00:00Z');
      await t.store.crons.upsert({
        name: 'h',
        queue: 'cq',
        schedule: '0 * * * *',
        timezone: NY,
        preventOverlap: false,
      });
      const hours: number[] = [];
      for (let n = 0; n < 5; n++) {
        const due = (await cron('h')).nextRun;
        hours.push(due);
        setTo(new Date(due).toISOString());
        await t.store.crons.claimDue();
      }
      expect(hours.slice(1).map((at, index) => at - hours[index]!)).toEqual(
        Array(4).fill(3_600_000)
      );
    });
  });
});
