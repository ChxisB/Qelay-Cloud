import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFromEnv } from '../serve/config';
import { loadBuild } from '../serve/files';
import { createPanelHandler, indexFor, policyFor } from '../serve/server';

const INDEX = `<!doctype html><html><head>
<base href="/" data-qelay-base />
<script>try { localStorage.getItem('theme'); } catch {}</script>
<script type="module" crossorigin src="./assets/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`;

const OIDC = {
  QCLOUD_PANEL_API_BASE_URL: 'https://api.example.com',
  QCLOUD_PANEL_OIDC_AUTHORITY: 'https://login.example.com/realms/qcloud',
  QCLOUD_PANEL_OIDC_CLIENT_ID: 'qcloud-panel',
};

let dist: string;
beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'qcloud-panel-'));
  mkdirSync(join(dist, 'assets'));
  mkdirSync(join(dist, '.vite'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index-abc.js'), `export const x = "${'a'.repeat(4000)}";`);
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, '.vite', 'manifest.json'), '{}');
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const handler = (env: Record<string, string> = OIDC) =>
  createPanelHandler({ build: loadBuild(dist), settings: settingsFromEnv(env) });
// The handler answers synchronously; the call is async so a test reads it like a fetch.
const get = async (
  h: ReturnType<typeof handler>,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> => h(new Request(`http://panel.test${path}`, { headers }));

describe('settingsFromEnv', () => {
  test('builds a public config.json from the environment', () => {
    const settings = settingsFromEnv({ ...OIDC, QCLOUD_PANEL_OIDC_AUDIENCE: 'qcloud-api' });
    expect(settings.config).toEqual({
      apiBaseUrl: 'https://api.example.com',
      auth: {
        mode: 'oidc',
        authority: 'https://login.example.com/realms/qcloud',
        clientId: 'qcloud-panel',
        scope: 'openid profile',
        audience: 'qcloud-api',
      },
    });
    expect([settings.hostname, settings.port, settings.mount]).toEqual(['127.0.0.1', 8080, '/']);
  });

  test.each([
    [
      'no API URL',
      { ...OIDC, QCLOUD_PANEL_API_BASE_URL: '' },
      /QCLOUD_PANEL_API_BASE_URL is required/,
    ],
    [
      'a plaintext API off localhost',
      { ...OIDC, QCLOUD_PANEL_API_BASE_URL: 'http://api.example.com' },
      /must be https/,
    ],
    [
      'oidc without a client id',
      { ...OIDC, QCLOUD_PANEL_OIDC_CLIENT_ID: '' },
      /CLIENT_ID are required/,
    ],
    [
      'a plaintext authority',
      { ...OIDC, QCLOUD_PANEL_OIDC_AUTHORITY: 'http://login.example.com' },
      /must be https/,
    ],
    ['an unknown mode', { ...OIDC, QCLOUD_PANEL_AUTH_MODE: 'basic' }, /"oidc" or "token"/],
    ['a path-traversing mount', { ...OIDC, QCLOUD_PANEL_BASE_PATH: '/a/../b' }, /plain path/],
    ['a bad port', { ...OIDC, QCLOUD_PANEL_PORT: '99999' }, /port number/],
    [
      'a plaintext connect extra',
      { ...OIDC, QCLOUD_PANEL_CSP_CONNECT_EXTRA: 'http://idp.example.com' },
      /must be https/,
    ],
  ])('refuses %s', (_name, env, message) => {
    expect(() => settingsFromEnv(env)).toThrow(message);
  });

  test('token mode needs no OIDC settings, and a local API may be plain http', () => {
    const settings = settingsFromEnv({
      QCLOUD_PANEL_API_BASE_URL: 'http://127.0.0.1:8080',
      QCLOUD_PANEL_AUTH_MODE: 'token',
    });
    expect(settings.config).toEqual({
      apiBaseUrl: 'http://127.0.0.1:8080',
      auth: { mode: 'token' },
    });
  });
});

describe('the panel handler', () => {
  test('serves /config.json, uncached, with nothing but the public settings', async () => {
    const response = await get(handler(), '/config.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ apiBaseUrl: 'https://api.example.com' });
  });

  test('serves hashed assets immutably and gzips what is worth it', async () => {
    const response = await get(handler(), '/assets/index-abc.js', { 'accept-encoding': 'gzip' });
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const plain = await get(handler(), '/assets/index-abc.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect((await plain.text()).length).toBeGreaterThan(4000);
  });

  test('answers a repeat request with 304 on the etag', async () => {
    const h = handler();
    const first = await get(h, '/assets/index-abc.js');
    const again = await get(h, '/assets/index-abc.js', {
      'if-none-match': first.headers.get('etag')!,
    });
    expect(again.status).toBe(304);
  });

  test('a missing asset is 404, not the app', async () => {
    for (const path of ['/assets/gone-123.js', '/missing.css', '/.vite/manifest.json']) {
      expect((await get(handler(), path)).status).toBe(404);
    }
  });

  test('every other path is the app, with the policy, and a queue name with a dot is not a file', async () => {
    for (const path of ['/', '/queues', '/queues/emails.v2/jobs/17', '/index.html']) {
      const response = await get(handler(), path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await response.text()).toContain('<div id="root">');
    }
  });

  test('the policy hashes the inline script and allows only the API and the provider to connect', () => {
    const policy = policyFor(
      INDEX,
      settingsFromEnv({ ...OIDC, QCLOUD_PANEL_CSP_CONNECT_EXTRA: 'https://idp-tokens.example.com' })
    );
    expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(policy).toContain(
      "connect-src 'self' https://idp-tokens.example.com https://api.example.com https://login.example.com"
    );
    expect(policy).toContain("default-src 'none'");
  });

  test('/health needs nothing and says nothing', async () => {
    const response = await get(handler(), '/health');
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  test('only GET and HEAD', async () => {
    const response = handler()(new Request('http://panel.test/', { method: 'POST' }));
    expect(response.status).toBe(405);
    const head = handler()(new Request('http://panel.test/', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  test('under a mount: the base and router mount follow, and outside it is 404', async () => {
    const h = handler({ ...OIDC, QCLOUD_PANEL_BASE_PATH: '/qcloud' });
    const page = await (await get(h, '/qcloud/queues/emails')).text();
    expect(page).toContain('<base href="/qcloud/" />');
    expect(page).toContain('__QELAY_BASE_PATH__="/qcloud"');
    expect((await get(h, '/qcloud/config.json')).status).toBe(200);
    expect((await get(h, '/qcloud')).status).toBe(200);
    expect((await get(h, '/queues')).status).toBe(404);
    expect((await get(h, '/qcloudx')).status).toBe(404);
    // The mount script is inline, so it is hashed into the policy beside the build's own.
    const mounted = (await get(h, '/qcloud/')).headers.get('content-security-policy')!;
    expect(mounted.match(/'sha256-/g)).toHaveLength(2);
    const root = (await get(handler(), '/')).headers.get('content-security-policy')!;
    expect(root.match(/'sha256-/g)).toHaveLength(1);
  });
});

describe('indexFor and the build', () => {
  test('refuses an index with no base element, so a changed build fails at start', () => {
    expect(() => indexFor('<html><head></head></html>', '/')).toThrow(/build contract/);
  });

  test('refuses a directory with no index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'qcloud-panel-empty-'));
    try {
      expect(() => loadBuild(empty)).toThrow(/no index.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('listens for real and serves the same answers', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler() });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/queues/q`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('id="root"');
    } finally {
      await server.stop(true);
    }
  });
});
