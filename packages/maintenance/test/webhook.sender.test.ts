import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import {
  addHook,
  KEY,
  rawDeliveries,
  SECRET,
  send,
} from '../../store-postgres/test/webhookHelpers';
import { RecordingTransport, recordedTelemetry, ticker } from './support';
import { senderHarness, status } from './webhookSending';

describeDb('webhook sender: deliveries through the tick', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({
      webhookKey: KEY,
      ringWindowMs: 3_600_000,
      poolSize: 8,
      random: () => 0.5,
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state`;
    transport = new RecordingTransport({ clock: t.clock });
  });

  const { sending } = senderHarness(
    () => t,
    () => transport
  );

  test('fail twice then succeed: one delivery, three attempts, the documented backoff', async () => {
    const hook = await addHook(t, { secret: SECRET });
    await send(t);
    const s = sending((call) => status([500, 503, 200][call - 1]!));

    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, retrying: 1, delivered: 0 });
    let [row] = await rawDeliveries(t);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    // The first retry waits baseDelayMs from the failure; one millisecond early finds nothing.
    expect(Number(row!.next_attempt_at)).toBe(t.clock.now() + 1_000);
    t.clock.advance(999);
    expect((await s.pass()).webhooks.claimed).toBe(0);

    t.clock.advance(1);
    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, retrying: 1 });
    [row] = await rawDeliveries(t);
    // The second wait is double.
    expect(Number(row!.next_attempt_at)).toBe(t.clock.now() + 2_000);

    t.clock.advance(2_000);
    expect((await s.pass()).webhooks).toMatchObject({
      claimed: 1,
      delivered: 1,
      retrying: 0,
      failed: 0,
    });
    t.clock.advance(3_600_000);
    expect((await s.pass()).webhooks.claimed).toBe(0);

    expect(s.seen.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(new Set(s.seen.map((entry) => entry.deliveryId)).size).toBe(1);
    const page = await t.store.webhooks.deliveries(hook.id);
    expect(page!.items).toHaveLength(1);
    const delivered = page!.items[0]!;
    expect(delivered).toMatchObject({
      status: 'delivered',
      attempts: 3,
      lastStatusCode: 200,
      lastError: null,
    });
    expect(delivered.history.map((h) => [h.attempt, h.statusCode, h.error])).toEqual([
      [1, 500, 'receiver answered 500'],
      [2, 503, 'receiver answered 503'],
      [3, 200, null],
    ]);
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1, failureCount: 0 });
  });

  test('a receiver that keeps failing ends failed after the attempt budget, and a retry restarts it', async () => {
    const hook = await addHook(t);
    await send(t);
    const s = sending(() => status(500));
    for (let i = 0; i < 3; i++) {
      await s.pass();
      t.clock.advance(60_000);
    }
    const [failed] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(s.seen).toHaveLength(3);
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ failureCount: 1, successCount: 0 });

    expect((await s.pass()).webhooks.claimed).toBe(0);
    expect((await t.store.webhooks.retry(hook.id, failed!.id)).outcome).toBe('retried');
    expect((await s.pass()).webhooks).toMatchObject({ claimed: 1, retrying: 1 });
    // Attempt numbers keep rising across a manual retry.
    expect(s.seen.at(-1)!.attempt).toBe(4);
  });

  test('a failing receiver is not a failing tick', async () => {
    await addHook(t);
    await send(t);
    const s = sending(() => status(500));
    const report = await s.run();
    expect(report.ok).toBe(true);
    expect(report.webhooks).toMatchObject({ claimed: 1, retrying: 1, errors: 0 });
    expect((await t.store.maintenance.tickStatus()).lastSuccessAt).not.toBeNull();
  });

  test('a store that cannot be reached fails the step, not the pass, and marks the tick failed', async () => {
    await addHook(t);
    await send(t);
    const telemetry = recordedTelemetry();
    const s = sending(() => status(200), {}, t.store, telemetry);
    const original = t.store.webhooks.claimDue;
    t.store.webhooks.claimDue = async () => {
      throw new Error('connection to server lost');
    };
    try {
      const pass = await s.pass();
      expect(pass.webhooks).toMatchObject({ claimed: 0, errors: 1 });
      expect(telemetry.errors.map(([step]) => step)).toEqual(['webhooks']);
      const run = await s.run();
      expect(run.ok).toBe(false);
      expect(run.passes).toBe(1);
    } finally {
      t.store.webhooks.claimDue = original;
    }
    expect(s.seen).toEqual([]);
  });

  test('without webhook settings the tick sends nothing and leaves deliveries pending', async () => {
    await addHook(t);
    await send(t);
    const report = await ticker(t.store, transport, { intervalMs: 5_000 }).pass();
    expect(report.webhooks).toEqual({
      claimed: 0,
      delivered: 0,
      retrying: 0,
      failed: 0,
      stale: 0,
      paused: 0,
      errors: 0,
    });
    expect((await rawDeliveries(t))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
