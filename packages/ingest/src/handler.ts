import type { InboundRequest, SourceApi } from '@qelay-cloud/store-postgres';
import { readBody } from './body';
import type { IngestLimits } from './config';
import { MinuteLimiter } from './rateLimit';
import { verifies } from './verify';

/** The store calls the ingest makes: look a source up by its URL token, store a request, store a refused one. */
export type IngestStore = Pick<SourceApi, 'findByToken' | 'accept' | 'reject'>;

export interface IngestOptions {
  readonly store: IngestStore;
  readonly limits: IngestLimits;
  /** Told of a failure, never of a request: no header, body, token or path reaches it. */
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly now?: () => number;
}

/** The URL of a source is `/s/<token>`; anything that is not that shape never reaches the database. */
const TOKEN_PATH = /^\/s\/(qin_[A-Za-z0-9_-]{43})$/u;
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOW = [...METHODS].join(', ');
/** The longest `Content-Type` taken; a longer one is not a media type. */
const MAX_CONTENT_TYPE_CHARS = 255;
const EMPTY = new Uint8Array(0);
const LOG_EVERY_MS = 10_000;

const reply = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });

// One body for every request the URL does not open, so a token that does not exist, one that was switched off and one
// that was removed since the lookup cannot be told apart. A wrong credential has one body for every kind of source.
const notFound = () => reply(404, { error: 'not_found' });
const busy = (seconds: number) =>
  reply(429, { error: 'rate_limited' }, { 'retry-after': String(seconds) });

/**
 * The ingest's whole request path (D12): the method, the rate, the source, the size, who is posting, then the store. It
 * answers `200 {"id"}` once the request is stored with its deliveries, and never calls a destination.
 */
export function createIngestHandler(
  options: IngestOptions
): (request: Request) => Promise<Response> {
  const { store, limits, log } = options;
  const everyone = new MinuteLimiter(limits.globalPerMinute, options.now);
  const perSource = new MinuteLimiter(limits.perSourcePerMinute, options.now);
  let lastLogged = 0;
  const failed = (msg: string, error: unknown) => {
    const at = (options.now ?? Date.now)();
    if (log === undefined || at - lastLogged < LOG_EVERY_MS) return;
    lastLogged = at;
    log({ level: 'error', msg, error: error instanceof Error ? error.name : 'unknown' });
  };
  const unavailable = () => reply(503, { error: 'unavailable' }, { 'retry-after': '5' });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return request.method === 'GET'
        ? reply(200, { ok: true })
        : reply(405, { error: 'method_not_allowed' }, { allow: 'GET' });
    }
    const token = TOKEN_PATH.exec(url.pathname)?.[1];
    if (token === undefined) return notFound();
    // Before the lookup, so every token answers a method alike and none shows that it exists.
    if (!METHODS.has(request.method)) {
      return reply(405, { error: 'method_not_allowed' }, { allow: ALLOW });
    }
    const wait = everyone.take('*');
    if (wait > 0) return busy(wait);

    let source;
    try {
      source = await store.findByToken(token);
    } catch (error) {
      failed('lookup failed', error);
      return unavailable();
    }
    if (source === null || !source.enabled) return notFound();

    const contentType = request.headers.get('content-type');
    if (contentType !== null && contentType.length > MAX_CONTENT_TYPE_CHARS) {
      return reply(400, { error: 'bad_request' });
    }
    const wait2 = perSource.take(source.id);
    if (wait2 > 0) return busy(wait2);

    const inbound = (body: Uint8Array): InboundRequest => ({
      method: request.method,
      headers: Object.fromEntries(request.headers),
      query: Object.fromEntries(url.searchParams),
      contentType,
      body,
    });
    // A refused request is kept (without its body) so the operator can see it; a failure to keep it does not change the answer.
    const refuse = async (status: number, error: string, cause: string) => {
      try {
        await store.reject(source.id, inbound(EMPTY), cause);
      } catch (e) {
        failed('reject failed', e);
      }
      return reply(status, { error });
    };

    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > limits.maxBodyBytes) return refuse(413, 'payload_too_large', 'body too large');
    const read = await readBody(request, limits.maxBodyBytes, limits.readTimeoutMs);
    if (read.kind === 'too_large') return refuse(413, 'payload_too_large', 'body too large');
    if (read.kind === 'timeout') return refuse(408, 'request_timeout', 'body not received in time');

    if (!(await verifies(source, request.headers, read.body))) {
      return refuse(401, 'unauthorized', 'verification failed');
    }
    try {
      const result = await store.accept(source.id, inbound(read.body));
      return result.outcome === 'accepted' ? reply(200, { id: result.id }) : notFound();
    } catch (error) {
      failed('accept failed', error);
      return unavailable();
    }
  };
}
