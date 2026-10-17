import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { getActiveSession, setActiveSession } from '../src/lib/auth/activeSession';
import { useAuthStore } from '../src/lib/auth/authStore';
import { resetSessionForTests } from '../src/lib/auth/session';
import { bootPanel } from '../src/lib/bootPanel';
import {
  DEFAULT_PANEL_CONFIG,
  PanelConfigError,
  type PanelConfig,
  setPanelConfig,
} from '../src/lib/panelConfig';
import { fakeClient, PAGE, userWith } from './oidc.helpers';

const OIDC: PanelConfig = {
  apiBaseUrl: 'https://api.example.com',
  auth: { mode: 'oidc', authority: 'https://idp.example.com', clientId: 'panel', scope: 'openid' },
};

let replaced: string[] = [];
const at =
  (pathname: string, search = '') =>
  () => ({ pathname, search });

beforeEach(() => {
  replaced = [];
  useConnectionStore.setState({ token: '' });
  useAuthStore.setState({ status: 'ready', subject: null, managed: false, error: null });
});

afterEach(() => {
  resetSessionForTests();
  setActiveSession(null);
  setPanelConfig(DEFAULT_PANEL_CONFIG);
});

describe('bootPanel', () => {
  test('demo mode reads no configuration and signs nobody in', async () => {
    let loaded = false;
    const outcome = await bootPanel({
      demo: true,
      pageUrl: PAGE,
      location: at('/'),
      loadConfig: () => {
        loaded = true;
        return Promise.resolve(OIDC);
      },
    });
    expect(outcome).toBe('render');
    expect(loaded).toBe(false);
    expect(getActiveSession()).toBeNull();
  });

  test('token mode applies the API address and leaves the token prompt to the gate', async () => {
    let made = false;
    const outcome = await bootPanel({
      demo: false,
      pageUrl: PAGE,
      location: at('/'),
      loadConfig: () =>
        Promise.resolve({ apiBaseUrl: 'https://api.example.com', auth: { mode: 'token' } }),
      makeClient: () => {
        made = true;
        return fakeClient({}).client;
      },
    });
    expect(outcome).toBe('render');
    expect(made).toBe(false);
    expect(useConnectionStore.getState().baseUrl).toBe('https://api.example.com');
    expect(useAuthStore.getState().managed).toBe(false);
  });

  test('a configuration that is there and wrong stops the boot with its reason', async () => {
    await expect(
      bootPanel({
        demo: false,
        pageUrl: PAGE,
        location: at('/'),
        loadConfig: () => Promise.reject(new PanelConfigError('config.json is not valid JSON.')),
      })
    ).rejects.toThrow('not valid JSON');
  });

  test('OIDC: a signed-in user gets a session and the app renders', async () => {
    const { client } = fakeClient({ user: userWith('tok') });
    const outcome = await bootPanel({
      demo: false,
      pageUrl: PAGE,
      location: at('/queues'),
      loadConfig: () => Promise.resolve(OIDC),
      makeClient: () => client,
      replaceUrl: (path) => replaced.push(path),
    });
    expect(outcome).toBe('render');
    expect(getActiveSession()).not.toBeNull();
    expect(useAuthStore.getState().status).toBe('ready');
    expect(useConnectionStore.getState().baseUrl).toBe('https://api.example.com');
  });

  test('OIDC: no user redirects, and the page shows the redirecting state', async () => {
    const { client, calls } = fakeClient({ user: null });
    await bootPanel({
      demo: false,
      pageUrl: PAGE,
      location: at('/dlq', '?q=1'),
      loadConfig: () => Promise.resolve(OIDC),
      makeClient: () => client,
      replaceUrl: (path) => replaced.push(path),
    });
    expect(calls.redirects).toEqual([{ state: { returnTo: '/dlq?q=1' } }]);
    expect(useAuthStore.getState()).toMatchObject({ status: 'redirecting', managed: true });
  });

  test('OIDC: the callback path completes the sign-in and cleans the URL', async () => {
    const { client } = fakeClient({
      callback: userWith('tok', { state: { returnTo: '/workers' } } as never),
    });
    await bootPanel({
      demo: false,
      pageUrl: PAGE,
      location: at('/auth/callback', '?code=abc&state=xyz'),
      loadConfig: () => Promise.resolve(OIDC),
      makeClient: () => client,
      replaceUrl: (path) => replaced.push(path),
    });
    expect(replaced).toEqual(['/workers']);
    expect(useAuthStore.getState().status).toBe('ready');
  });

  test('OIDC: the silent-renewal iframe hands its result over and renders nothing', async () => {
    const { client, calls } = fakeClient({ callback: userWith('tok') });
    let handled = 0;
    const counting = {
      ...client,
      signinCallback: () => {
        handled += 1;
        return client.signinCallback();
      },
    };
    const outcome = await bootPanel({
      demo: false,
      pageUrl: PAGE,
      location: at('/auth/silent', '?code=abc&state=xyz'),
      loadConfig: () => Promise.resolve(OIDC),
      makeClient: () => counting,
      replaceUrl: (path) => replaced.push(path),
    });
    expect(outcome).toBe('silent');
    expect(handled).toBe(1);
    expect(calls.redirects).toEqual([]);
    expect(getActiveSession()).toBeNull();
  });
});
