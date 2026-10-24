import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { WEBHOOK_HEADERS } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { addHook, KEY, rawDeliveries, sendAll } from '../../store-postgres/test/webhookHelpers';
import { resolveWebhookConfig } from '../src/webhookConfig';
import { RecordingTransport, ticker } from './support';

const TICKERS = 4;
const HOOKS = 3;
const EVENTS_PER_HOOK = 20;

describeDb('webhook sender: concurrent ticks', () => {
  let t: TestStore;
  let stores: PostgresStore[];
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY, ringWindowMs: 3_600_000, poolSize: 16 });
    stores = Array.from({ length: TICKERS }, () => t.another({ ringWindowMs: 3_600_000 }));
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql`TRUNCATE qcloud_tick_state`;
  });

  test(`${TICKERS} ticks at once never send the same attempt twice`, async () => {
    for (let h = 0; h < HOOKS; h++) await addHook(t);
    await sendAll(
      t,
      Array.from({ length: EVENTS_PER_HOOK }, (_, i) => ({ id: i }))
    );
    const total = HOOKS * EVENTS_PER_HOOK;
    const sent = new Map<string, number>();
    const config = resolveWebhookConfig(
      { batch: 6, concurrency: 3, ratePerMinute: 100_000, leaseMs: 600_000, timeoutMs: 10_000 },
      { allowHttp: false, allowPrivate: false }
    )!;
    const sending = {
      config,
      resolve: async () => ['93.184.216.34'],
      now: () => t.clock.now(),
      post: async (request: { headers: Readonly<Record<string, string>> }) => {
        const key = `${request.headers[WEBHOOK_HEADERS.id]}#${request.headers[WEBHOOK_HEADERS.attempt]}`;
        sent.set(key, (sent.get(key) ?? 0) + 1);
        // Long enough for the others' claims to run while this request is in flight.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: 'status', status: 200 } as const;
      },
    };
    const ticks = stores.map((store) =>
      ticker(
        store,
        new RecordingTransport({ clock: t.clock }),
        { intervalMs: 5_000 },
        undefined,
        sending
      )
    );
    let delivered = 0;
    const deadline = performance.now() + 30_000;
    await Promise.all(
      ticks.map(async (tick) => {
        // A claim comes back empty while the others hold the webhooks it would take: wait a moment
        // and go on until every delivery is done.
        while (delivered < total && performance.now() < deadline) {
          const pass = await tick.pass();
          delivered += pass.webhooks.delivered;
          if (pass.webhooks.claimed === 0) await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })
    );

    expect(delivered).toBe(total);
    expect(sent.size).toBe(total);
    expect([...sent.values()].filter((count) => count !== 1)).toEqual([]);
    const rows = await rawDeliveries(t);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['delivered']));
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    const counts = await t.fresh.sql<{ success_count: string }[]>`
      SELECT success_count FROM qcloud_webhooks ORDER BY id`;
    expect(counts.reduce((sum, row) => sum + Number(row.success_count), 0)).toBe(total);
  });
});
