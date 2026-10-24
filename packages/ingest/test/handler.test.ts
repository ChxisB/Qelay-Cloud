import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createIngestHandler } from '../src';
import { chunks, handlerFor, hang, limits, NONE, PATH, send, stubStore, TOKEN } from './support';

const JSON_POST = {
  headers: { 'content-type': 'application/json' },
  body: '{"id":500,"name":"chris"}',
};
const NOT_FOUND = '{"error":"not_found"}';
const UNAUTHORIZED = '{"error":"unauthorized"}';

describe('a request that passes', () => {
  test('is stored whole and answered with its id, and nothing else is told', async () => {
    const { store, calls } = stubStore();
    const answer = await send(handlerFor(store), {
      path: `${PATH}?page=2&page=3&tag=a`,
      headers: { ...JSON_POST.headers, 'x-event': 'paid' },
      body: JSON_POST.body,
    });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe('{"id":"req_1"}');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(calls.accepted).toHaveLength(1);
    const { sourceId, request } = calls.accepted[0]!;
    expect(sourceId).toBe('src_1');
    expect(request).toMatchObject({
      method: 'POST',
      contentType: 'application/json',
      query: { page: '3', tag: 'a' },
      headers: { 'x-event': 'paid' },
    });
    expect(new TextDecoder().decode(request.body)).toBe(JSON_POST.body);
    expect(calls.rejected).toEqual([]);
  });

  test('PUT, PATCH and DELETE are taken as POST is, and an empty body is a request', async () => {
    const { store, calls } = stubStore();
    const handler = handlerFor(store);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST'])
      expect((await send(handler, { method })).status).toBe(200);
    expect(calls.accepted.map((call) => call.request.method)).toEqual([
      'PUT',
      'PATCH',
      'DELETE',
      'POST',
    ]);
    expect(calls.accepted[0]!.request.body).toHaveLength(0);
  });

  test('a body of exactly the cap is taken', async () => {
    const { store } = stubStore();
    const handler = handlerFor(store, { maxBodyBytes: 10 });
    expect((await send(handler, { body: '0123456789' })).status).toBe(200);
  });
});

describe('a URL that opens nothing', () => {
  test('has one answer, whatever the reason, and stores nothing', async () => {
    const reasons: Array<[string, Parameters<typeof send>[1], ReturnType<typeof stubStore>]> = [
      ['not a source path', { path: '/' }, stubStore()],
      ['another path', { path: '/sources' }, stubStore()],
      ['a short token', { path: '/s/qin_short' }, stubStore()],
      ['a trailing path', { path: `${PATH}/more` }, stubStore()],
      ["a token that is nobody's", {}, stubStore(null)],
      ['a source that is off', {}, stubStore({ ...NONE, enabled: false })],
      [
        'a source removed since the lookup',
        {},
        stubStore(NONE, { accept: async () => ({ outcome: 'unavailable' }) }),
      ],
    ];
    for (const [reason, request, { store, calls }] of reasons) {
      const answer = await send(handlerFor(store), { body: '{}', ...request });
      expect([reason, answer.status, answer.text]).toEqual([reason, 404, NOT_FOUND]);
      expect(calls.rejected, reason).toEqual([]);
    }
  });

  test('a method that is not taken is refused the same for every token, before the store is asked', async () => {
    for (const known of [true, false]) {
      const { store, calls } = stubStore(known ? NONE : null);
      const handler = handlerFor(store);
      for (const method of ['GET', 'OPTIONS', 'HEAD']) {
        const answer = await send(handler, { method });
        expect([method, answer.status]).toEqual([method, 405]);
        expect(answer.headers.get('allow')).toBe('POST, PUT, PATCH, DELETE');
      }
      expect(calls.lookups).toEqual([]);
    }
  });

  test('an over-long content type is a bad request, not stored', async () => {
    const { store, calls } = stubStore();
    const answer = await send(handlerFor(store), {
      headers: { 'content-type': `text/${'x'.repeat(256)}` },
      body: '{}',
    });
    expect(answer.status).toBe(400);
    expect(calls.accepted).toEqual([]);
    expect(calls.rejected).toEqual([]);
  });
});

describe('verification', () => {
  const signed = (kind: 'hmac' | 'api_key' | 'basic') => ({
    ...NONE,
    verification: {
      kind,
      header: kind === 'basic' ? null : 'x-signature',
      username: kind === 'basic' ? 'sender' : null,
    },
    secret: 'qsec_0123456789abcdef0123456789abcdef',
  });

  test('a wrong or missing credential has the same answer for every kind, and is stored with a cause and no body', async () => {
    for (const kind of ['hmac', 'api_key', 'basic'] as const) {
      const { store, calls } = stubStore(signed(kind));
      const handler = handlerFor(store);
      const wrong = { 'x-signature': 'nope', authorization: 'Basic bm9wZTpub3Bl' };
      for (const headers of [wrong, {}]) {
        const answer = await send(handler, { headers, body: JSON_POST.body });
        expect([kind, answer.status, answer.text]).toEqual([kind, 401, UNAUTHORIZED]);
      }
      expect(calls.accepted).toEqual([]);
      expect(calls.rejected.map((r) => r.cause)).toEqual([
        'verification failed',
        'verification failed',
      ]);
      expect(calls.rejected.every((r) => r.request.body.length === 0)).toBe(true);
    }
  });

  test('a source whose secret cannot be opened takes nothing', async () => {
    const { store, calls } = stubStore({
      ...signed('api_key'),
      secret: null,
      secretUnreadable: true,
    });
    const answer = await send(handlerFor(store), { headers: { 'x-signature': 'anything' } });
    expect(answer.status).toBe(401);
    expect(calls.accepted).toEqual([]);
  });

  test('the right signature of the raw body is accepted', async () => {
    const source = signed('hmac');
    const mac = createHmac('sha256', source.secret).update(JSON_POST.body).digest('hex');
    const { store, calls } = stubStore(source);
    const answer = await send(handlerFor(store), {
      ...JSON_POST,
      headers: { 'x-signature': `sha256=${mac}` },
    });
    expect(answer.status).toBe(200);
    expect(calls.accepted).toHaveLength(1);
  });
});

