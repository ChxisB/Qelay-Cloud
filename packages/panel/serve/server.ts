import { createHash } from 'node:crypto';
import type { ServeSettings } from './config';
import type { StaticFile } from './files';
import { etagOf, staticFile } from './files';

/** The element the build leaves for a host to point at its mount (see `index.html`). */
const BASE_ELEMENT = /<base href="\/" data-qelay-base\s*\/>/;
const FILE_EXTENSION = /\.(?:js|mjs|css|map|json|svg|png|ico|woff2?|txt)$/i;
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'strict-transport-security': 'max-age=31536000',
};

const sha256 = (source: string): string =>
  `'sha256-${createHash('sha256').update(source).digest('base64')}'`;

/** `index.html` told where it is mounted. Throws if the build no longer leaves the base element. */
export function indexFor(html: string, mount: string): string {
  if (!BASE_ELEMENT.test(html)) {
    throw new Error('index.html has no <base data-qelay-base>: the build contract changed');
  }
  const href = mount === '/' ? '/' : `${mount}/`;
  const script =
    mount === '/' ? '' : `<script>globalThis.__QELAY_BASE_PATH__=${JSON.stringify(mount)}</script>`;
  return html.replace(BASE_ELEMENT, () => `<base href="${href}" />${script}`);
}

/**
 * The policy of the page. Scripts are the bundle plus the build's own inline scripts, each by hash,
 * so no `unsafe-inline` for scripts; styles allow inline because the UI sets style attributes.
 * `connect-src` is the API and the sign-in provider, nothing else.
 */
export function policyFor(html: string, settings: ServeSettings): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((match) => sha256(match[1] ?? ''));
  const connect = new Set<string>(["'self'", ...settings.connectExtra]);
  const { apiBaseUrl, auth } = settings.config;
  if (apiBaseUrl !== null && /^https?:/.test(apiBaseUrl)) connect.add(new URL(apiBaseUrl).origin);
  if (auth.mode === 'oidc') connect.add(new URL(auth.authority).origin);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...connect].join(' ')}`,
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface PanelHandlerOptions {
  readonly build: ReadonlyMap<string, StaticFile>;
  readonly settings: ServeSettings;
}

/**
 * The panel as a `fetch` handler: the build's files from memory, `/config.json` made from the
 * environment, `/health` for the platform's probe, and `index.html` for every other path under the
 * mount (the router's deep links). Under the mount only; anything else is 404.
 */
export function createPanelHandler(options: PanelHandlerOptions): (request: Request) => Response {
  const { build, settings } = options;
  const { mount } = settings;
  const html = indexFor(new TextDecoder().decode(build.get('/index.html')!.bytes), mount);
  // The policy hashes the page as served: the mount script `indexFor` injects is inline too.
  const policy = policyFor(html, settings);
  const index = staticFile('/index.html', new TextEncoder().encode(html));
  const configBytes = new TextEncoder().encode(JSON.stringify(settings.config));
  const config: StaticFile = {
    type: 'application/json',
    bytes: configBytes,
    gzip: null,
    etag: etagOf(configBytes),
  };

  const send = (
    request: Request,
    file: StaticFile,
    cache: string,
    extra: Record<string, string> = {}
  ): Response => {
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      ...extra,
      'content-type': file.type,
      'cache-control': cache,
      etag: file.etag,
      vary: 'accept-encoding',
    };
    if (request.headers.get('if-none-match') === file.etag) {
      return new Response(null, { status: 304, headers });
    }
    const gzip =
      file.gzip !== null && /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
    if (gzip) headers['content-encoding'] = 'gzip';
    const body = request.method === 'HEAD' ? null : gzip ? file.gzip! : file.bytes;
    return new Response(body as BodyInit | null, { status: 200, headers });
  };
  const plain = (status: number, message: string): Response =>
    new Response(message, {
      status,
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    });

  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json(
        { ok: true },
        { headers: { ...SECURITY_HEADERS, 'cache-control': 'no-store' } }
      );
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'method not allowed');
    }
    const under =
      mount === '/'
        ? pathname
        : pathname.startsWith(`${mount}/`)
          ? pathname.slice(mount.length)
          : pathname === mount
            ? '/'
            : null;
    if (under === null) return plain(404, 'not found');
    if (under === '/config.json') return send(request, config, 'no-store');
    const file = under === '/index.html' ? undefined : build.get(under);
    if (file !== undefined) {
      const hashed = under.startsWith('/assets/');
      return send(request, file, hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // A chunk or file that does not exist is a 404, not the app: a stale tab must fail loudly, not
    // get HTML as script. A queue name with a dot in a deep link is not a file.
    if (under.startsWith('/assets/') || FILE_EXTENSION.test(under)) {
      return plain(404, 'not found');
    }
    return send(request, index, 'no-cache', { 'content-security-policy': policy });
  };
}
