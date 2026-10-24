import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addRoute, addSource, post, requestDeliveries } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { KEY } from './webhookHelpers';

describeDb('inbound sources: reading and replaying stored requests', () => {
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

  const accept = async (source: string, body: unknown, extra = {}): Promise<string> => {
    const result = await t.store.sources.accept(source, post(body, extra));
    if (result.outcome !== 'accepted') throw new Error('not accepted');
    return result.id;
  };

  test('the list pages newest first by keyset, without skipping or repeating, while requests keep arriving', async () => {
    const source = await addSource(t);
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await accept(source.id, { n }));
    const first = await t.store.sources.requests({ limit: 3 });
    expect(first.items.map((r) => r.id)).toEqual(ids.slice(4).reverse());
    expect(first.next).toBe(ids[4]!);
    // A request that arrives between two pages is newer than the cursor, so it moves nothing.
    const late = await accept(source.id, { n: 'late' });
    const second = await t.store.sources.requests({ limit: 3, before: first.next! });
    const third = await t.store.sources.requests({ limit: 3, before: second.next! });
    expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual(
      ids.slice().reverse()
    );
    expect(third.next).toBeNull();
    expect((await t.store.sources.requests({ limit: 1 })).items[0]!.id).toBe(late);
  });

  test('the list filters by source and by status, and a summary carries no body', async () => {
    const billing = await addSource(t);
    const other = await addSource(t, { name: 'Other' });
    const a = await accept(billing.id, { id: 1 });
    await accept(other.id, { id: 2 });
    await t.store.sources.reject(billing.id, post('x'), 'signature does not match');
    const mine = await t.store.sources.requests({ sourceId: billing.id });
    expect(mine.items).toHaveLength(2);
    const rejected = await t.store.sources.requests({ sourceId: billing.id, status: 'rejected' });
    expect(rejected.items).toEqual([
      expect.objectContaining({
        status: 'rejected',
        cause: 'signature does not match',
        bodyBytes: null,
      }),
    ]);
    const accepted = await t.store.sources.requests({ status: 'accepted' });
    expect(accepted.items.map((r) => r.id)).toContain(a);
    expect(accepted.items[0]).toEqual({
      id: expect.any(String),
      sourceId: expect.any(String),
      receivedAt: expect.any(Number),
      method: 'POST',
      contentType: 'application/json',
      status: 'accepted',
      cause: null,
      bodyBytes: expect.any(Number),
    });
  });

  test('a bad limit, status, cursor or id is refused by name', async () => {
    await expect(t.store.sources.requests({ limit: 0 })).rejects.toThrow(UnsupportedOptionError);
    await expect(t.store.sources.requests({ limit: 201 })).rejects.toThrow(UnsupportedOptionError);
    await expect(t.store.sources.requests({ before: 'abc' })).rejects.toThrow(
      UnsupportedOptionError
    );
    await expect(
      t.store.sources.requests({ status: 'pending' as unknown as 'accepted' })
    ).rejects.toThrow(UnsupportedOptionError);
    await expect(t.store.sources.request('x')).rejects.toThrow(UnsupportedOptionError);
  });

  test('one request comes whole: headers (redacted), query, body, and the deliveries it made with their route kind', async () => {
    const source = await addSource(t);
    const http = await addRoute(t, source.id);
    const queue = await t.store.webhooks.create(
      { destination: 'queue', target: 'inbox', source: source.id },
      'tester'
    );
    const id = await accept(
      source.id,
      { id: 500, name: 'chris' },
      {
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        query: { a: '1' },
      }
    );
    const one = (await t.store.sources.request(id))!;
    expect(one.headers).toEqual({
      'content-type': 'application/json',
      authorization: '[redacted]',
    });
    expect(one.query).toEqual({ a: '1' });
    expect(JSON.parse(new TextDecoder().decode(one.body!))).toEqual({ id: 500, name: 'chris' });
    expect(one.deliveries.map((d) => [d.delivery.webhookId, d.via]).sort()).toEqual(
      [
        [http.id, 'http'],
        [queue.id, 'queue'],
      ].sort()
    );
    expect(one.deliveries[0]!.delivery).toMatchObject({ event: 'request.received', requestId: id });
    expect(await t.store.sources.request('999999999')).toBeNull();
  });

  test('a replay makes new deliveries for the routes as they are now, and skips the dedupe', async () => {
    const source = await addSource(t);
    const first = await addRoute(t, source.id, {
      dedupe: { fields: ['body.id'], windowMs: 60_000 },
    });
    const id = await accept(source.id, { id: 7 });
    // The window is open, so an identical request is dropped for the route...
    await t.store.sources.accept(source.id, post({ id: 7 }));
    expect(await requestDeliveries(t)).toHaveLength(1);
    // ...but a replay is not, and a route added since gets the request too.
    const added = await addRoute(t, source.id);
    t.clock.advance(5);
    expect(await t.store.sources.replay(id)).toEqual({
      outcome: 'replayed',
      routes: 2,
      deliveries: 2,
    });
    const rows = await requestDeliveries(t);
    expect(
      rows
        .filter((r) => r.request_id === id)
        .map((r) => r.webhook_id)
        .sort()
    ).toEqual([first.id, first.id, added.id].sort());
    expect((await t.store.sources.request(id))!.deliveries).toHaveLength(3);
  });

  test('a replay respects the route filter, and refuses a rejected request and an unknown one', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id, { filter: { 'body.id': { $gt: 100 } } });
    const id = await accept(source.id, { id: 1 });
    t.clock.advance(5);
    expect(await t.store.sources.replay(id)).toEqual({
      outcome: 'replayed',
      routes: 1,
      deliveries: 0,
    });
    await t.store.sources.reject(source.id, post('x'), 'bad');
    const [rejected] = (await t.store.sources.requests({ status: 'rejected' })).items;
    expect(await t.store.sources.replay(rejected!.id)).toEqual({ outcome: 'rejected' });
    expect(await t.store.sources.replay('999999999')).toEqual({ outcome: 'not_found' });
  });
});
