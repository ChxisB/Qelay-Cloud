import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useAuthStore } from '../src/lib/auth/authStore';
import { startOidcSession } from '../src/lib/auth/oidc';
import { resetSessionForTests, sessionHandle } from '../src/lib/auth/session';
import { fakeClient, PAGE, userWith } from './oidc.helpers';

const FIRST = 'SECRET-ACCESS-TOKEN-0123456789-first';
const RENEWED = 'SECRET-ACCESS-TOKEN-9876543210-renewed';
const API = 'https://api.example.com';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

const realFetch = globalThis.fetch;
const realConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));
let logged: string[] = [];
let sent: Array<{ url: string; authorization: string | null }> = [];
let replaced: string[] = [];

const dump = (storage: Storage): string[] =>
  Array.from({ length: storage.length }, (_, i) => {
    const key = storage.key(i) ?? '';
    return `${key}=${storage.getItem(key)}`;
  });

beforeEach(() => {
  logged = [];
  sent = [];
  replaced = [];
  localStorage.clear();
  sessionStorage.clear();
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      logged.push(
        args.map((a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? String(a)))).join(' ')
      );
    };
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof fetch;
  useConnectionStore.setState({ baseUrl: API, token: '' });
  useAuthStore.setState({ status: 'ready', subject: null, managed: false, error: null });
});

afterEach(() => {
  resetSessionForTests();
  globalThis.fetch = realFetch;
  for (const method of CONSOLE_METHODS) console[method] = realConsole[method] as never;
  useConnectionStore.setState({ baseUrl: '/api', token: '' });
});

describe('the access token stays in memory', () => {
  test('through sign-in, a renewal, requests and a sign-out it is in no storage, URL or log', async () => {
    const { client, emit } = fakeClient({
      callback: userWith(FIRST, { state: { returnTo: '/queues' } } as never),
    });
    const session = await startOidcSession({
      client,
      apiBase: API,
      pageUrl: PAGE,
      location: () => ({ pathname: '/auth/callback', search: '?code=abc&state=xyz' }),
      isCallback: true,
      replaceUrl: (path) => replaced.push(path),
    });
    expect(session).not.toBeNull();
    const handle = sessionHandle() ?? '';
    expect(handle).not.toBe('');

    // The panel's own requests carry the handle; the wrapper puts the live token on the wire.
    await fetch(`${API}/queues`, { headers: { Authorization: `Bearer ${handle}` } });
    expect(sent.at(-1)?.authorization).toBe(`Bearer ${FIRST}`);

    emit.userLoaded(userWith(RENEWED) as never);
    await fetch(`${API}/queues`, { headers: { Authorization: `Bearer ${handle}` } });
    expect(sent.at(-1)?.authorization).toBe(`Bearer ${RENEWED}`);
    expect(sessionHandle()).toBe(handle);

    // A request to anywhere else keeps the handle and never gets the token.
    await fetch('https://elsewhere.example.org/x', {
      headers: { Authorization: `Bearer ${handle}` },
    });
    expect(sent.at(-1)?.authorization).toBe(`Bearer ${handle}`);

    await session?.signOut();

    const everywhere = [
      ...dump(localStorage),
      ...dump(sessionStorage),
      JSON.stringify(useConnectionStore.getState()),
      JSON.stringify(useAuthStore.getState()),
      ...replaced,
      ...sent.map((request) => request.url),
      ...logged,
    ].join('\n');
    for (const secret of [FIRST, RENEWED]) expect(everywhere).not.toContain(secret);
    // The handle is not a credential, but it is not written to disk either.
    expect(dump(localStorage).join('\n')).not.toContain(handle);
    expect(dump(sessionStorage).join('\n')).not.toContain(handle);
    // Nothing the page shows or keeps survives the sign-out.
    expect(useConnectionStore.getState().token).toBe('');
    expect(sessionHandle()).toBeNull();
  });

  test('a failed sign-in says what went wrong without echoing the response it was given', async () => {
    const { client } = fakeClient({ callback: new Error('invalid_grant') });
    await startOidcSession({
      client,
      apiBase: API,
      pageUrl: PAGE,
      location: () => ({ pathname: '/auth/callback', search: '?code=SECRET-CODE-1234&state=s' }),
      isCallback: true,
      replaceUrl: (path) => replaced.push(path),
    });
    const state = JSON.stringify(useAuthStore.getState());
    expect(state).toContain('invalid_grant');
    expect([state, ...replaced, ...logged].join('\n')).not.toContain('SECRET-CODE-1234');
    // The single-use code is gone from the address bar either way.
    expect(replaced.at(-1)).toBe('/');
  });
});
