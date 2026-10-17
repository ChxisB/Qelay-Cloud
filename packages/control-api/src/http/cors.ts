/**
 * CORS for a browser panel on another origin. The allow-list is exact origins and nothing else: no
 * wildcard, no reflection of whatever `Origin` arrives. Credentials are never allowed (no
 * `Access-Control-Allow-Credentials`): the API takes a bearer token in the `Authorization` header and
 * sets no cookie, so a page on another origin has nothing the browser would attach for it.
 */

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'authorization, content-type, x-request-id';
const EXPOSED_HEADERS = 'x-request-id, retry-after';
const PREFLIGHT_MAX_AGE_SEC = '600';

/** The headers for a response to `origin`, or null when that origin is not on the list (or none was sent). */
export function corsHeaders(
  origin: string | null,
  allowed: ReadonlySet<string>
): Record<string, string> | null {
  if (origin === null || !allowed.has(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': EXPOSED_HEADERS,
    vary: 'Origin',
  };
}

export function preflightHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': PREFLIGHT_MAX_AGE_SEC,
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}
