import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test/support/clock';
import { DEV_TOKEN, harness, read, write } from './support';

const clock = new ManualClock();

describe('the development token', () => {
  test('is accepted as an operator by default and as a viewer when configured so', async () => {
    const operator = harness({}, {}, clock);
    expect((await write(operator, DEV_TOKEN)).status).toBe(200);
    const viewer = harness({ devToken: { token: DEV_TOKEN, role: 'viewer' } }, {}, clock);
    expect((await read(viewer, DEV_TOKEN)).status).toBe(200);
    expect((await write(viewer, DEV_TOKEN)).status).toBe(403);
  });

  test('a wrong token, a prefix of the token and the token plus more are refused', async () => {
    const api = harness({}, {}, clock);
    for (const token of [`${DEV_TOKEN}x`, DEV_TOKEN.slice(0, -1), 'x'.repeat(DEV_TOKEN.length)]) {
      expect((await read(api, token)).status).toBe(401);
    }
  });

  test('enabling it is logged as a warning, once', () => {
    const api = harness({}, {}, clock);
    expect(api.recorded.warnings.map((w) => w.message)).toEqual([
      'the development token is enabled: use it for local development only',
    ]);
  });
});

describe('unauthenticated requests', () => {
  const api = () => harness({}, {}, clock);

  test('everything except GET /health answers 401, including paths and methods that do not exist', async () => {
    const h = api();
    const paths = h.app.routes
      .filter((route) => !(route.method === 'GET' && route.path === '/health'))
      .map((route) => ({ method: route.method, path: route.path.replace(/:[^/]+/g, 'x') }));
    paths.push(
      { method: 'GET', path: '/no/such/route' },
      { method: 'DELETE', path: '/health' },
      { method: 'POST', path: '/health' },
      { method: 'GET', path: '/' }
    );
    for (const { method, path } of paths) {
      const response = await h.call(method, path, { token: null });
      expect([method, path, response.status]).toEqual([method, path, 401]);
    }
  });

  test('GET /health needs no token and says nothing about jobs', async () => {
    const response = await api().call('GET', '/health', { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: 'healthy',
      version: '0.0.0-test',
      uptime: 0,
    });
  });

  test('a wrong scheme, an empty token and a cookie do not authenticate', async () => {
    const h = api();
    for (const headers of <Record<string, string>[]>[
      { authorization: `Basic ${DEV_TOKEN}` },
      { authorization: 'Bearer ' },
      { authorization: DEV_TOKEN },
      { cookie: `token=${DEV_TOKEN}` },
    ]) {
      const response = await h.call('GET', '/test/read', { token: null, headers });
      expect(response.status).toBe(401);
    }
  });

  test('an oversized Authorization header is refused without being checked', async () => {
    const response = await api().call('GET', '/test/read', { token: 'a'.repeat(9_000) });
    expect(response.status).toBe(401);
  });
});
