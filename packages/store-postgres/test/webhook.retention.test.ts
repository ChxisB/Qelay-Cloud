import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  EXPIRED_ERROR,
  WEBHOOK_DELIVERY_EXPIRY_MS,
  WEBHOOK_DELIVERY_KEEP_MS,
} from '../src/store/webhookRetention';
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
} from './webhookHelpers';

describeDb('webhooks: retention', () => {
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

  test('a delivery nobody sent within a day fails, with the reason and the webhook counted', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed', 'q', 'old')]);
    t.clock.advance(WEBHOOK_DELIVERY_EXPIRY_MS - 1_000);
    await journal(t, [event('pushed', 'q', 'fresh')]);
    t.clock.advance(1_001);
    expect(await t.store.webhooks.prune(100)).toEqual({ expired: 1, deleted: 0, more: false });
    const items = (await t.store.webhooks.deliveries(hook.id))!.items;
    expect(items.map((d) => [d.jobId, d.status, d.lastError])).toEqual([
      ['fresh', 'pending', null],
      ['old', 'failed', EXPIRED_ERROR],
    ]);
    expect(items[1]!.finishedAt).toBe(t.clock.now());
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ failureCount: 1 });
    expect(await t.store.webhooks.claimDue(CLAIM)).toHaveLength(1);
  });

  test('a claim that was never answered expires a day after its lease lapsed, and its late result is stale', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    const [claimed] = await t.store.webhooks.claimDue(CLAIM);
    t.clock.advance(CLAIM.leaseMs + WEBHOOK_DELIVERY_EXPIRY_MS - 1);
    expect((await t.store.webhooks.prune(100)).expired).toBe(0);
    t.clock.advance(2);
    expect((await t.store.webhooks.prune(100)).expired).toBe(1);
    expect(await t.store.webhooks.record([outcome(claimed!, { ok: true })], POLICY)).toMatchObject({
      stale: 1,
    });
  });

  test('a finished delivery is kept for a week and then deleted', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed', 'q', 'a'), event('pushed', 'q', 'b')]);
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    await t.store.webhooks.record(
      [outcome(claimed[0]!, { ok: true }), outcome(claimed[1]!, { ok: false })],
      { ...POLICY, maxAttempts: 1 }
    );
    t.clock.advance(WEBHOOK_DELIVERY_KEEP_MS - 1);
    expect(await t.store.webhooks.prune(100)).toMatchObject({ deleted: 0 });
    expect((await t.store.webhooks.deliveries(hook.id))!.items).toHaveLength(2);
    t.clock.advance(1);
    expect((await t.store.webhooks.prune(100)).deleted).toBe(0);
    t.clock.advance(1);
    expect(await t.store.webhooks.prune(100)).toMatchObject({ expired: 0, deleted: 2 });
    expect(await rawDeliveries(t)).toEqual([]);
    expect(await t.store.webhooks.get(hook.id)).toMatchObject({ successCount: 1, failureCount: 1 });
  });

  test('the limit caps each kind of work and reports that more is left', async () => {
    const hook = await addHook(t);
    await journal(
      t,
      Array.from({ length: 5 }, (_, i) => event('pushed', 'q', `j${i}`))
    );
    t.clock.advance(WEBHOOK_DELIVERY_EXPIRY_MS + 1);
    expect(await t.store.webhooks.prune(2)).toEqual({ expired: 2, deleted: 0, more: true });
    expect(await t.store.webhooks.prune(2)).toEqual({ expired: 2, deleted: 0, more: true });
    expect(await t.store.webhooks.prune(2)).toEqual({ expired: 1, deleted: 0, more: false });
    t.clock.advance(WEBHOOK_DELIVERY_KEEP_MS + 1);
    expect(await t.store.webhooks.prune(3)).toEqual({ expired: 0, deleted: 3, more: true });
    expect(await t.store.webhooks.prune(3)).toEqual({ expired: 0, deleted: 2, more: false });
    expect((await t.store.webhooks.deliveries(hook.id))!.items).toEqual([]);
  });

  test('a webhook the sender is working on is left for the next pass', async () => {
    const hook = await addHook(t);
    await journal(t, [event('pushed')]);
    t.clock.advance(WEBHOOK_DELIVERY_EXPIRY_MS + 1);
    const held = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT id FROM qcloud_webhooks WHERE id = ${hook.id} FOR NO KEY UPDATE`;
      await Bun.sleep(300);
    });
    await Bun.sleep(50);
    expect((await t.store.webhooks.prune(100)).expired).toBe(0);
    await held;
    expect((await t.store.webhooks.prune(100)).expired).toBe(1);
  });
});
