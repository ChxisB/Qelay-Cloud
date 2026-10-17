import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ManualClock } from '../../../test/support/clock';
import type { Route } from '../src';
import {
  AUDIENCE,
  bodyOf,
  DEV_TOKEN,
  errorOf,
  harness,
  ISSUER,
  TestIssuer,
  testRoutes,
} from './support';

describe('routing', () => {
  test('an unknown path is 404 once authenticated, and a known path with the wrong method is 405 with Allow', async () => {
    const api = harness();
    const missing = await api.call('GET', '/test/nothing');
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).error.code).toBe('not_found');
    const wrong = await api.call('DELETE', '/test/read');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    expect((await errorOf(wrong)).error.code).toBe('method_not_allowed');
  });

  test('a trailing slash and a percent-encoded parameter are matched', async () => {
    const api = harness(
      {},
      {
        routes: [
          {
            method: 'GET',
            path: '/test/item/:id',
            access: 'read',
            handle: (c) => ({ id: c.params.id }),
          },
        ],
      }
    );
    expect(await bodyOf<unknown>(await api.call('GET', '/test/item/a%2Fb%20c/'))).toEqual({
      id: 'a/b c',
    });
    expect((await api.call('GET', '/test/item/%E0%A4%A')).status).toBe(404);
  });
});

