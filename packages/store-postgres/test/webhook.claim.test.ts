import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { ABANDONED_ERROR, RATE_WINDOW_MS } from '../src/store/webhookClaim';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import {
  addHook,
  CLAIM,
  event,
  journal,
  KEY,
  outcome,
  POLICY,
  rawDeliveries,
  SECRET,
} from './webhookHelpers';

describeDb('webhooks: claiming deliveries', () => {
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

  test('a claim takes what is due, leases it, and carries the journal detail and the secret', async () => {
    const hook = await addHook(t, { secret: SECRET });
    await journal(t, [
      event('pushed', 'q', 'a'),
      event('failed', 'q', 'b', { state: 'failed', error: 'boom' }),
      event('progress', 'q', 'c', { state: 'active', progress: 40 }),
    ]);
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    expect(claimed.map((c) => [c.event, c.jobId, c.state, c.error, c.progress])).toEqual([
      ['job.pushed', 'a', 'waiting', null, null],
      ['job.failed', 'b', 'failed', 'boom', null],
      ['job.progress', 'c', 'active', null, 40],
    ]);
    expect(
      claimed.every((c) => c.attempt === 1 && c.secret === SECRET && !c.secretUnreadable)
    ).toBe(true);
    expect(claimed.every((c) => c.webhookId === hook.id && c.url === hook.url)).toBe(true);
    const rows = await rawDeliveries(t);
    expect(rows.map((r) => [r.status, r.attempts, Number(r.next_attempt_at)])).toEqual(
      rows.map(() => ['sending', 1, t.clock.now() + CLAIM.leaseMs])
    );
    expect((await t.store.webhooks.get(hook.id))!.lastTriggered).toBe(t.clock.now());
  });

  test('a delivery is claimed once: not while its lease runs, and not before it is due', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
    t.clock.advance(CLAIM.leaseMs - 1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
  });

  test('a delivery whose lease lapsed is taken again, noted as abandoned, and its late result is stale', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    const [first] = await t.store.webhooks.claimDue(CLAIM);
    t.clock.advance(CLAIM.leaseMs);
    const [second] = await t.store.webhooks.claimDue(CLAIM);
    expect(second).toMatchObject({ deliveryId: first!.deliveryId, attempt: 2 });
    const late = await t.store.webhooks.record([outcome(first!, { ok: true })], POLICY);
    expect(late).toEqual({ delivered: 0, retrying: 0, failed: 0, stale: 1 });
    expect(await t.store.webhooks.record([outcome(second!, { ok: true })], POLICY)).toMatchObject({
      delivered: 1,
    });
    const [delivery] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(delivery!.history.map((h) => [h.attempt, h.statusCode, h.error])).toEqual([
      [1, null, ABANDONED_ERROR],
      [2, 200, null],
    ]);
  });

  test('a disabled webhook is not served, and is again once enabled', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    await t.store.webhooks.setEnabled(hook.id, false);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
    await t.store.webhooks.setEnabled(hook.id, true);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
  });

  test('a retry waits for its time', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    const [c] = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record([outcome(c!, { ok: false })], POLICY);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
    t.clock.advance(POLICY.baseDelayMs - 1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(0);
    t.clock.advance(1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toMatchObject([{ attempt: 2 }]);
  });

  test('a webhook gets at most ratePerMinute attempts in a minute, and the count starts over in the next', async () => {
    const hook = await addHook(t);
    await journal(
      t,
      Array.from({ length: 5 }, (_, i) => event('pushed', 'q', `j${i}`))
    );
    const rate = { ...CLAIM, ratePerMinute: 2 };
    expect(await t.store.webhooks.claimDue(rate)).toHaveLength(2);
    expect(await t.store.webhooks.claimDue(rate)).toHaveLength(0);
    t.clock.advance(RATE_WINDOW_MS);
    expect(await t.store.webhooks.claimDue(rate)).toHaveLength(2);
    expect((await t.store.webhooks.get(hook.id))!.lastTriggered).toBe(t.clock.now());
  });

  test('the limit caps one claim, and a backlog does not take every slot from another webhook', async () => {
    const busy = await addHook(t, { queue: 'busy' });
    const quiet = await addHook(t, { queue: 'quiet' });
    await journal(
      t,
      Array.from({ length: 10 }, (_, i) => event('pushed', 'busy', `b${i}`))
    );
    t.clock.advance(5);
    await journal(t, [event('pushed', 'quiet', 'q0')]);
    const claimed = await t.store.webhooks.claimDue({ ...CLAIM, limit: 3 });
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((c) => c.webhookId))).toEqual(new Set([busy.id, quiet.id]));
    expect(claimed.filter((c) => c.webhookId === busy.id).map((c) => c.jobId)).toEqual([
      'b0',
      'b1',
    ]);
  });

  test('a signed webhook whose secret cannot be opened is flagged, never sent unsigned', async () => {
    await addHook(t, { secret: SECRET });
    await journal(t, [event('pushed')]);
    const wrongKey = t.another({ webhookKey: 'ff'.repeat(32) });
    expect(await wrongKey.webhooks.claimDue(CLAIM)).toMatchObject([
      { secret: null, secretUnreadable: true },
    ]);
    t.clock.advance(CLAIM.leaseMs);
    const keyless = t.another({ webhookKey: undefined as never });
    expect(await keyless.webhooks.claimDue(CLAIM)).toMatchObject([
      { secret: null, secretUnreadable: true },
    ]);
  });

  test('an unsigned webhook carries no secret and is not flagged', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    expect(await t.store.webhooks.claimDue(CLAIM)).toMatchObject([
      { secret: null, secretUnreadable: false },
    ]);
  });

  test('an event the journal has already trimmed is delivered without its detail', async () => {
    await addHook(t);
    await journal(t, [event('failed', 'q', 'b', { state: 'failed', error: 'boom' })]);
    await t.fresh.sql`DELETE FROM qcloud_events`;
    expect(await t.store.webhooks.claimDue(CLAIM)).toMatchObject([
      { event: 'job.failed', jobId: 'b', state: null, error: null, progress: null },
    ]);
  });

  test('a test delivery is claimed like any other', async () => {
    const hook = await addHook(t, { events: ['job.progress'] });
    await t.store.webhooks.sendTest(hook.id);
    expect(await t.store.webhooks.claimDue(CLAIM)).toMatchObject([
      { event: 'webhook.test', queue: 'webhook-test', jobId: 'webhook-test', state: null },
    ]);
  });

  test.each([
    ['limit', { limit: 0 }],
    ['leaseMs', { leaseMs: 1.5 }],
    ['ratePerMinute', { ratePerMinute: -1 }],
  ])('%s must be a positive integer', async (_name, bad) => {
    await expect(t.store.webhooks.claimDue({ ...CLAIM, ...bad })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
