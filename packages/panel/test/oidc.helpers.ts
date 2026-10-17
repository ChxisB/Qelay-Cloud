import type { User } from 'oidc-client-ts';
import type { OidcClient } from '../src/lib/auth/oidc';

export const PAGE = 'https://panel.example.com/';
export const userWith = (token: string, extra: Partial<User> = {}): User =>
  ({
    access_token: token,
    expired: false,
    profile: { sub: 'alice' },
    state: undefined,
    ...extra,
  }) as unknown as User;

export interface Calls {
  redirects: unknown[];
  removed: number;
  silent: number;
  signout: number;
}

export function fakeClient(options: {
  user?: User | null;
  callback?: User | Error;
  silent?: User | null | Error;
}): { client: OidcClient; calls: Calls; emit: Record<string, (value?: never) => void> } {
  const calls: Calls = { redirects: [], removed: 0, silent: 0, signout: 0 };
  const listeners: Record<string, Array<(value?: never) => void>> = {};
  const on = (name: string) => (callback: (value?: never) => void) => {
    (listeners[name] ??= []).push(callback);
    return () => undefined;
  };
  const client: OidcClient = {
    getUser: () => Promise.resolve(options.user ?? null),
    signinRedirect: (args) => {
      calls.redirects.push(args);
      return Promise.resolve();
    },
    signinCallback: () =>
      options.callback instanceof Error
        ? Promise.reject(options.callback)
        : Promise.resolve(options.callback),
    signinSilent: () => {
      calls.silent += 1;
      const outcome = options.silent;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome ?? null);
    },
    signoutRedirect: () => {
      calls.signout += 1;
      return Promise.resolve();
    },
    removeUser: () => {
      calls.removed += 1;
      return Promise.resolve();
    },
    events: {
      addUserLoaded: on('userLoaded') as never,
      addSilentRenewError: on('silentRenewError') as never,
      addAccessTokenExpired: on('expired') as never,
    },
  };
  const emit = Object.fromEntries(
    ['userLoaded', 'silentRenewError', 'expired'].map((name) => [
      name,
      (value?: never) => {
        for (const callback of listeners[name] ?? []) callback(value);
      },
    ])
  );
  return { client, calls, emit };
}
