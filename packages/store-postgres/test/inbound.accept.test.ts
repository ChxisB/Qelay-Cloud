import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  MAX_REJECTED_PER_MINUTE,
  MAX_REQUEST_BODY_BYTES,
  MAX_REQUEST_VALUE_CHARS,
  REDACTED,
  REJECT_WINDOW_MS,
  UnsupportedOptionError,
  WEBHOOK_HOLD_REASON,
} from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addRoute, addSource, post, requestDeliveries } from './inboundHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';
import { KEY } from './webhookHelpers';

interface RequestRow {
  readonly id: string;
  readonly status: string;
  readonly cause: string | null;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body: Uint8Array | null;
  readonly content_type: string | null;
}

describeDb('inbound sources: accepting and rejecting requests', () => {
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

  const requests = (): Promise<RequestRow[]> =>
    t.fresh.sql<RequestRow[]>`
      SELECT id::text AS id, status, cause, method, headers, query, body, content_type
      FROM qcloud_requests ORDER BY id`;

  test('a request makes one delivery for each enabled route of its source, and none for a route its filter refuses', async () => {
    const source = await addSource(t);
    const other = await addSource(t, { name: 'Other' });
    const all = await addRoute(t, source.id);
    const big = await addRoute(t, source.id, { filter: { 'body.id': { $gt: 100 } } });
    const huge = await addRoute(t, source.id, { filter: { 'body.id': { $gt: 900 } } });
    const off = await addRoute(t, source.id, { enabled: false });
    await addRoute(t, other.id);

    const result = await t.store.sources.accept(source.id, post({ id: 500, name: 'chris' }));
    expect(result).toMatchObject({ outcome: 'accepted', routes: 3, deliveries: 2 });
    const rows = await requestDeliveries(t);
    expect(rows.map((row) => row.webhook_id).sort()).toEqual([all.id, big.id].sort());
    expect(rows).not.toContainEqual(expect.objectContaining({ webhook_id: huge.id }));
    expect(rows).not.toContainEqual(expect.objectContaining({ webhook_id: off.id }));
    const id = (result as { id: string }).id;
    expect(rows[0]).toMatchObject({
      request_id: id,
      event_name: 'request.received',
      status: 'pending',
      body: null,
      next_attempt_at: String(t.clock.now()),
    });
    // The same request twice is two requests, so two more deliveries.
    await t.store.sources.accept(source.id, post({ id: 500 }));
    expect(await requestDeliveries(t)).toHaveLength(4);
  });

  test('the request is stored as it came: its bytes, method and content type, with the secrets in its headers redacted', async () => {
    const source = await addSource(t, {
      verification: { kind: 'api_key', header: 'X-Api-Key' },
    });
    const bytes = new Uint8Array([0, 1, 2, 255, 254]);
    await t.store.sources.accept(
      source.id,
      post('', {
        method: 'put',
        headers: { Authorization: 'Bearer s3cret', 'x-api-key': 'k-123', 'X-Trace': 'abc' },
        query: { page: '2' },
        contentType: 'application/octet-stream',
        body: bytes,
      })
    );
    const [row] = await requests();
    expect(row).toMatchObject({
      status: 'accepted',
      method: 'PUT',
      content_type: 'application/octet-stream',
      headers: { authorization: REDACTED, 'x-api-key': REDACTED, 'x-trace': 'abc' },
      query: { page: '2' },
    });
    expect(Array.from(row!.body!)).toEqual(Array.from(bytes));
  });

  test('a shape makes the delivery body, a shape too large fails the delivery with its reason, a delay sets when it is due', async () => {
    const source = await addSource(t);
    const shaped = await addRoute(t, source.id, {
      shape: { who: { $: 'body.name' } },
      delayMs: 5_000,
    });
    const tooBig = await addRoute(t, source.id, { shape: { text: { $: 'body.text' } } });
    await t.store.sources.accept(source.id, post({ name: 'chris', text: 'x'.repeat(70_000) }));
    const rows = await requestDeliveries(t);
    const mine = rows.find((row) => row.webhook_id === shaped.id)!;
    expect(mine).toMatchObject({ status: 'pending', body: '{"who":"chris"}' });
    expect(Number(mine.next_attempt_at)).toBe(t.clock.now() + 5_000);
    const failed = rows.find((row) => row.webhook_id === tooBig.id)!;
    expect(failed).toMatchObject({ status: 'failed', body: '' });
    expect(failed.last_error).toBeTruthy();
  });

  test('20 requests with one dedupe key at once make one delivery; a later window or another key makes another', async () => {
    const source = await addSource(t);
    const route = await addRoute(t, source.id, {
      dedupe: { windowMs: 60_000, fields: ['body.id'] },
    });
    const second = t.another();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        (n % 2 === 0 ? t.store : second).sources.accept(source.id, post({ id: 7, n }))
      )
    );
    expect(results.every((r) => r.outcome === 'accepted')).toBe(true);
    expect((await requestDeliveries(t)).filter((row) => row.webhook_id === route.id)).toHaveLength(
      1
    );
    expect(await requests()).toHaveLength(20);

    await t.store.sources.accept(source.id, post({ id: 8 }));
    expect(await requestDeliveries(t)).toHaveLength(2);
    t.clock.advance(60_000);
    await t.store.sources.accept(source.id, post({ id: 7 }));
    expect(await requestDeliveries(t)).toHaveLength(3);
  });

  test('a route paused with hold still collects, one paused with ignore does not', async () => {
    const source = await addSource(t);
    const hold = await addRoute(t, source.id);
    const ignore = await addRoute(t, source.id);
    await t.store.webhooks.setEnabled(hold.id, false, 'hold');
    await t.store.webhooks.setEnabled(ignore.id, false, 'ignore');
    expect((await t.store.webhooks.get(hold.id))!.disabledReason).toBe(WEBHOOK_HOLD_REASON);
    await t.store.sources.accept(source.id, post({ id: 1 }));
    expect((await requestDeliveries(t)).map((row) => row.webhook_id)).toEqual([hold.id]);
  });

  test('a source that is off or gone takes nothing; a body over the cap or a bad method is refused outright', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id);
    await t.store.sources.update(source.id, { enabled: false });
    expect(await t.store.sources.accept(source.id, post({ id: 1 }))).toEqual({
      outcome: 'unavailable',
    });
    expect(await t.store.sources.accept('missing', post({ id: 1 }))).toEqual({
      outcome: 'unavailable',
    });
    expect(await requests()).toEqual([]);

    await t.store.sources.update(source.id, { enabled: true });
    const over = post('', { body: new Uint8Array(MAX_REQUEST_BODY_BYTES + 1) });
    await expect(t.store.sources.accept(source.id, over)).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(
      t.store.sources.accept(source.id, post({}, { method: 'GET /x' }))
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
    const atCap = post('', { body: new Uint8Array(MAX_REQUEST_BODY_BYTES) });
    expect((await t.store.sources.accept(source.id, atCap)).outcome).toBe('accepted');
  });

  test('NUL and a split surrogate in a header or the query cannot make a request fail', async () => {
    const source = await addSource(t);
    const pair = '😀';
    const long = `${'a'.repeat(MAX_REQUEST_VALUE_CHARS - 1)}${pair}`;
    const result = await t.store.sources.accept(
      source.id,
      post(
        {},
        {
          headers: { 'x-nul': 'a\0b', 'x-long': long, 'x-n\0ame': 'v' },
          query: { q: 'x\0y', '😀': long },
          contentType: 'text/plain\0',
        }
      )
    );
    expect(result.outcome).toBe('accepted');
    const [row] = await requests();
    expect(row!.headers['x-nul']).toBe('ab');
    expect(row!.headers['x-long']).toBe('a'.repeat(MAX_REQUEST_VALUE_CHARS - 1));
    expect(row!.query.q).toBe('xy');
    expect(row!.content_type).toBe('text/plain');
    const rejected = await t.store.sources.reject(
      source.id,
      post({}, { headers: { 'x-bad': 'a\0b' } }),
      'bad\0 cause'
    );
    expect(rejected.stored).toBe(true);
  });

  test('a rejected request keeps its cause and no body, and a source stores at most the cap a minute, counting the rest', async () => {
    const source = await addSource(t);
    const first = await t.store.sources.reject(
      source.id,
      post({ secret: 'x' }, { headers: { authorization: 'Bearer abc' } }),
      'signature does not match'
    );
    expect(first).toEqual({ stored: true });
    const [row] = await requests();
    expect(row).toMatchObject({
      status: 'rejected',
      cause: 'signature does not match',
      body: null,
      headers: { authorization: REDACTED },
    });

    for (let n = 1; n < MAX_REJECTED_PER_MINUTE; n += 1) {
      expect((await t.store.sources.reject(source.id, post({}), 'bad')).stored).toBe(true);
    }
    expect((await t.store.sources.reject(source.id, post({}), 'bad')).stored).toBe(false);
    expect((await t.store.sources.reject(source.id, post({}), 'bad')).stored).toBe(false);
    expect(await requests()).toHaveLength(MAX_REJECTED_PER_MINUTE);
    expect((await t.store.sources.get(source.id))!.rejectedDropped).toBe(2);

    t.clock.advance(REJECT_WINDOW_MS);
    expect((await t.store.sources.reject(source.id, post({}), 'bad')).stored).toBe(true);
    expect(await requests()).toHaveLength(MAX_REJECTED_PER_MINUTE + 1);
    expect(await t.store.sources.reject('missing', post({}), 'bad')).toEqual({ stored: false });
  });

  test('the rejected cap holds when rejections arrive at once from two processes', async () => {
    const source = await addSource(t);
    const second = t.another();
    const total = MAX_REJECTED_PER_MINUTE + 40;
    const results = await Promise.all(
      Array.from({ length: total }, (_, n) =>
        (n % 2 === 0 ? t.store : second).sources.reject(source.id, post({}), 'bad')
      )
    );
    expect(results.filter((r) => r.stored)).toHaveLength(MAX_REJECTED_PER_MINUTE);
    expect(await requests()).toHaveLength(MAX_REJECTED_PER_MINUTE);
    expect((await t.store.sources.get(source.id))!.rejectedDropped).toBe(40);
  });

  test('deleting a source takes its requests with it', async () => {
    const source = await addSource(t);
    await t.store.sources.accept(source.id, post({ id: 1 }));
    await t.store.sources.reject(source.id, post({}), 'bad');
    expect(await requests()).toHaveLength(2);
    expect(await t.store.sources.delete(source.id)).toBe(true);
    expect(await requests()).toEqual([]);
  });
});
