import {
  InMemoryWebStorage,
  type User,
  UserManager,
  type UserManagerSettings,
  WebStorageStateStore,
} from 'oidc-client-ts';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import type { AuthConfig } from '../panelConfig';
import { useAuthStore } from './authStore';
import {
  beginSession,
  endSession,
  installSessionFetch,
  renewSession,
  setSessionTarget,
} from './session';

type OidcConfig = Extract<AuthConfig, { mode: 'oidc' }>;

/** The part of `UserManager` the panel uses, so a test can stand in for the real one. */
export interface OidcClient {
  getUser(): Promise<User | null>;
  signinRedirect(args?: { state?: unknown }): Promise<void>;
  signinCallback(url?: string): Promise<User | undefined | void>;
  signinSilent(): Promise<User | null>;
  signoutRedirect(): Promise<void>;
  removeUser(): Promise<void>;
  events: {
    addUserLoaded(callback: (user: User) => void): () => void;
    addSilentRenewError(callback: (error: Error) => void): () => void;
    addAccessTokenExpired(callback: () => void): () => void;
  };
}

/**
 * `oidc-client-ts`: a maintained, certified OpenID Connect relying party (Apache-2.0). It does the
 * authorization-code flow with PKCE, the state and nonce checks, and the renewal. This file only
 * decides where it keeps things: the user (and so the tokens) in memory, the in-flight state
 * (PKCE verifier, nonce) in `sessionStorage` for the length of the redirect. Its defaults would
 * be `sessionStorage` for the user and `localStorage` for the state; both are replaced.
 */
function stateStorage(): Storage {
  try {
    const storage = globalThis.sessionStorage;
    if (storage) return storage;
  } catch {
    // Blocked site data throws on access.
  }
  // The library would fall back to localStorage; a sign-in cannot survive the redirect without
  // this, so it is refused with a reason instead.
  throw new Error('Signing in needs sessionStorage, which this browser blocks for the page.');
}

export function createUserManager(config: OidcConfig, pageUrl: string): UserManager {
  const at = (path: string) => new URL(path, pageUrl).href;
  const settings: UserManagerSettings = {
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: at('auth/callback'),
    silent_redirect_uri: at('auth/silent'),
    post_logout_redirect_uri: at('./'),
    response_type: 'code',
    scope: config.scope,
    automaticSilentRenew: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: stateStorage() }),
    ...(config.audience ? { extraQueryParams: { audience: config.audience } } : {}),
  };
  return new UserManager(settings);
}

/** A return path from the sign-in state is used only when it stays on this origin. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || /\/auth\/(callback|silent)(?:[/?#]|$)/.test(value)) return '/';
  return value;
}

const RENEW_LOOP_MS = 15_000;

export interface OidcSession {
  /** A 401 from the API: renew once, and say so plainly when a fresh token is refused too. */
  onUnauthorized(): Promise<void>;
  signOut(): Promise<void>;
  signInAgain(): Promise<void>;
}

export interface StartOptions {
  client: OidcClient;
  /** Where the API lives: the token is only sent there. */
  apiBase: string;
  pageUrl: string;
  /** The current path and query, read when a sign-in starts, to come back to afterwards. */
  location: () => { pathname: string; search: string };
  isCallback: boolean;
  replaceUrl: (path: string) => void;
}

/**
 * Brings the page to a signed-in state, or sends the browser to the identity provider.
 * Returns `null` when it redirected (nothing should render).
 */
export async function startOidcSession(options: StartOptions): Promise<OidcSession | null> {
  const { client, apiBase, pageUrl, location } = options;
  const auth = useAuthStore.getState();
  const returnTo = () => {
    const here = location();
    return `${here.pathname}${here.search}`;
  };
  let lastRenewAt = 0;

  const adopt = (user: User): void => {
    const handle = beginSession(user.access_token);
    setSessionTarget(apiBase, pageUrl);
    installSessionFetch();
    useConnectionStore.getState().setToken(handle);
    lastRenewAt = Date.now();
    auth.setReady(user.profile?.sub);
  };

  const redirect = async (): Promise<void> => {
    auth.setStatus('redirecting');
    await client.signinRedirect({ state: { returnTo: returnTo() } });
  };

  const session: OidcSession = {
    async onUnauthorized() {
      if (useAuthStore.getState().status !== 'ready') return;
      if (Date.now() - lastRenewAt < RENEW_LOOP_MS) {
        auth.setError(
          'You are signed in, but the API rejected your token. Sign out and in again, or ask an administrator to check your role.'
        );
        return;
      }
      try {
        const user = await client.signinSilent();
        if (user) {
          renewSession(user.access_token);
          lastRenewAt = Date.now();
          return;
        }
      } catch {
        // Falls through to a full sign-in.
      }
      await redirect();
    },
    async signOut() {
      endSession();
      useConnectionStore.getState().setToken('');
      await client.removeUser();
      auth.setSignedOut();
      try {
        await client.signoutRedirect();
      } catch {
        // No end-session endpoint: the panel's own signed-out screen is the end of it.
      }
    },
    async signInAgain() {
      await redirect();
    },
  };

  client.events.addUserLoaded((user) => {
    renewSession(user.access_token);
    lastRenewAt = Date.now();
  });
  client.events.addSilentRenewError(() => {
    void session.onUnauthorized();
  });
  client.events.addAccessTokenExpired(() => {
    void session.onUnauthorized();
  });

  try {
    if (options.isCallback) {
      const user = await client.signinCallback();
      if (!user) throw new Error('The sign-in response held no user.');
      adopt(user);
      options.replaceUrl(
        safeReturnPath((user.state as { returnTo?: unknown } | undefined)?.returnTo)
      );
      return session;
    }
    const existing = await client.getUser();
    if (existing && !existing.expired) {
      adopt(existing);
      return session;
    }
    await redirect();
    return null;
  } catch (error) {
    auth.setError(
      error instanceof Error && error.message
        ? `Sign-in failed: ${error.message}`
        : 'Sign-in failed. Try again.'
    );
    options.replaceUrl('/');
    return session;
  }
}
