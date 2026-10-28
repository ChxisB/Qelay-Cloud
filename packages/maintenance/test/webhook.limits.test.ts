import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { addHook, KEY, send, sendAll } from '../../store-postgres/test/webhookHelpers';
import type { PostResult } from '../src/webhookHttp';
import { RecordingTransport, recordedTelemetry } from './support';
import { PUBLIC, senderHarness, status } from './webhookSending';

describeDb('webhook sender: limits, telemetry and leases', () => {
  let t: TestStore;
  let transport: RecordingTransport;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, ringWindowMs: 3_600_000, poolSize: 8 });
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

  test('a pass sends at most `batch`, reports moreWork, and a run drains the rest', async () => {
    await addHook(t);
    await sendAll(
      t,
      Array.from({ length: 7 }, (_, i) => ({ n: i }))
    );
    const s = sending(() => status(200), { batch: 3, concurrency: 2 });
    const first = await s.pass();
    expect(first.webhooks.claimed).toBe(3);
    expect(first.moreWork).toBe(true);
    const run = await s.run();
    expect(run.webhooks.delivered).toBe(4);
    expect(run.moreWork).toBe(false);
    expect(s.seen).toHaveLength(7);
    expect(new Set(s.seen.map((entry) => entry.deliveryId)).size).toBe(7);
  });

  test('no new chunk starts once the pass budget is spent', async () => {
    await addHook(t);
    await sendAll(
      t,
      Array.from({ length: 6 }, (_, i) => ({ n: i }))
    );
    const s = sending(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return status(200);
      },
      { concurrency: 2, budgetMs: 10 }
    );
    const pass = await s.pass();
    expect(pass.webhooks.claimed).toBe(2);
    expect(pass.moreWork).toBe(true);
  });

  test('requests within a chunk run in parallel', async () => {
    for (let n = 0; n < 4; n++) await addHook(t);
    await send(t);
    const s = sending(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return status(200);
      },
      { concurrency: 4 }
    );
    const started = performance.now();
    expect((await s.pass()).webhooks.delivered).toBe(4);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('the rate limit holds a webhook back within its minute', async () => {
    await addHook(t);
    await sendAll(
      t,
      Array.from({ length: 5 }, (_, i) => ({ n: i }))
    );
    const s = sending(() => status(200), { ratePerMinute: 2 });
    expect((await s.run()).webhooks.delivered).toBe(2);
    expect((await s.run()).webhooks.claimed).toBe(0);
    t.clock.advance(60_000);
    expect((await s.run()).webhooks.delivered).toBe(2);
  });

  test('the tick reports the step to telemetry as gauges', async () => {
    await addHook(t);
    await sendAll(t, [{ n: 'a' }, { n: 'b' }]);
    const telemetry = recordedTelemetry();
    const s = sending((call) => status(call === 1 ? 200 : 500), {}, t.store, telemetry);
    await s.pass();
    const gauge = (name: string) => telemetry.gauges.find(([key]) => key === name)?.[1];
    expect(gauge('webhooks.claimed')).toBe(2);
    expect(gauge('webhooks.delivered')).toBe(1);
    expect(gauge('webhooks.retrying')).toBe(1);
    expect(gauge('webhooks.failed')).toBe(0);
    expect(gauge('webhooks.errors')).toBe(0);
    expect(telemetry.durations.some(([step]) => step === 'webhooks')).toBe(true);
    // Counts only: nothing names a route, a request or an address.
    expect(JSON.stringify(telemetry.gauges)).not.toContain(PUBLIC);
  });

  test('an outcome that arrives after the lease lapsed is dropped and the newer attempt stands', async () => {
    const hook = await addHook(t);
    await send(t);
    let release: (result: PostResult) => void = () => {};
    const slow = sending(() => new Promise<PostResult>((resolve) => (release = resolve)), {
      leaseMs: 40_000,
      timeoutMs: 10_000,
    });
    const late = slow.pass();
    while (slow.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    // The first sender hangs past its lease; a second one takes the delivery again and delivers it.
    t.clock.advance(40_001);
    const other = sending(() => status(200), {}, t.another());
    expect((await other.pass()).webhooks).toMatchObject({ claimed: 1, delivered: 1 });

    release(status(500));
    expect((await late).webhooks).toMatchObject({
      claimed: 1,
      stale: 1,
      delivered: 0,
      retrying: 0,
    });
    const [row] = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1, failureCount: 0 });
  });
});
