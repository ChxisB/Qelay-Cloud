import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { PostgresStore } from '../src/postgresStore';
import { resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';
import { addHook, event, journal, KEY, outcome, POLICY, rawDeliveries } from './webhookHelpers';

const SENDERS = 4;
const HOOKS = 6;
const EVENTS_PER_HOOK = 40;

describeDb('webhooks: concurrent senders and writers', () => {
  let t: TestStore;
  let senders: PostgresStore[];
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, poolSize: 16 });
    senders = Array.from({ length: SENDERS }, () => t.another());
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test(`${SENDERS} senders claiming at once never take a delivery twice`, async () => {
    for (let h = 0; h < HOOKS; h++) {
      await addHook(t, { queue: `q${h}`, events: ['job.pushed'] });
      await journal(
        t,
        Array.from({ length: EVENTS_PER_HOOK }, (_, i) => event('pushed', `q${h}`, `j${h}-${i}`))
      );
    }
    const total = HOOKS * EVENTS_PER_HOOK;
    const claims = { limit: 10, leaseMs: 600_000, ratePerMinute: 100_000 };
    const taken: Array<{ sender: number; deliveryId: string; attempt: number }> = [];
    await Promise.all(
      senders.map(async (store, sender) => {
        // A claim comes back empty while the others hold the webhooks it would take, so go on until
        // every delivery is accounted for.
        for (let round = 0; round < 200 && taken.length < total; round++) {
          const claimed = await store.webhooks.claimDue(claims);
          taken.push(
            ...claimed.map((c) => ({ sender, deliveryId: c.deliveryId, attempt: c.attempt }))
          );
          await store.webhooks.record(
            claimed.map((c) => outcome(c, { ok: true })),
            POLICY
          );
        }
      })
    );
    expect(taken).toHaveLength(total);
    expect(new Set(taken.map((c) => c.deliveryId)).size).toBe(total);
    expect(taken.every((c) => c.attempt === 1)).toBe(true);
    expect(new Set(taken.map((c) => c.sender)).size).toBeGreaterThan(1);
    const rows = await rawDeliveries(t);
    expect(rows).toHaveLength(total);
    expect(rows.every((row) => row.status === 'delivered' && row.attempts === 1)).toBe(true);
  });

  test('senders working one webhook leave nothing for a second claim while the first holds it', async () => {
    await addHook(t);
    await journal(t, [event('pushed')]);
    const results = await Promise.all(
      senders.map((store) =>
        store.webhooks.claimDue({ limit: 5, leaseMs: 60_000, ratePerMinute: 100 })
      )
    );
    expect(results.flat()).toHaveLength(1);
  });

  test('registering and deleting webhooks while jobs are pushed never fails a push', async () => {
    const steady = await addHook(t, { events: ['job.pushed'], queue: 'busy' });
    const pushes = 4 * 40;
    const churn = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const hook = await addHook(t, { events: ['job.pushed'], queue: 'busy' });
        await t.store.webhooks.delete(hook.id);
      }
    };
    const push = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) await enqueueN(t.another(), 1, {}, 'busy');
    };
    const outcomes = await Promise.allSettled([churn(), churn(), push(), push(), push(), push()]);
    expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
    const rows = await rawDeliveries(t);
    expect(rows.filter((row) => row.webhook_id === steady.id)).toHaveLength(pushes);
    const strays = await t.fresh.sql`
      SELECT count(*)::int AS n FROM qcloud_webhook_deliveries d
      WHERE NOT EXISTS (SELECT 1 FROM qcloud_webhooks w WHERE w.id = d.webhook_id)`;
    expect(strays[0]!.n).toBe(0);
  });

  test('a sender holding a webhook does not stall a job push', async () => {
    const hook = await addHook(t, { events: ['job.pushed'] });
    await journal(t, [event('pushed', 'q', 'seed')]);
    // The claim's transaction holds the webhook row `FOR NO KEY UPDATE`; the trigger needs `KEY SHARE`.
    const held = t.fresh.sql.begin(async (tx) => {
      await tx`SELECT id FROM qcloud_webhooks WHERE id = ${hook.id} FOR NO KEY UPDATE`;
      await Bun.sleep(300);
    });
    await Bun.sleep(50);
    const started = performance.now();
    await enqueueN(t.another(), 1, {}, 'q');
    expect(performance.now() - started).toBeLessThan(250);
    await held;
    expect(await rawDeliveries(t)).toHaveLength(2);
  });
});
