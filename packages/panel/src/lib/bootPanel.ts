import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { setActiveSession } from './auth/activeSession';
import { createUserManager, type OidcClient, startOidcSession } from './auth/oidc';
import { loadPanelConfig, type PanelConfig, setPanelConfig } from './panelConfig';

export interface BootPanelOptions {
  /** Demo mode talks to canned fixtures: no configuration file, no sign-in. */
  demo: boolean;
  /** The page's base URL: `config.json` and the sign-in callback paths live under it. */
  pageUrl: string;
  location: () => { pathname: string; search: string };
  loadConfig?: () => Promise<PanelConfig>;
  makeClient?: (
    config: Extract<PanelConfig['auth'], { mode: 'oidc' }>,
    pageUrl: string
  ) => OidcClient;
  replaceUrl?: (path: string) => void;
}

/**
 * - `render`: mount the app. It may show the sign-in screen itself (redirecting, signed out, error).
 * - `silent`: this page is the renewal iframe; it has handed the result to its parent and has
 *   nothing to render.
 */
export type BootOutcome = 'render' | 'silent';

const samePath = (pathname: string, path: string, pageUrl: string): boolean => {
  try {
    return new URL(path, pageUrl).pathname === pathname;
  } catch {
    return false;
  }
};

/**
 * Loads the deployment's `config.json`, points the panel at its API and, when it asks for OpenID
 * Connect, signs the user in before the first render. Throws `PanelConfigError` for a file that is
 * there and wrong; the caller shows that as a page of its own.
 */
export async function bootPanel(options: BootPanelOptions): Promise<BootOutcome> {
  if (options.demo) return 'render';
  const config = await (options.loadConfig ?? (() => loadPanelConfig()))();
  setPanelConfig(config);
  if (config.apiBaseUrl) useConnectionStore.getState().setBaseUrl(config.apiBaseUrl);
  if (config.auth.mode !== 'oidc') return 'render';

  const make = options.makeClient ?? createUserManager;
  const client = make(config.auth, options.pageUrl);
  const here = options.location();

  if (samePath(here.pathname, 'auth/silent', options.pageUrl)) {
    await client.signinCallback();
    return 'silent';
  }

  const session = await startOidcSession({
    client,
    apiBase: config.apiBaseUrl ?? getBaseUrl(),
    pageUrl: options.pageUrl,
    location: options.location,
    isCallback: samePath(here.pathname, 'auth/callback', options.pageUrl),
    replaceUrl: options.replaceUrl ?? ((path) => globalThis.history.replaceState(null, '', path)),
  });
  setActiveSession(session);
  return 'render';
}
