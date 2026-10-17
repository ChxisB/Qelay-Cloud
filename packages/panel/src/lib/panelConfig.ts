import { z } from 'zod';
import { normalizeBaseUrl } from '@/components/dashboard/stores/connectionTarget';

/**
 * The runtime configuration of one deployment: `config.json`, served next to the panel's
 * `index.html`, so one build runs against any Control API. It holds public settings only (where
 * the API is, how to sign in). A key that looks like a secret is refused rather than read.
 */
export type AuthConfig =
  | { readonly mode: 'token' }
  | {
      readonly mode: 'oidc';
      readonly authority: string;
      readonly clientId: string;
      readonly scope: string;
      /** Sent as the `audience` authorization parameter, for providers that want one (Auth0). */
      readonly audience?: string;
    };

export interface PanelConfig {
  /** Null: keep the build-time or stored default (`/api`, proxied in `dev`). */
  readonly apiBaseUrl: string | null;
  readonly auth: AuthConfig;
}

export const DEFAULT_PANEL_CONFIG: PanelConfig = Object.freeze({
  apiBaseUrl: null,
  auth: Object.freeze({ mode: 'token' as const }),
});

export class PanelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelConfigError';
  }
}

const SECRET_KEY = /secret|password|passwd|token|api[-_]?key|private|credential/i;

/** The first path of a key that names a secret, at any depth; null when there is none. */
export function findSecretLikeKey(value: unknown, path = ''): string | null {
  if (value === null || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) return here;
    const nested = findSecretLikeKey(child, here);
    if (nested) return nested;
  }
  return null;
}

const httpsOrLocal = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
};

const rawSchema = z.strictObject({
  apiBaseUrl: z.string().optional(),
  auth: z
    .discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('token') }),
      z.strictObject({
        mode: z.literal('oidc'),
        authority: z.string().refine(httpsOrLocal, 'authority must be an https URL'),
        clientId: z.string().min(1),
        scope: z.string().min(1).default('openid profile'),
        audience: z.string().min(1).optional(),
      }),
    ])
    .default({ mode: 'token' }),
});

/** Validates an already-parsed `config.json`. Throws `PanelConfigError` with the reason. */
export function parsePanelConfig(value: unknown): PanelConfig {
  const secret = findSecretLikeKey(value);
  if (secret) {
    throw new PanelConfigError(
      `config.json must not hold secrets, but it has "${secret}". Remove it: the file is public.`
    );
  }
  const parsed = rawSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.join('.') || 'config.json';
    throw new PanelConfigError(`config.json is not valid at "${where}": ${issue.message}`);
  }
  let apiBaseUrl: string | null = null;
  if (parsed.data.apiBaseUrl !== undefined) {
    apiBaseUrl = normalizeBaseUrl(parsed.data.apiBaseUrl);
    if (!apiBaseUrl) {
      throw new PanelConfigError(
        'config.json: "apiBaseUrl" must be an http(s) URL or a path such as "/api", without credentials, query or fragment.'
      );
    }
  }
  const { auth } = parsed.data;
  if (auth.mode === 'oidc') {
    return {
      apiBaseUrl,
      auth: {
        mode: 'oidc',
        authority: auth.authority,
        clientId: auth.clientId,
        scope: auth.scope,
        ...(auth.audience ? { audience: auth.audience } : {}),
      },
    };
  }
  return { apiBaseUrl, auth: { mode: 'token' } };
}

/**
 * Fetches `config.json` beside the page. No file (404, or a static host answering with the SPA's
 * HTML) is a development setup and gets the defaults; a file that is there and wrong is an error,
 * so a typo does not silently point the panel somewhere else.
 */
export async function loadPanelConfig(
  fetchImpl: typeof fetch = fetch,
  baseUri: string = document.baseURI
): Promise<PanelConfig> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('config.json', baseUri).href, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new PanelConfigError('config.json could not be fetched. Check the network and reload.');
  }
  const type = response.headers.get('content-type') ?? '';
  if (response.status === 404 || (response.ok && type.includes('text/html'))) {
    return DEFAULT_PANEL_CONFIG;
  }
  if (!response.ok) {
    throw new PanelConfigError(`config.json answered HTTP ${response.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new PanelConfigError('config.json is not valid JSON.');
  }
  return parsePanelConfig(parsed);
}

let active: PanelConfig = DEFAULT_PANEL_CONFIG;
export const getPanelConfig = (): PanelConfig => active;
export function setPanelConfig(config: PanelConfig): void {
  active = config;
}
