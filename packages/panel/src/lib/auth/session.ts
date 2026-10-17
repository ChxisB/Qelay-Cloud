/**
 * The OIDC session, in memory only.
 *
 * The connection store, and the fifteen places that pin a request target, key on the token string: a
 * changed token reads as a changed server, which cancels the action leases in flight. An access
 * token that renews every few minutes would do that to every open confirmation. So the store holds
 * a stable opaque handle for the whole sign-in, and one `fetch` wrapper puts the live access token
 * in place of the handle on requests to the API. The token itself is held here and nowhere else:
 * not in the store, not in `localStorage` or `sessionStorage`, not in a URL, not in a log.
 */
let accessToken: string | null = null;
let handle: string | null = null;
let apiOrigin: string | null = null;
let pageBase = 'http://localhost/';
let uninstall: (() => void) | null = null;

const randomHandle = (): string => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `session-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** Starts a sign-in: returns the handle for the connection store (a new one per sign-in). */
export function beginSession(token: string): string {
  accessToken = token;
  handle = randomHandle();
  return handle;
}

/** A renewal: the handle stays, so nothing keyed on the connection sees a change. */
export function renewSession(token: string): void {
  if (handle) accessToken = token;
}

export function endSession(): void {
  accessToken = null;
  handle = null;
}

export const sessionHandle = (): string | null => handle;
export const hasSession = (): boolean => accessToken !== null;

/** The API URL the token may be sent to: resolved against the page, compared by prefix. */
export function setSessionTarget(base: string, pageUrl: string = globalThis.location?.href): void {
  try {
    pageBase = pageUrl;
    apiOrigin = new URL(base.endsWith('/') ? base : `${base}/`, pageUrl).href;
  } catch {
    apiOrigin = null;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function inTarget(url: string): boolean {
  if (!apiOrigin) return false;
  try {
    return new URL(url, pageBase).href.startsWith(apiOrigin);
  } catch {
    return false;
  }
}

/**
 * Wraps `fetch` once. A request whose `Authorization` is exactly `Bearer <handle>` and whose URL is
 * under the API target gets the live token; every other request passes through untouched, so a
 * handle that reaches another host is just an unknown string there. Returns the way to undo it.
 */
export function installSessionFetch(): () => void {
  if (uninstall) return uninstall;
  const original = globalThis.fetch;
  const real = original.bind(globalThis);
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!handle || !accessToken) return real(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    if (headers.get('Authorization') !== `Bearer ${handle}` || !inTarget(urlOf(input))) {
      return real(input, init);
    }
    headers.set('Authorization', `Bearer ${accessToken}`);
    return real(input, { ...init, headers });
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  uninstall = () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
    uninstall = null;
  };
  return uninstall;
}

/** For tests: back to a fresh module state. */
export function resetSessionForTests(): void {
  uninstall?.();
  accessToken = null;
  handle = null;
  apiOrigin = null;
}
