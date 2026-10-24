import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { WEBHOOK_DELIVERY_EXPIRY_MS } from '../src/store/webhookRetention';
import { resetTables } from './finishHelpers';
import { addSource, post } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { KEY } from './webhookHelpers';

describeDb('inbound sources: request retention', () => {
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

  const stored = async (): Promise<number> =>
    Number(
      (await t.fresh.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_requests`)[0]!
        .n
    );

  test('a request is kept for twice the delivery expiry, so a live delivery always finds it, then the tick removes it', async () => {
    const source = await addSource(t);
    await t.store.sources.accept(source.id, post({ id: 1 }));
    t.clock.advance(2 * WEBHOOK_DELIVERY_EXPIRY_MS - 1_000);
    await t.store.webhooks.prune(100);
    expect(await stored()).toBe(1);

    t.clock.advance(2_000);
    await t.store.webhooks.prune(100);
    expect(await stored()).toBe(0);
  });

  test('a backlog is taken a batch at a time, and the pass says there is more', async () => {
    const source = await addSource(t);
    for (const id of [1, 2, 3]) await t.store.sources.accept(source.id, post({ id }));
    t.clock.advance(3 * WEBHOOK_DELIVERY_EXPIRY_MS);

    expect((await t.store.webhooks.prune(2)).more).toBe(true);
    expect(await stored()).toBe(1);
    expect((await t.store.webhooks.prune(2)).more).toBe(false);
    expect(await stored()).toBe(0);
  });
});
