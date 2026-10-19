import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome } from './webhookHelpers';

/** One attempt per delivery, so a failed attempt is a failed delivery; the third in a row pauses. */
const POLICY = { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 60_000, disableAfter: 3 };

describeDb('webhooks: pausing after failed deliveries in a row', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, random: () => 0.5 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** Sends one event through to a recorded result; returns the record summary. */
  const run = async (ok: boolean, jobId: string) => {
    await journal(t, [event('pushed', 'q', jobId)]);
    const [claimed] = await t.store.webhooks.claimDue({ ...CLAIM, limit: 1 });
    return t.store.webhooks.record([outcome(claimed!, { ok })], POLICY);
  };

  test('the streak raises the alert level, and its last step pauses the webhook', async () => {
    const hook = await addHook(t);
    expect(await run(false, 'a')).toMatchObject({ failed: 1, paused: 0 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      consecutiveFailures: 1,
      alertLevel: 0,
      enabled: true,
    });
    await run(false, 'b');
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      consecutiveFailures: 2,
      alertLevel: 1,
    });
    t.clock.advance(5);
    expect(await run(false, 'c')).toMatchObject({ failed: 1, paused: 1 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      consecutiveFailures: 3,
      alertLevel: 4,
      enabled: false,
      disabledReason: '3 failed deliveries in a row',
      disabledAt: t.clock.now(),
    });
    await journal(t, [event('pushed', 'q', 'd')]);
    expect(await t.store.webhooks.claimDue(CLAIM)).toEqual([]);
  });

  test('a delivered one resets the streak, and the order inside one batch counts', async () => {
    const hook = await addHook(t);
    await run(false, 'a');
    await run(false, 'b');
    expect(await run(true, 'c')).toMatchObject({ delivered: 1, paused: 0 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      consecutiveFailures: 0,
      alertLevel: 0,
    });
    // Fail, fail, deliver, fail in one batch: the streak ends at 1, so nothing pauses.
    await journal(
      t,
      ['a', 'b', 'c', 'd'].map((id) => event('pushed', 'q', id))
    );
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    const results = [false, false, true, false];
    const summary = await t.store.webhooks.record(
      claimed.map((c, i) => outcome(c, { ok: results[i]! })),
      POLICY
    );
    expect(summary).toMatchObject({ delivered: 1, failed: 3, paused: 0 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ consecutiveFailures: 1 });
  });

  test('a paused webhook keeps collecting deliveries; enabling it sends them and clears the pause', async () => {
    const hook = await addHook(t);
    for (const id of ['a', 'b', 'c']) await run(false, id);
    await journal(t, [event('pushed', 'q', 'held')]);
    expect((await t.store.webhooks.deliveries(hook.id))!.items[0]).toMatchObject({
      jobId: 'held',
      status: 'pending',
    });
    expect(await t.store.webhooks.setEnabled(hook.id, true)).toMatchObject({
      enabled: true,
      consecutiveFailures: 0,
      alertLevel: 0,
      disabledReason: null,
      disabledAt: null,
    });
    expect(await t.store.webhooks.claimDue(CLAIM)).toMatchObject([{ jobId: 'held' }]);
  });

  test('disabling by hand is not a pause: it carries no reason, and late results do not pause it', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed', 'q', 'a')]);
    const [claimed] = await t.store.webhooks.claimDue(CLAIM);
    expect(await t.store.webhooks.setEnabled(hook.id, false)).toMatchObject({
      enabled: false,
      disabledReason: null,
    });
    await t.store.webhooks.record([outcome(claimed!, { ok: false })], {
      ...POLICY,
      disableAfter: 1,
    });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      enabled: false,
      disabledReason: null,
    });
  });

  test('disableAfter 0 never pauses', async () => {
    const hook = await addHook(t);
    await journal(
      t,
      ['a', 'b', 'c'].map((id) => event('pushed', 'q', id))
    );
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    const summary = await t.store.webhooks.record(
      claimed.map((c) => outcome(c, { ok: false })),
      { ...POLICY, disableAfter: 0 }
    );
    expect(summary).toMatchObject({ failed: 3, paused: 0 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({
      consecutiveFailures: 3,
      alertLevel: 0,
      enabled: true,
    });
  });
});
