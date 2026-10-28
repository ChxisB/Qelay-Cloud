import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { addHook, CLAIM, KEY, outcome, POLICY, send } from './webhookHelpers';

const MINUTE = 60_000;

describeDb('webhooks: a batch route is claimed and recorded as one request (D15)', () => {
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

  const claim = (options: Partial<typeof CLAIM> = {}) =>
    t.store.webhooks.claimDue({ ...CLAIM, ...options });
  const sendMany = async (count: number, body: (n: number) => unknown = (n) => ({ n })) => {
    for (let n = 0; n < count; n += 1) await send(t, body(n));
  };
  const rateUsed = async () =>
    Number(
      (
        await t.fresh.sql<Array<{ n: number }>>`SELECT rate_window_count AS n FROM qcloud_webhooks`
      )[0]!.n
    );

  test('250 due deliveries with maxEvents 100 are 100, 100 and 50, and each batch is one rate unit', async () => {
    await addHook(t, { batch: { maxEvents: 100, maxBytes: 262_144 } });
    await sendMany(250);

    // A lease longer than the minute: the first 200 stay with their claimers while the clock moves on.
    const limits = { ratePerMinute: 2, leaseMs: 10 * MINUTE };
    const first = await claim(limits);
    const second = await claim(limits);
    expect([first.length, second.length]).toEqual([100, 100]);
    expect([...first, ...second].every((delivery) => delivery.batched === true)).toBe(true);
    expect(new Set([...first, ...second].map((delivery) => delivery.deliveryId)).size).toBe(200);
    expect(await rateUsed()).toBe(2);

    // The minute's two requests are spent: the last 50 wait for the next minute.
    expect(await claim(limits)).toHaveLength(0);
    t.clock.advance(MINUTE);
    expect(await claim(limits)).toHaveLength(50);
    expect(await claim(limits)).toHaveLength(0);
  });

  test('a batch stops before maxBytes of body, and an event larger than the limit still goes alone', async () => {
    await addHook(t, { batch: { maxEvents: 10, maxBytes: 1_024 } });
    // About 390 bytes each: two fit in 1,024, a third does not.
    await sendMany(5, (n) => ({ n, pad: 'x'.repeat(380) }));
    const sizes = [];
    for (let at = 0; at < 4; at += 1) sizes.push((await claim()).length);
    expect(sizes).toEqual([2, 2, 1, 0]);

    await resetTables(t);
    await addHook(t, { batch: { maxEvents: 10, maxBytes: 1_024 } });
    await send(t, { pad: 'y'.repeat(3_000) });
    await send(t, { n: 2 });
    const [big, ...rest] = await claim();
    expect(big).toBeDefined();
    expect(rest).toHaveLength(0);
  });

  test('a batch and a plain route share the claim limit, a batch counting one', async () => {
    const batched = await addHook(t, { batch: { maxEvents: 10, maxBytes: 262_144 } });
    const plain = await addHook(t, { url: 'https://other.example.com/in' });
    await sendMany(10);

    const claimed = await claim({ limit: 3 });
    const of = (id: string) => claimed.filter((delivery) => delivery.webhookId === id);
    expect(of(batched.id)).toHaveLength(10);
    expect(of(batched.id).every((delivery) => delivery.batched === true)).toBe(true);
    // Three requests: the batch, then two of the plain route's.
    expect(of(plain.id)).toHaveLength(2);
    expect(of(plain.id).some((delivery) => delivery.batched === true)).toBe(false);
  });

  test('members that fail with their batch id retry together, at the latest member’s backoff, and keep the id', async () => {
    const hook = await addHook(t, { batch: { maxEvents: 10, maxBytes: 262_144 } });
    await sendMany(2);
    const [a, b] = await claim();

    // `a` fails alone first, so its next attempt is its second.
    await t.store.webhooks.record([outcome(a!, { ok: false })], POLICY);
    t.clock.advance(1_000);
    const [again] = await claim();
    expect(again).toMatchObject({ deliveryId: a!.deliveryId, attempt: 2 });

    const summary = await t.store.webhooks.record(
      [
        { ...outcome(again!, { ok: false }), batchId: 'batch-1' },
        { ...outcome(b!, { ok: false }), batchId: 'batch-1' },
      ],
      POLICY
    );
    expect(summary).toMatchObject({ retrying: 2, failed: 0 });
    const items = (await t.store.webhooks.deliveries(hook.id))!.items;
    // Attempt 2 of `a` backs off 2 s, and `b`, on its first, goes with it.
    expect(items.map((item) => item.nextAttemptAt)).toEqual([
      t.clock.now() + 2_000,
      t.clock.now() + 2_000,
    ]);
    expect(items.every((item) => item.batchId === 'batch-1')).toBe(true);
    expect(items.map((item) => item.history.at(-1)?.batchId)).toEqual(['batch-1', 'batch-1']);
  });

  test('a batch answered 2xx delivers every member and their history names the batch', async () => {
    const hook = await addHook(t, { batch: { maxEvents: 10, maxBytes: 262_144 } });
    await sendMany(3);
    const claimed = await claim();

    const summary = await t.store.webhooks.record(
      claimed.map((delivery) => ({ ...outcome(delivery, { ok: true }), batchId: 'batch-2' })),
      POLICY
    );
    expect(summary).toMatchObject({ delivered: 3, retrying: 0 });
    const items = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(items.every((item) => item.status === 'delivered' && item.batchId === 'batch-2')).toBe(
      true
    );
    expect(items.map((item) => item.history[0]?.batchId)).toEqual([
      'batch-2',
      'batch-2',
      'batch-2',
    ]);
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 3 });
  });

  test('a route without a batch is claimed, counted and recorded as before', async () => {
    const hook = await addHook(t);
    await sendMany(3);
    const claimed = await claim({ ratePerMinute: 100 });
    expect(claimed).toHaveLength(3);
    expect(claimed.some((delivery) => delivery.batched === true)).toBe(false);
    expect(await rateUsed()).toBe(3);
    await t.store.webhooks.record(
      claimed.map((delivery) => outcome(delivery, { ok: true })),
      POLICY
    );
    const items = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(items.every((item) => item.batchId === null)).toBe(true);
    expect(items[0]!.history[0]).not.toHaveProperty('batchId');
  });
});
