import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_HISTORY_ENTRIES } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, event, journal, KEY, outcome, POLICY } from './webhookHelpers';

describeDb('webhooks: recording attempts', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const claimOne = async () => {
    const [claimed] = await t.store.webhooks.claimDue(CLAIM);
    return claimed!;
  };
  const only = async (hookId: string) => (await t.store.webhooks.deliveries(hookId))!.items[0]!;

  test('a 2xx finishes the delivery, with its attempt in the history and no error', async () => {
    const hook = await addHook(t);
    await journal(t, [event('completed', 'q', 'j1', { state: 'completed' })]);
    const claimed = await claimOne();
    t.clock.advance(40);
    const summary = await t.store.webhooks.record(
      [outcome(claimed, { ok: true, statusCode: 204, at: t.clock.now() - 40 }, 33)],
      POLICY
    );
    expect(summary).toEqual({ delivered: 1, retrying: 0, failed: 0, stale: 0 });
    expect(await only(hook.id)).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 204,
      lastError: null,
      finishedAt: t.clock.now(),
      history: [
        { attempt: 1, at: t.clock.now() - 40, durationMs: 33, statusCode: 204, error: null },
      ],
    });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1, failureCount: 0 });
  });

  test('a failed attempt is retried after the backoff, and fails the delivery at the attempt limit', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);

    const first = await claimOne();
    await t.store.webhooks.record([outcome(first, { ok: false, statusCode: 503 })], POLICY);
    expect(await only(hook.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastStatusCode: 503,
      lastError: 'receiver answered 500',
      finishedAt: null,
      nextAttemptAt: t.clock.now() + 1_000,
    });

    t.clock.advance(1_000);
    const second = await claimOne();
    expect(second.attempt).toBe(2);
    await t.store.webhooks.record([outcome(second, { ok: false })], POLICY);
    expect((await only(hook.id)).nextAttemptAt).toBe(t.clock.now() + 2_000);

    t.clock.advance(2_000);
    const third = await claimOne();
    const summary = await t.store.webhooks.record([outcome(third, { ok: false })], POLICY);
    expect(summary).toEqual({ delivered: 0, retrying: 0, failed: 1, stale: 0 });
    expect(await only(hook.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      finishedAt: t.clock.now(),
    });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 0, failureCount: 1 });
    t.clock.advance(3_600_000);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
  });

  test('a receiver that fails twice and then answers gets exactly one delivery, with all three attempts recorded', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const answers = [
      { ok: false, statusCode: 500, error: 'receiver answered 500' },
      { ok: false, statusCode: null, error: 'timed out after 10000 ms' },
      { ok: true, statusCode: 200 },
    ];
    for (const [index, answer] of answers.entries()) {
      const claimed = await claimOne();
      expect(claimed.attempt).toBe(index + 1);
      await t.store.webhooks.record([outcome(claimed, answer)], POLICY);
      t.clock.advance(60_000);
    }
    const delivery = await only(hook.id);
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 3, lastError: null });
    expect(delivery.history.map((h) => [h.attempt, h.statusCode, h.error])).toEqual([
      [1, 500, 'receiver answered 500'],
      [2, null, 'timed out after 10000 ms'],
      [3, 200, null],
    ]);
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1, failureCount: 0 });
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
  });

  test('an outcome counts once: a repeat of it, or one for a delivery nobody holds, is stale', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const claimed = await claimOne();
    const done = outcome(claimed, { ok: true });
    expect(await t.store.webhooks.record([done, done], POLICY)).toEqual({
      delivered: 1,
      retrying: 0,
      failed: 0,
      stale: 1,
    });
    expect(await t.store.webhooks.record([done], POLICY)).toMatchObject({ delivered: 0, stale: 1 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1 });
    expect(
      await t.store.webhooks.record([{ ...done, deliveryId: '999999999' }], POLICY)
    ).toMatchObject({ stale: 1 });
  });

  test('an outcome for a webhook that was deleted meanwhile is stale', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const claimed = await claimOne();
    expect(await t.store.webhooks.delete(hook.id)).toBe(true);
    expect(await t.store.webhooks.record([outcome(claimed, { ok: true })], POLICY)).toMatchObject({
      delivered: 0,
      stale: 1,
    });
  });

  test('an error longer than the cap is cut, and the history keeps only the latest attempts', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const long = { ok: false, error: 'x'.repeat(5_000) };
    const policy = { maxAttempts: WEBHOOK_HISTORY_ENTRIES + 5, baseDelayMs: 1, maxDelayMs: 1 };
    for (let i = 0; i < WEBHOOK_HISTORY_ENTRIES + 4; i++) {
      const claimed = await claimOne();
      await t.store.webhooks.record([outcome(claimed, long)], policy);
      t.clock.advance(10);
    }
    const delivery = await only(hook.id);
    expect(delivery.attempts).toBe(WEBHOOK_HISTORY_ENTRIES + 4);
    expect(delivery.history).toHaveLength(WEBHOOK_HISTORY_ENTRIES);
    expect(delivery.history[0]!.attempt).toBe(5);
    expect(delivery.history.at(-1)!.attempt).toBe(WEBHOOK_HISTORY_ENTRIES + 4);
    expect(delivery.lastError!.length).toBeLessThanOrEqual(500);
    expect(delivery.history.every((h) => h.error!.length <= 500)).toBe(true);
  });

  test('a manual retry gives a failed delivery a full budget while attempt numbers keep rising', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    for (let i = 0; i < POLICY.maxAttempts; i++) {
      t.clock.advance(60_000);
      await t.store.webhooks.record([outcome(await claimOne(), { ok: false })], POLICY);
    }
    const failed = await only(hook.id);
    expect(failed.status).toBe('failed');

    const retried = await t.store.webhooks.retry(hook.id, failed.id);
    expect(retried).toMatchObject({
      outcome: 'retried',
      delivery: { status: 'pending', finishedAt: null },
    });
    for (let i = 1; i <= POLICY.maxAttempts; i++) {
      t.clock.advance(60_000);
      const claimed = await claimOne();
      expect(claimed.attempt).toBe(POLICY.maxAttempts + i);
      const summary = await t.store.webhooks.record([outcome(claimed, { ok: false })], POLICY);
      expect(summary.failed).toBe(i === POLICY.maxAttempts ? 1 : 0);
    }
    expect(await only(hook.id)).toMatchObject({
      status: 'failed',
      attempts: 2 * POLICY.maxAttempts,
    });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ failureCount: 2 });
  });

  test('retry refuses a delivery that is not failed, and one that is not there', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const [pending] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(await t.store.webhooks.retry(hook.id, pending!.id)).toEqual({
      outcome: 'not_failed',
      status: 'pending',
    });
    expect(await t.store.webhooks.retry(hook.id, '424242')).toEqual({ outcome: 'not_found' });
    expect(await t.store.webhooks.retry('nope', pending!.id)).toEqual({ outcome: 'not_found' });
  });

  test('an empty list of outcomes records nothing', async () => {
    expect(await t.store.webhooks.record([], POLICY)).toEqual({
      delivered: 0,
      retrying: 0,
      failed: 0,
      stale: 0,
    });
  });
});
