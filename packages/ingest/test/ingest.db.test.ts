import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MAX_REJECTED_PER_MINUTE } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import { addRoute, addSource, requestDeliveries } from '../../store-postgres/test/inboundHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { CLAIM, KEY } from '../../store-postgres/test/webhookHelpers';
import { createIngestHandler } from '../src';
import { limits, send } from './support';

const BODY = '{"id":500,"name":"chris"}';
const JSON_TYPE = { 'content-type': 'application/json' };

describeDb('the ingest over the real store', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ webhookKey: KEY });
  });
  afterAll(() => t.drop());
  beforeEach(() => resetTables(t));

  const handler = (over: Parameters<typeof limits>[0] = {}) =>
    createIngestHandler({ store: t.store.sources, limits: limits(over) });
  const pathOf = (token: string | null) => `/s/${token}`;
  const stored = (id: string) => t.store.sources.request(id);

  test('a request is stored as sent and offered to each route of its source, unchanged without a shape', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id);
    await addRoute(t, source.id, { url: 'https://other.example.com/in' });
    const answer = await send(handler(), {
      path: `${pathOf(source.token)}?page=2`,
      headers: { ...JSON_TYPE, authorization: 'Bearer abc', cookie: 'a=b', 'x-event': 'paid' },
      body: BODY,
    });
    expect(answer.status).toBe(200);
    const { id } = JSON.parse(answer.text);
    const request = (await stored(id))!;
    expect(request).toMatchObject({
      status: 'accepted',
      method: 'POST',
      contentType: 'application/json',
      query: { page: '2' },
    });
    expect(new TextDecoder().decode(request.body!)).toBe(BODY);
    expect(request.headers).toMatchObject({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-event': 'paid',
    });
    expect(JSON.stringify(request)).not.toContain('abc');
    // No shape: the delivery keeps no copy, and the sender takes the request's own bytes and content type.
    const claimed = await t.store.webhooks.claimDue(CLAIM);
    expect(claimed).toHaveLength(2);
    expect(claimed.map((c) => [c.requestId, c.requestContentType, c.body])).toEqual([
      [id, 'application/json', null],
      [id, 'application/json', null],
    ]);
    expect(claimed.map((c) => new TextDecoder().decode(c.requestBody!))).toEqual([BODY, BODY]);
  });

  test("a token that is nobody's, a source that is off and one that was removed answer alike", async () => {
    const off = await addSource(t, { name: 'Off' });
    await t.store.sources.update(off.id, { enabled: false });
    const gone = await addSource(t, { name: 'Gone' });
    await t.store.sources.delete(gone.id);
    const answers = [
      await send(handler(), { path: pathOf(`qin_${'z'.repeat(43)}`), body: BODY }),
      await send(handler(), { path: pathOf(off.token), body: BODY }),
      await send(handler(), { path: pathOf(gone.token), body: BODY }),
    ];
    expect(answers.map((a) => [a.status, a.text])).toEqual([
      [404, '{"error":"not_found"}'],
      [404, '{"error":"not_found"}'],
      [404, '{"error":"not_found"}'],
    ]);
    expect((await t.store.sources.requests()).items).toEqual([]);
  });

  test('a rotated-out URL token stops at once, the new one works', async () => {
    const source = await addSource(t);
    const rotated = (await t.store.sources.rotateToken(source.id))!;
    expect((await send(handler(), { path: pathOf(source.token), body: BODY })).status).toBe(404);
    expect((await send(handler(), { path: pathOf(rotated.token), body: BODY })).status).toBe(200);
  });

  describe('verification with sealed secrets', () => {
    const kinds = {
      hmac: { kind: 'hmac', header: 'X-Signature' },
      api_key: { kind: 'api_key', header: 'X-Api-Key' },
      basic: { kind: 'basic', username: 'sender' },
    } as const;
    const credential = (
      kind: keyof typeof kinds,
      secret: string,
      body = BODY
    ): Record<string, string> =>
      kind === 'hmac'
        ? { 'x-signature': createHmac('sha256', secret).update(body).digest('hex') }
        : kind === 'api_key'
          ? { 'x-api-key': secret }
          : { authorization: `Basic ${Buffer.from(`sender:${secret}`).toString('base64')}` };

    for (const kind of ['hmac', 'api_key', 'basic'] as const) {
      test(`${kind}: the right credential is taken, a wrong one is 401 and stored as rejected`, async () => {
        const source = await addSource(t, { name: kind, verification: kinds[kind] });
        const secret = source.secret!;
        const path = pathOf(source.token);
        const good = await send(handler(), {
          path,
          headers: { ...JSON_TYPE, ...credential(kind, secret) },
          body: BODY,
        });
        expect(good.status).toBe(200);
        const bad = await send(handler(), {
          path,
          headers: { ...JSON_TYPE, ...credential(kind, `${secret}x`) },
          body: BODY,
        });
        expect([bad.status, bad.text]).toEqual([401, '{"error":"unauthorized"}']);
        const rejected = (await t.store.sources.requests({ status: 'rejected' })).items;
        expect(rejected.map((r) => r.cause)).toEqual(['verification failed']);
        const detail = (await stored(rejected[0]!.id))!;
        expect(detail.body).toBeNull();
        expect(JSON.stringify(detail)).not.toContain(secret);
      });
    }

    test('the credential header is stored redacted, and the secret before a rotation still verifies', async () => {
      const source = await addSource(t, { name: 'signed', verification: kinds.hmac });
      const before = source.secret!;
      const rotated = (await t.store.sources.rotateSecret(source.id))!;
      const path = pathOf(source.token);
      for (const secret of [before, rotated.secret!]) {
        const answer = await send(handler(), {
          path,
          headers: credential('hmac', secret),
          body: BODY,
        });
        expect(answer.status).toBe(200);
        expect((await stored(JSON.parse(answer.text).id))!.headers['x-signature']).toBe(
          '[redacted]'
        );
      }
    });
  });

  test('refused requests are stored up to the minute cap and then only counted; a 429 stores nothing', async () => {
    const source = await addSource(t, { verification: { kind: 'api_key', header: 'x-key' } });
    const path = pathOf(source.token);
    const flood = handler({ perSourcePerMinute: MAX_REJECTED_PER_MINUTE + 10 });
    for (let i = 0; i < MAX_REJECTED_PER_MINUTE + 5; i += 1) {
      expect((await send(flood, { path, headers: { 'x-key': 'wrong' }, body: BODY })).status).toBe(
        401
      );
    }
    const kept = (await t.store.sources.requests({ status: 'rejected', limit: 200 })).items;
    expect(kept).toHaveLength(MAX_REJECTED_PER_MINUTE);
    expect((await t.store.sources.get(source.id))!.rejectedDropped).toBe(5);

    const slow = handler({ perSourcePerMinute: 1 });
    expect((await send(slow, { path, headers: { 'x-key': 'wrong' }, body: BODY })).status).toBe(
      401
    );
    const before = (await t.store.sources.get(source.id))!.rejectedDropped;
    expect((await send(slow, { path, headers: { 'x-key': 'wrong' }, body: BODY })).status).toBe(
      429
    );
    expect((await t.store.sources.get(source.id))!.rejectedDropped).toBe(before);
  });

  test('a body over the cap is stored as rejected with no body, and nothing is made for the routes', async () => {
    const source = await addSource(t);
    await addRoute(t, source.id);
    const answer = await send(handler({ maxBodyBytes: 8 }), {
      path: pathOf(source.token),
      body: BODY,
    });
    expect(answer.status).toBe(413);
    const [row] = (await t.store.sources.requests()).items;
    expect(row).toMatchObject({ status: 'rejected', cause: 'body too large' });
    expect((await stored(row!.id))!.body).toBeNull();
    expect(await requestDeliveries(t)).toEqual([]);
  });
});
