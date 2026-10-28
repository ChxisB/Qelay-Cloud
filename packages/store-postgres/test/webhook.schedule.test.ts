import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_SCHEDULE_GAP_MS, nextFire } from '../src/store/webhookSchedule';
import { resetTables } from './finishHelpers';
import { requestDeliveries } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';
import { addHook, CLAIM, hookSource, KEY, send } from './webhookHelpers';

const HOUR = 3_600_000;
const NIGHTLY = { cron: '0 0 * * *', timezone: 'Europe/London' };
// START is Friday 2027-01-15 08:00 UTC, which is 08:00 in London (GMT).
const MIDNIGHT_WINTER = Date.UTC(2027, 0, 16, 0, 0);

describeDb('webhooks: send schedule and batch fields', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    rewind(t);
    await resetTables(t);
  });

  const goTo = (at: number) => t.clock.advance(at - t.clock.now());
  const dueTimes = async () => (await requestDeliveries(t)).map((d) => Number(d.next_attempt_at));
  const refused = async (run: Promise<unknown>, option: string) => {
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect((error as UnsupportedOptionError).option).toBe(option);
  };

  test('a route with no schedule is due when its request is taken', async () => {
    await addHook(t);
    await send(t);
    expect(await dueTimes()).toEqual([t.clock.now()]);
  });

  test('a nightly route holds its delivery until the next midnight in its zone, in winter and in summer', async () => {
    expect(START).toBe(Date.UTC(2027, 0, 15, 8, 0));
    await addHook(t, { schedule: NIGHTLY });
    await send(t);
    expect(await dueTimes()).toEqual([MIDNIGHT_WINTER]);

    // 12:00 UTC on 1 July is 13:00 in London (BST): its midnight is 23:00 UTC.
    goTo(Date.UTC(2027, 6, 1, 12, 0));
    await send(t, { n: 2 });
    expect((await dueTimes()).at(-1)).toBe(Date.UTC(2027, 6, 1, 23, 0));
  });

  test('a request taken at the fire time is due then, and the delay comes before the schedule', async () => {
    await addHook(t, { schedule: NIGHTLY });
    goTo(MIDNIGHT_WINTER);
    await send(t);
    expect(await dueTimes()).toEqual([MIDNIGHT_WINTER]);

    // 23:30 UTC plus an hour is 00:30: the fire is the midnight after that one.
    await resetTables(t);
    await addHook(t, { schedule: NIGHTLY, delayMs: HOUR });
    goTo(Date.UTC(2027, 0, 20, 23, 30));
    await send(t);
    expect(await dueTimes()).toEqual([Date.UTC(2027, 0, 22, 0, 0)]);
  });

  test('the sender gets the delivery at the fire, and a wait of more than a day does not expire it', async () => {
    await addHook(t, { schedule: { cron: '0 0 * * 0', timezone: 'UTC' } });
    await send(t);
    const fire = Date.UTC(2027, 0, 17, 0, 0);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);

    // 36 hours held: past the 24 hours a delivery lives, which count from the due time, not from the request.
    goTo(START + 36 * HOUR);
    expect(await t.store.webhooks.prune(100)).toMatchObject({ expired: 0 });
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);

    goTo(fire);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
  });

  test('a queue route can be scheduled, and its job waits the same way', async () => {
    const route = await t.store.webhooks.create(
      {
        destination: 'queue',
        target: 'nightly-jobs',
        source: await hookSource(t),
        schedule: NIGHTLY,
      },
      'tester'
    );
    expect(route).toMatchObject({ destination: 'queue', schedule: NIGHTLY, batch: null });
    await send(t);
    expect(await dueTimes()).toEqual([MIDNIGHT_WINTER]);
  });

  test('a schedule that cannot be read, never fires or fires less than monthly is refused by name', async () => {
    const source = await hookSource(t);
    const create = (schedule: unknown) =>
      t.store.webhooks.create(
        { url: 'https://hooks.example.com/in', source, schedule: schedule as never },
        'tester'
      );
    await refused(create({ cron: 'not a cron' }), 'schedule');
    await refused(create({ cron: '0 0 31 2 *' }), 'schedule');
    await refused(create({ cron: '@yearly' }), 'schedule');
    await refused(create({ cron: '0 0 * * *', timezone: 'Mars/Olympus' }), 'schedule');
    await refused(create({ cron: '0 0 * * *', extra: 1 }), 'schedule');
    expect(await t.store.webhooks.list()).toEqual([]);
    // 31 days between two fires is the longest allowed.
    expect(await create({ cron: '@monthly' })).toMatchObject({
      schedule: { cron: '@monthly', timezone: 'UTC' },
    });
  });

  test('nextFire is the first fire at or after the time, and 0 when there is none', () => {
    const daily = { cron: '@daily', timezone: 'UTC' };
    expect(nextFire(daily, Date.UTC(2027, 0, 16, 0, 0))).toBe(Date.UTC(2027, 0, 16, 0, 0));
    expect(nextFire(daily, Date.UTC(2027, 0, 16, 0, 0, 1))).toBe(Date.UTC(2027, 0, 17, 0, 0));
    expect(MAX_SCHEDULE_GAP_MS).toBe(31 * 24 * HOUR);
  });

  test('a batch needs an http route, takes its defaults and is stored with the schedule', async () => {
    const source = await hookSource(t);
    const batched = await addHook(t, { schedule: NIGHTLY, batch: { maxEvents: 50 } as never });
    expect(batched).toMatchObject({
      schedule: NIGHTLY,
      batch: { maxEvents: 50, maxBytes: 262_144 },
    });
    expect(await t.store.webhooks.get(batched.id)).toEqual(
      expect.objectContaining({ schedule: NIGHTLY, batch: { maxEvents: 50, maxBytes: 262_144 } })
    );
    await refused(
      t.store.webhooks.create(
        { destination: 'queue', target: 'jobs', source, batch: { maxEvents: 5 } as never },
        'tester'
      ),
      'batch'
    );
    await refused(addHook(t, { batch: { maxEvents: 0 } as never }), 'batch');
  });

  test('update sets, changes and clears the schedule and the batch, and leaves deliveries made before as they were', async () => {
    const hook = await addHook(t);
    await send(t);
    const [before] = await dueTimes();

    const set = await t.store.webhooks.update(hook.id, {
      schedule: NIGHTLY,
      batch: { maxEvents: 20, maxBytes: 4_096 },
    });
    expect(set).toMatchObject({ schedule: NIGHTLY, batch: { maxEvents: 20, maxBytes: 4_096 } });
    expect(await t.store.webhooks.get(hook.id)).toEqual(set);
    await send(t, { n: 2 });
    expect(await dueTimes()).toEqual([before!, MIDNIGHT_WINTER]);

    const cleared = await t.store.webhooks.update(hook.id, { schedule: null });
    expect(cleared).toMatchObject({ schedule: null, batch: { maxEvents: 20, maxBytes: 4_096 } });
    expect(await t.store.webhooks.update(hook.id, { batch: null })).toMatchObject({
      schedule: null,
      batch: null,
    });
    expect(await dueTimes()).toEqual([before!, MIDNIGHT_WINTER]);

    await refused(
      t.store.webhooks.update(hook.id, { schedule: { cron: 'nope' } as never }),
      'schedule'
    );
    const queue = await t.store.webhooks.create(
      { destination: 'queue', target: 'jobs', source: await hookSource(t) },
      'tester'
    );
    await refused(
      t.store.webhooks.update(queue.id, { batch: { maxEvents: 5, maxBytes: 4_096 } }),
      'batch'
    );
    expect(await t.store.webhooks.update(queue.id, { schedule: NIGHTLY })).toMatchObject({
      schedule: NIGHTLY,
    });
  });
});
