import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addRoute, addSource, post, requestDeliveries } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { KEY } from './webhookHelpers';

const SECOND = 1_000;

describeDb('inbound sources: dedupe is per route, and its windows are pruned when they end', () => {
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

  const windows = () =>
    t.fresh.sql<Array<{ webhook_id: string; until: string }>>`
      SELECT webhook_id, until FROM qcloud_webhook_dedupe ORDER BY webhook_id, key`;

  test('a window belongs to its route, and a request its filter refuses does not start one', async () => {
    const source = await addSource(t);
    const dedupe = { windowMs: 60 * SECOND, fields: ['body.kind'] };
    const strict = await addRoute(t, source.id, { filter: { 'body.queue': 'only' }, dedupe });
    const loose = await addRoute(t, source.id, { dedupe });
    await t.store.sources.accept(source.id, post({ kind: 'x', queue: 'other' }));
    await t.store.sources.accept(source.id, post({ kind: 'x', queue: 'only' }));
    const made = (await requestDeliveries(t)).map((r) => (r.webhook_id === strict.id ? 's' : 'l'));
    // The loose route took the first request and dropped the second; the strict one took only the second.
    expect(made.sort()).toEqual(['l', 's']);
    expect(loose.id).not.toBe(strict.id);
  });

  test('retention removes only the windows that have ended', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { dedupe: { windowMs: 10 * SECOND, fields: ['body.kind'] } });
    await t.store.sources.accept(source.id, post({ kind: 'old' }));
    t.clock.advance(20 * SECOND);
    await t.store.sources.accept(source.id, post({ kind: 'new' }));
    expect(await windows()).toHaveLength(2);
    await t.store.webhooks.prune(100);
    const left = await windows();
    expect(left).toHaveLength(1);
    expect(Number(left[0]!.until)).toBeGreaterThan(t.clock.now());
  });
});