describe('size and time', () => {
  const refused = (calls: ReturnType<typeof stubStore>['calls'], cause: string) => {
    expect(calls.accepted).toEqual([]);
    expect(calls.rejected.map((r) => [r.cause, r.request.body.length])).toEqual([[cause, 0]]);
  };

  test('a declared length over the cap is refused before the body is read, and stored without it', async () => {
    const { store, calls } = stubStore();
    const answer = await send(handlerFor(store, { maxBodyBytes: 10 }), {
      headers: { 'content-length': '11' },
      body: '0123456789a',
    });
    expect([answer.status, answer.text]).toEqual([413, '{"error":"payload_too_large"}']);
    refused(calls, 'body too large');
  });

  test('a body that grows past the cap with no length declared is cut off', async () => {
    const { store, calls } = stubStore();
    const answer = await send(handlerFor(store, { maxBodyBytes: 100 }), { body: chunks(50, 10) });
    expect(answer.status).toBe(413);
    refused(calls, 'body too large');
  });

  test('a body that does not arrive in time is answered 408 and stored without it', async () => {
    const { store, calls } = stubStore();
    const answer = await send(handlerFor(store, { readTimeoutMs: 50 }), { body: hang() });
    expect([answer.status, answer.text]).toEqual([408, '{"error":"request_timeout"}']);
    refused(calls, 'body not received in time');
  });

  test('a failure to store the refusal does not change the answer', async () => {
    const { store } = stubStore(NONE, {
      reject: async () => {
        throw new Error('db down');
      },
    });
    const answer = await send(handlerFor(store, { maxBodyBytes: 1 }), { body: 'ab' });
    expect(answer.status).toBe(413);
  });
});

describe('rates', () => {
  const at = () => 60_000 * 100 + 1_000;

  test('a source over its minute gets 429 with a wait, and nothing is stored for it', async () => {
    const { store, calls } = stubStore();
    const handler = createIngestHandler({
      store,
      limits: limits({ perSourcePerMinute: 2 }),
      now: at,
    });
    expect([(await send(handler)).status, (await send(handler)).status]).toEqual([200, 200]);
    const third = await send(handler);
    expect([third.status, third.text, third.headers.get('retry-after')]).toEqual([
      429,
      '{"error":"rate_limited"}',
      '59',
    ]);
    expect(calls.accepted).toHaveLength(2);
    expect(calls.rejected).toEqual([]);
  });

  test('the whole process is limited before the store is asked, whatever the token', async () => {
    const { store, calls } = stubStore();
    const handler = createIngestHandler({ store, limits: limits({ globalPerMinute: 1 }), now: at });
    expect((await send(handler)).status).toBe(200);
    const other = `/s/qin_${'b'.repeat(43)}`;
    expect((await send(handler, { path: other })).status).toBe(429);
    expect(calls.lookups).toEqual([TOKEN]);
  });
});

describe('a store that fails', () => {
  const broken = (where: 'findByToken' | 'accept') =>
    stubStore(NONE, {
      [where]: async () => {
        throw new Error('password=hunter2 host=10.0.0.5');
      },
    });

  test('is answered 503 with a wait and nothing of the failure, and logged by kind only, once in a while', async () => {
    for (const where of ['findByToken', 'accept'] as const) {
      const logged: Array<Record<string, unknown>> = [];
      let now = 1_000_000;
      const handler = createIngestHandler({
        store: broken(where).store,
        limits: limits(),
        log: (entry) => logged.push(entry),
        now: () => now,
      });
      const answer = await send(handler, { body: '{}' });
      expect([answer.status, answer.text, answer.headers.get('retry-after')]).toEqual([
        503,
        '{"error":"unavailable"}',
        '5',
      ]);
      await send(handler, { body: '{}' });
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toContain('hunter2');
      expect(JSON.stringify(logged)).not.toContain('10.0.0.5');
      now += 10_000;
      await send(handler, { body: '{}' });
      expect(logged).toHaveLength(2);
    }
  });
});

describe('/healthz', () => {
  test('answers GET without asking the store, and nothing else', async () => {
    const { store, calls } = stubStore();
    const handler = handlerFor(store);
    expect(await send(handler, { method: 'GET', path: '/healthz' })).toMatchObject({
      status: 200,
      text: '{"ok":true}',
    });
    expect((await send(handler, { method: 'POST', path: '/healthz' })).status).toBe(405);
    expect(calls.lookups).toEqual([]);
  });
});
