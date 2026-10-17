import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { useAuthStore } from '../src/lib/auth/authStore';
import {
  createUserManager,
  type OidcClient,
  safeReturnPath,
  startOidcSession,
} from '../src/lib/auth/oidc';
import { hasSession, resetSessionForTests, sessionHandle } from '../src/lib/auth/session';
import { fakeClient, PAGE, userWith } from './oidc.helpers';

let replaced: string[] = [];
const base = (client: OidcClient, extra: Partial<Parameters<typeof startOidcSession>[0]> = {}) => ({
  client,
  apiBase: 'https://api.example.com',
  pageUrl: PAGE,
  location: () => ({ pathname: '/queues', search: '?q=orders' }),
  isCallback: false,
  replaceUrl: (path: string) => replaced.push(path),
  ...extra,
});

beforeEach(() => {
  replaced = [];
  useConnectionStore.setState({ token: '' });
  useAuthStore.setState({ status: 'ready', subject: null, managed: false, error: null });
});

afterEach(() => {
  resetSessionForTests();
});

describe('startOidcSession', () => {
  test('no user: goes to the identity provider and remembers where it was', async () => {
    const { client, calls } = fakeClient({ user: null });
    const session = await startOidcSession(base(client));
    expect(session).toBeNull();
    expect(calls.redirects).toEqual([{ state: { returnTo: '/queues?q=orders' } }]);
    expect(useAuthStore.getState().status).toBe('redirecting');
    expect(hasSession()).toBe(false);
  });

  test('a user in memory: the store gets a handle, never the token', async () => {
    const { client } = fakeClient({ user: userWith('real-access-token') });
    const session = await startOidcSession(base(client));
    expect(session).not.toBeNull();
    const stored = useConnectionStore.getState().token;
    expect(stored).toBe(sessionHandle() ?? 'missing');
    expect(stored).not.toContain('real-access-token');
    expect(useAuthStore.getState()).toMatchObject({
      status: 'ready',
      subject: 'alice',
      managed: true,
    });
  });

  test('the callback signs in and cleans the URL, going back to where the user was', async () => {
    const { client } = fakeClient({
      callback: userWith('tok', { state: { returnTo: '/dlq' } } as Partial<User>),
    });
    await startOidcSession(base(client, { isCallback: true }));
    expect(replaced).toEqual(['/dlq']);
    expect(useAuthStore.getState().status).toBe('ready');
  });

  test('a return path that leaves the origin is ignored', () => {
    expect(safeReturnPath('//evil.example.net/x')).toBe('/');
    expect(safeReturnPath('https://evil.example.net')).toBe('/');
    expect(safeReturnPath('/\\evil')).toBe('/');
    expect(safeReturnPath('/auth/callback?code=1')).toBe('/');
    expect(safeReturnPath('/ops/auth/callback?code=1')).toBe('/');
    expect(safeReturnPath('/ops/auth/silent')).toBe('/');
    expect(safeReturnPath('/jobs?id=1')).toBe('/jobs?id=1');
    expect(safeReturnPath(undefined)).toBe('/');
  });

  test('a failed callback is an error screen, not a redirect loop', async () => {
    const { client, calls } = fakeClient({ callback: new Error('No matching state found') });
    await startOidcSession(base(client, { isCallback: true }));
    expect(useAuthStore.getState().status).toBe('error');
    expect(useAuthStore.getState().error).toContain('No matching state found');
    expect(calls.redirects).toEqual([]);
    expect(replaced).toEqual(['/']);
  });

  test('a silent renewal keeps the handle and changes only the token behind it', async () => {
    const { client, emit } = fakeClient({ user: userWith('tok-1') });
    await startOidcSession(base(client));
    const before = useConnectionStore.getState().token;
    emit.userLoaded(userWith('tok-2') as never);
    expect(useConnectionStore.getState().token).toBe(before);
  });
});

describe('a 401 from the API', () => {
  test('renews once and carries on when the provider answers', async () => {
    const { client, calls } = fakeClient({ user: userWith('tok-1'), silent: userWith('tok-2') });
    const session = await startOidcSession(base(client));
    // Pretend the sign-in is not fresh, so the loop guard does not apply.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await session?.onUnauthorized();
    } finally {
      Date.now = realNow;
    }
    expect(calls.silent).toBe(1);
    expect(calls.redirects).toEqual([]);
    expect(useAuthStore.getState().status).toBe('ready');
  });

  test('a refused renewal goes back through the identity provider', async () => {
    const { client, calls } = fakeClient({
      user: userWith('tok-1'),
      silent: new Error('login_required'),
    });
    const session = await startOidcSession(base(client));
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      await session?.onUnauthorized();
    } finally {
      Date.now = realNow;
    }
    expect(calls.redirects.length).toBe(1);
  });

  test('a 401 right after sign-in stops with a message instead of looping', async () => {
    const { client, calls } = fakeClient({ user: userWith('tok-1'), silent: userWith('tok-2') });
    const session = await startOidcSession(base(client));
    await session?.onUnauthorized();
    expect(calls.silent).toBe(0);
    expect(calls.redirects).toEqual([]);
    expect(useAuthStore.getState().status).toBe('error');
    expect(useAuthStore.getState().error).toContain('rejected your token');
  });
});

describe('sign-out', () => {
  test('drops the token, the handle and the stored user', async () => {
    const { client, calls } = fakeClient({ user: userWith('tok-1') });
    const session = await startOidcSession(base(client));
    await session?.signOut();
    expect(hasSession()).toBe(false);
    expect(useConnectionStore.getState().token).toBe('');
    expect(calls.removed).toBe(1);
    expect(calls.signout).toBe(1);
    expect(useAuthStore.getState().status).toBe('signed-out');
  });
});

describe('the user manager', () => {
  test('keeps the user in memory and the interaction state in sessionStorage only', async () => {
    const manager = createUserManager(
      {
        mode: 'oidc',
        authority: 'https://idp.example.com/realm',
        clientId: 'panel',
        scope: 'openid profile',
      },
      PAGE
    );
    const { settings } = manager;
    expect(settings.redirect_uri).toBe('https://panel.example.com/auth/callback');
    expect(settings.silent_redirect_uri).toBe('https://panel.example.com/auth/silent');
    expect(settings.response_type).toBe('code');
    expect(settings.disablePKCE).toBeFalsy();
    expect(settings.automaticSilentRenew).toBe(true);
    // The user store is a memory store: setting a value must not reach either web storage.
    const before = [localStorage.length, sessionStorage.length];
    await settings.userStore.set('k', 'access_token=secret');
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
    expect(await settings.userStore.get('k')).toBe('access_token=secret');
    manager.stopSilentRenew?.();
  });
});
