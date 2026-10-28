import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_HOLD_REASON } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, KEY, rawDeliveries, send } from './webhookHelpers';

describeDb('webhooks: pause with hold or ignore', () => {
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

  const failing = async (id: string) =>
    t.fresh.sql`
      UPDATE qcloud_webhooks SET consecutive_failures = 3, alert_level = 2 WHERE id = ${id}`;

  test('hold: off, events still collected, nothing sent until it is resumed', async () => {
    const hook = await addHook(t);
    const held = await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    expect(held).toMatchObject({ enabled: false, disabledReason: WEBHOOK_HOLD_REASON });
    expect(held!.disabledAt).toBe(t.clock.now());
    await send(t, { id: 'j1' });
    expect(await rawDeliveries(t)).toHaveLength(1);
    expect(await t.store.webhooks.claimDue(CLAIM)).toEqual([]);
    const resumed = await t.store.webhooks.setEnabled(hook.id, true);
    expect(resumed).toMatchObject({ enabled: true, disabledReason: null, disabledAt: null });
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
  });

  test('ignore (the default): off, nothing collected, as before', async () => {
    const hook = await addHook(t);
    const off = await t.store.webhooks.setEnabled(hook.id, false);
    expect(off).toMatchObject({ enabled: false, disabledReason: null, disabledAt: null });
    await send(t, { id: 'j1' });
    expect(await rawDeliveries(t)).toHaveLength(0);
    await t.store.webhooks.setEnabled(hook.id, false, 'ignore');
    expect(await rawDeliveries(t)).toHaveLength(0);
  });

  test('a hold does not touch the failure streak or the alert level', async () => {
    const hook = await addHook(t);
    await failing(hook.id);
    const held = await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    expect(held).toMatchObject({ consecutiveFailures: 3, alertLevel: 2 });
    const resumed = await t.store.webhooks.setEnabled(hook.id, true);
    expect(resumed).toMatchObject({ consecutiveFailures: 0, alertLevel: 0 });
  });

  test('holding a webhook already paused for failing keeps its reason and time', async () => {
    const hook = await addHook(t);
    await t.fresh.sql`
      UPDATE qcloud_webhooks SET enabled = FALSE, disabled_reason = '5 failed deliveries in a row',
             disabled_at = 123 WHERE id = ${hook.id}`;
    const held = await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    expect(held).toMatchObject({
      enabled: false,
      disabledReason: '5 failed deliveries in a row',
      disabledAt: 123,
    });
  });

  test('ignore on a held webhook ends the holding; the waiting deliveries stay', async () => {
    const hook = await addHook(t);
    await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    const first = await send(t, { id: 'j1' });
    const off = await t.store.webhooks.setEnabled(hook.id, false, 'ignore');
    expect(off).toMatchObject({ enabled: false, disabledReason: null });
    await send(t, { id: 'j2' });
    expect((await rawDeliveries(t)).map((r) => r.request_id)).toEqual([first]);
  });

  test('turning on ignores the mode', async () => {
    const hook = await addHook(t);
    await t.store.webhooks.setEnabled(hook.id, false, 'hold');
    expect(await t.store.webhooks.setEnabled(hook.id, true, 'hold')).toMatchObject({
      enabled: true,
      disabledReason: null,
    });
  });
});