describe('request bodies', () => {
  const calls: number[] = [];
  const counting: Route = {
    method: 'POST',
    path: '/test/count',
    access: 'write',
    handle: async (c) => {
      calls.push(1);
      return { got: (await c.json(z.object({ a: z.string() }))).a };
    },
  };
  const small: Route = { ...counting, path: '/test/small', maxBodyBytes: 20 };
  const api = () => harness({ maxBodyBytes: 100 }, { routes: [counting, small, ...testRoutes()] });

  test('a valid JSON body is parsed', async () => {
    expect(
      await bodyOf<unknown>(await api().call('POST', '/test/write', { body: { name: 'abc' } }))
    ).toEqual({ name: 'abc' });
  });

  test('invalid JSON is 400 invalid_json, and a body that does not fit is 400 with the field named', async () => {
    const h = api();
    const bad = await h.call('POST', '/test/write', {
      raw: '{nope',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).error.code).toBe('invalid_json');
    const wrong = await h.call('POST', '/test/write', { body: { name: 5 } });
    expect(wrong.status).toBe(400);
    const body = await errorOf(wrong);
    expect(body.error.code).toBe('invalid_request');
    expect(JSON.stringify(body)).toContain('name');
  });

  test('the answer to a bad body does not echo the rejected value', async () => {
    const response = await api().call('POST', '/test/write', {
      body: { name: 5, secret: 'hunter2' },
    });
    expect(await response.text()).not.toContain('hunter2');
  });

  test('a body that is not application/json is 415', async () => {
    const response = await api().call('POST', '/test/write', {
      raw: '{"name":"a"}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(415);
  });

  test('a body over the cap by Content-Length is refused with 413 before the handler runs', async () => {
    const h = api();
    calls.length = 0;
    const big = JSON.stringify({ a: 'x'.repeat(500) });
    const response = await h.call('POST', '/test/count', {
      raw: big,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).error.code).toBe('payload_too_large');
    expect(calls).toHaveLength(0);
  });

  test('a streamed body with no Content-Length is cut off at the cap', async () => {
    const h = api();
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(40));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request('http://api.test/test/count', {
      method: 'POST',
      headers: { authorization: `Bearer ${DEV_TOKEN}`, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    const response = await h.app.handle(request);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(50);
  });

  test('a route can set its own, smaller cap', async () => {
    const h = api();
    const ok = await h.call('POST', '/test/small', { body: { a: 'x' } });
    expect(ok.status).toBe(200);
    const big = await h.call('POST', '/test/small', { body: { a: 'x'.repeat(30) } });
    expect(big.status).toBe(413);
  });

  test('the socket cap is the largest any route takes', () => {
    const wide = harness(
      { maxBodyBytes: 100 },
      { routes: [{ ...counting, path: '/test/wide', maxBodyBytes: 5_000 }] }
    );
    expect(wide.app.maxBodyBytes).toBe(5_000);
    expect(api().app.maxBodyBytes).toBe(100);
  });

  test('a body that is not valid UTF-8 is 400', async () => {
    const request = new Request('http://api.test/test/write', {
      method: 'POST',
      headers: { authorization: `Bearer ${DEV_TOKEN}`, 'content-type': 'application/json' },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    const response = await api().app.handle(request);
    expect(response.status).toBe(400);
  });
});

describe('time limits', () => {
  test('a read that does not finish in time is 504 timeout', async () => {
    const response = await harness().call('GET', '/test/slow');
    expect(response.status).toBe(504);
    const body = await errorOf(response);
    expect(body.error.code).toBe('timeout');
    expect(body.error.message).not.toContain('unknown');
  });

  test('a write that does not finish says that its outcome is unknown', async () => {
    const response = await harness().call('POST', '/test/slow-write', { body: {} });
    expect(response.status).toBe(504);
    expect((await errorOf(response)).error.message).toContain('unknown');
  });

  test('the handler is told to stop through its signal', async () => {
    let signal: AbortSignal | undefined;
    const api = harness(
      {},
      {
        routes: [
          {
            method: 'GET',
            path: '/test/hang',
            access: 'read',
            timeoutMs: 10,
            handle: (c) => {
              signal = c.signal;
              return new Promise(() => {});
            },
          },
        ],
      }
    );
    await api.call('GET', '/test/hang');
    expect(signal?.aborted).toBe(true);
  });

  test('the default limit applies to a route that sets none', async () => {
    const api = harness(
      { requestTimeoutMs: 15 },
      {
        routes: [
          {
            method: 'GET',
            path: '/test/hang',
            access: 'read',
            handle: () => new Promise(() => {}),
          },
        ],
      }
    );
    expect((await api.call('GET', '/test/hang')).status).toBe(504);
  });
});

describe('rate limiting of writes', () => {
  const clock = new ManualClock();
  let issuer: TestIssuer;
  beforeAll(async () => {
    issuer = await TestIssuer.start(clock);
  });
  afterAll(() => issuer.stop());

  const write = (api: ReturnType<typeof harness>, token = DEV_TOKEN) =>
    api.call('POST', '/test/write', { token, body: { name: 'a' } });

  test('a principal past its burst gets 429 with Retry-After, and refills over time', async () => {
    const api = harness({ rateLimit: { burst: 2, perSecond: 1 } }, {}, new ManualClock());
    expect((await write(api)).status).toBe(200);
    expect((await write(api)).status).toBe(200);
    const limited = await write(api);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect((await errorOf(limited)).error.code).toBe('rate_limited');
    api.clock.advance(1_000);
    expect((await write(api)).status).toBe(200);
    expect((await write(api)).status).toBe(429);
  });

  test('reads are not limited, and a refused write does not run the handler', async () => {
    let runs = 0;
    const api = harness(
      { rateLimit: { burst: 1, perSecond: 1 } },
      {
        routes: [
          { method: 'POST', path: '/test/w', access: 'write', handle: () => ++runs },
          ...testRoutes(),
        ],
      }
    );
    expect((await api.call('POST', '/test/w', { body: {} })).status).toBe(200);
    expect((await api.call('POST', '/test/w', { body: {} })).status).toBe(429);
    expect(runs).toBe(1);
    for (let i = 0; i < 20; i++) expect((await api.call('GET', '/test/read')).status).toBe(200);
  });

  test('the budget belongs to the principal, not to the instance', async () => {
    const api = harness(
      {
        rateLimit: { burst: 1, perSecond: 1 },
        oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: issuer.jwksUrl },
        devToken: undefined,
      },
      {},
      clock
    );
    const alice = await issuer.token({ sub: 'alice' });
    const bob = await issuer.token({ sub: 'bob' });
    expect((await write(api, alice)).status).toBe(200);
    expect((await write(api, alice)).status).toBe(429);
    expect((await write(api, bob)).status).toBe(200);
  });

  test('a viewer is refused before it uses any budget', async () => {
    const api = harness({
      devToken: { token: DEV_TOKEN, role: 'viewer' },
      rateLimit: { burst: 1, perSecond: 1 },
    });
    for (let i = 0; i < 3; i++) expect((await write(api)).status).toBe(403);
  });

  test('the limit can be turned off', async () => {
    const api = harness({ rateLimit: false });
    for (let i = 0; i < 300; i++) expect((await write(api)).status).toBe(200);
  });
});
