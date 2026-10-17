import { parsePanelConfig, PanelConfigError } from '../src/lib/panelConfig';
import type { PanelConfig } from '../src/lib/panelConfig';

type Env = Readonly<Record<string, string | undefined>>;

export interface ServeSettings {
  /** What `/config.json` serves: public settings only (see `parsePanelConfig`). */
  readonly config: PanelConfig;
  readonly hostname: string;
  readonly port: number;
  /** Where the panel is mounted: `/` or `/some/path`, no trailing slash except the root. */
  readonly mount: string;
  /** Extra origins the page may connect to (an OIDC token endpoint on another host). */
  readonly connectExtra: readonly string[];
}

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function loopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function origin(name: string, value: string, httpsOnly: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PanelConfigError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
    throw new PanelConfigError(`${name} must be https (http only for localhost)`);
  }
  if (httpsOnly && url.protocol !== 'https:') {
    throw new PanelConfigError(`${name} must be https`);
  }
  return url.origin;
}

/**
 * The deployment's settings, from the environment only: a flag would show in the process list and
 * nothing here is secret, but one place keeps the image's contract short. Refuses what cannot work
 * or is unsafe (a plaintext API, a missing OIDC client, a secret-looking key) at start, so a bad
 * rollout fails its startup probe instead of serving a panel that cannot sign in.
 *
 * `QCLOUD_PANEL_API_BASE_URL` (required; https, or http on localhost), `QCLOUD_PANEL_AUTH_MODE`
 * (`oidc` default | `token`), `QCLOUD_PANEL_OIDC_AUTHORITY` / `_CLIENT_ID` / `_SCOPE` / `_AUDIENCE`,
 * `QCLOUD_PANEL_BASE_PATH`, `QCLOUD_PANEL_CSP_CONNECT_EXTRA`, `QCLOUD_PANEL_HOST`, `QCLOUD_PANEL_PORT`.
 */
export function settingsFromEnv(env: Env): ServeSettings {
  const apiBaseUrl = text(env, 'QCLOUD_PANEL_API_BASE_URL');
  if (apiBaseUrl === undefined) {
    throw new PanelConfigError(
      'QCLOUD_PANEL_API_BASE_URL is required: the Control API the panel talks to'
    );
  }
  origin('QCLOUD_PANEL_API_BASE_URL', apiBaseUrl, false);
  const mode = text(env, 'QCLOUD_PANEL_AUTH_MODE') ?? 'oidc';
  if (mode !== 'oidc' && mode !== 'token') {
    throw new PanelConfigError('QCLOUD_PANEL_AUTH_MODE must be "oidc" or "token"');
  }
  let auth: unknown = { mode: 'token' };
  let authority: string | undefined;
  if (mode === 'oidc') {
    authority = text(env, 'QCLOUD_PANEL_OIDC_AUTHORITY');
    const clientId = text(env, 'QCLOUD_PANEL_OIDC_CLIENT_ID');
    if (authority === undefined || clientId === undefined) {
      throw new PanelConfigError(
        'QCLOUD_PANEL_OIDC_AUTHORITY and QCLOUD_PANEL_OIDC_CLIENT_ID are required with QCLOUD_PANEL_AUTH_MODE=oidc'
      );
    }
    origin('QCLOUD_PANEL_OIDC_AUTHORITY', authority, false);
    const scope = text(env, 'QCLOUD_PANEL_OIDC_SCOPE');
    const audience = text(env, 'QCLOUD_PANEL_OIDC_AUDIENCE');
    auth = {
      mode: 'oidc',
      authority,
      clientId,
      ...(scope === undefined ? {} : { scope }),
      ...(audience === undefined ? {} : { audience }),
    };
  }
  const config = parsePanelConfig({ apiBaseUrl, auth });
  const mount = (text(env, 'QCLOUD_PANEL_BASE_PATH') ?? '/').replace(/\/+$/, '') || '/';
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/.test(mount) || mount.includes('..')) {
    throw new PanelConfigError('QCLOUD_PANEL_BASE_PATH must be a plain path such as "/panel"');
  }
  const portRaw = text(env, 'QCLOUD_PANEL_PORT') ?? '8080';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 0 || port > 65_535) {
    throw new PanelConfigError('QCLOUD_PANEL_PORT must be a port number');
  }
  const connectExtra = (text(env, 'QCLOUD_PANEL_CSP_CONNECT_EXTRA') ?? '')
    .split(/\s+/)
    .filter((entry) => entry !== '')
    .map((entry) => origin('QCLOUD_PANEL_CSP_CONNECT_EXTRA', entry, true));
  return {
    config,
    hostname: text(env, 'QCLOUD_PANEL_HOST') ?? '127.0.0.1',
    port,
    mount,
    connectExtra,
  };
}
