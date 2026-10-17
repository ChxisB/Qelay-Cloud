import { describe, expect, test } from 'bun:test';
import { DEV_TOKEN, harness } from './support';

describe('CORS', () => {
  const origin = 'https://panel.example.com';
  const api = () => harness({ corsOrigins: [origin] });

  test('a listed origin gets its own origin echoed, Vary, and never credentials or a wildcard', async () => {
    const response = await api().call('GET', '/test/read', { headers: { origin } });
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-expose-headers')).toContain('retry-after');
  });

  test('another origin is served without CORS headers, so the browser blocks it', async () => {
    const response = await api().call('GET', '/test/read', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('an error response to a listed origin carries the headers too, so the panel can read it', async () => {
    const response = await api().call('GET', '/test/read', { token: null, headers: { origin } });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  });

  test('a preflight from a listed origin is 204 with methods and headers, and needs no token', async () => {
    const response = await api().call('OPTIONS', '/test/write', {
      token: null,
      headers: { origin, 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('a preflight from any other origin, or with none, is 403', async () => {
    const h = api();
    for (const headers of <Record<string, string>[]>[{ origin: 'https://evil.example.com' }, {}]) {
      const response = await h.call('OPTIONS', '/test/write', { token: null, headers });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('with no origins configured no CORS header is ever sent', async () => {
    const response = await harness().call('GET', '/test/read', { headers: { origin } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('the request log', () => {
  test('one record per request: the route pattern, the status, a hashed principal, no path, no body', async () => {
    const api = harness(
      {},
      {
        routes: [
          {
            method: 'POST',
            path: '/test/q/:queue/jobs',
            access: 'write',
            handle: () => ({ ok: true }),
          },
        ],
      }
    );
    // A request id is random hex (or the caller's), so it can spell a word the check below looks for.
    await api.call('POST', '/test/q/secret-queue-name/jobs?token=abc', {
      body: { payload: 'card-4111' },
      headers: { 'x-request-id': 'request-with-abc-in-it' },
    });
    await api.call('GET', '/test/unknown-path-123', { token: null });
    const [ok, refused] = api.recorded.requests;
    expect(api.recorded.requests).toHaveLength(2);
    expect(ok).toMatchObject({
      method: 'POST',
      route: '/test/q/:queue/jobs',
      status: 200,
      role: 'operator',
    });
    expect(ok?.principal).toMatch(/^[0-9a-f]{12}$/);
    expect(ok?.principal).not.toContain('dev-token');
    expect(refused).toMatchObject({ route: 'unmatched', status: 401, errorCode: 'unauthorized' });
    // The id is the one field that is not about the request's content; it is checked on its own.
    const text = JSON.stringify(api.recorded.requests.map(({ requestId: _id, ...rest }) => rest));
    for (const secret of ['secret-queue-name', 'abc', 'card-4111', DEV_TOKEN, 'unknown-path-123']) {
      expect(text).not.toContain(secret);
    }
  });

  test('a caller-sent request id is kept when it is well formed, and replaced when it is not', async () => {
    const api = harness();
    const kept = await api.call('GET', '/test/read', {
      headers: { 'x-request-id': 'req-abcdef123456' },
    });
    expect(kept.headers.get('x-request-id')).toBe('req-abcdef123456');
    const replaced = await api.call('GET', '/test/read', {
      headers: { 'x-request-id': 'bad id\twith spaces' },
    });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.recorded.requests.map((r) => r.requestId)).toEqual([
      'req-abcdef123456',
      replaced.headers.get('x-request-id') as string,
    ]);
  });

  test('every response is marked nosniff and no-store', async () => {
    const response = await harness().call('GET', '/test/read');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
