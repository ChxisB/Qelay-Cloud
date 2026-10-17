/**
 * The built panel under two mounts (`E2E_BASE_PATH` for the operator, `E2E_VIEWER_BASE_PATH` for the
 * viewer), each with `/api` proxied to its own Control API, served with the policy a deployment sends.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { indexFor as renderIndex, policyFor } from '../serve/server';
import {
  E2E_API_PORT,
  E2E_BASE_PATH,
  E2E_DASHBOARD_PORT,
  E2E_LOOPBACK_HOST,
  E2E_VIEWER_API_PORT,
  E2E_VIEWER_BASE_PATH,
} from './config';

const DIST = resolve(import.meta.dir, '../dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 ? MIME[path.slice(dot)] : undefined) ?? 'application/octet-stream';
}

/**
 * `index.html` as the production server renders it (`serve/server.ts`), with the policy it sends, so
 * the browser specs run under the same Content-Security-Policy as a deployment.
 */
function indexFor(mount: string): Response {
  const html = renderIndex(readFileSync(join(DIST, 'index.html'), 'utf8'), mount);
  const policy = policyFor(html, {
    config: { apiBaseUrl: `${mount}/api`, auth: { mode: 'token' } },
    hostname: E2E_LOOPBACK_HOST,
    port: E2E_DASHBOARD_PORT,
    mount,
    connectExtra: [],
  });
  return new Response(html, {
    headers: {
      'content-type': mimeOf('.html'),
      'cache-control': 'no-store',
      'content-security-policy': policy,
    },
  });
}

async function proxy(request: Request, prefix: string, port: number): Promise<Response> {
  const url = new URL(request.url);
  const target = `http://${E2E_LOOPBACK_HOST}:${port}${url.pathname.slice(prefix.length)}${url.search}`;
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch {
    return new Response('upstream unavailable', { status: 502 });
  }
}

function serveMount(
  request: Request,
  mount: string,
  apiPort: number
): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  const rest = pathname.slice(mount.length);
  if (rest === '/api' || rest.startsWith('/api/')) return proxy(request, `${mount}/api`, apiPort);
  if (rest === '/config.json') {
    return Response.json(
      { apiBaseUrl: `${mount}/api`, auth: { mode: 'token' } },
      { headers: { 'cache-control': 'no-store' } }
    );
  }
  const file = normalize(join(DIST, rest));
  if (
    rest !== '' &&
    rest !== '/' &&
    file.startsWith(DIST) &&
    existsSync(file) &&
    !file.endsWith('/')
  ) {
    const bytes = readFileSync(file);
    return new Response(bytes, { headers: { 'content-type': mimeOf(file) } });
  }
  // Assets that do not exist are 404s, not the app: a stale chunk must fail loudly.
  if (rest.startsWith('/assets/')) return new Response('not found', { status: 404 });
  return indexFor(mount);
}

export function servePanel() {
  return Bun.serve({
    hostname: E2E_LOOPBACK_HOST,
    port: E2E_DASHBOARD_PORT,
    idleTimeout: 255,
    fetch(request) {
      const { pathname } = new URL(request.url);
      for (const [mount, port] of [
        [E2E_BASE_PATH, E2E_API_PORT],
        [E2E_VIEWER_BASE_PATH, E2E_VIEWER_API_PORT],
      ] as const) {
        if (pathname === mount || pathname.startsWith(`${mount}/`))
          return serveMount(request, mount, port);
      }
      return new Response('not found', { status: 404 });
    },
  });
}
