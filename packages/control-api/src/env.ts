import type { ControlApiOptions, OidcSettings, RateLimitSettings } from './config';
import { ControlApiConfigError } from './config';
import type { Role } from './types';

export type Env = Readonly<Record<string, string | undefined>>;

export const text = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
};

export const list = (env: Env, name: string): string[] | undefined =>
  text(env, name)
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export function integer(env: Env, name: string): number | undefined {
  const raw = text(env, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new ControlApiConfigError(`${name} must be a non-negative integer`);
  }
  return value;
}

function oidcFromEnv(env: Env): OidcSettings | undefined {
  const issuer = text(env, 'QCLOUD_API_OIDC_ISSUER');
  const audience = list(env, 'QCLOUD_API_OIDC_AUDIENCE');
  const jwksUrl = text(env, 'QCLOUD_API_OIDC_JWKS_URL');
  if (issuer === undefined && audience === undefined && jwksUrl === undefined) return undefined;
  for (const [name, value] of [
    ['QCLOUD_API_OIDC_ISSUER', issuer],
    ['QCLOUD_API_OIDC_AUDIENCE', audience],
    ['QCLOUD_API_OIDC_JWKS_URL', jwksUrl],
  ] as const) {
    if (value === undefined) {
      throw new ControlApiConfigError(`${name} is required when any OIDC setting is given`);
    }
  }
  const tolerance = integer(env, 'QCLOUD_API_OIDC_CLOCK_TOLERANCE_SEC');
  const algorithms = list(env, 'QCLOUD_API_OIDC_ALGORITHMS');
  const operatorRoles = list(env, 'QCLOUD_API_OPERATOR_ROLES');
  const viewerRoles = list(env, 'QCLOUD_API_VIEWER_ROLES');
  const roleClaim = text(env, 'QCLOUD_API_ROLE_CLAIM');
  return {
    issuer: issuer!,
    audience: audience!,
    jwksUrl: jwksUrl!,
    ...(tolerance === undefined ? {} : { clockToleranceSec: tolerance }),
    ...(algorithms === undefined ? {} : { algorithms }),
    ...(roleClaim === undefined ? {} : { roleClaim }),
    ...(operatorRoles === undefined ? {} : { operatorRoles }),
    ...(viewerRoles === undefined ? {} : { viewerRoles }),
  };
}

function rateLimitFromEnv(env: Env): RateLimitSettings | false | undefined {
  const burst = integer(env, 'QCLOUD_API_RATE_LIMIT_BURST');
  const perSecond = integer(env, 'QCLOUD_API_RATE_LIMIT_PER_SECOND');
  if (burst === 0 || perSecond === 0) return false;
  if (burst === undefined && perSecond === undefined) return undefined;
  return { burst: burst ?? 100, perSecond: perSecond ?? 20 };
}

/**
 * The service's options from the environment. Secrets (the development token) come only from here,
 * never from a flag, and no error repeats a value. `NODE_ENV=production` puts the service in
 * production mode, where the development token is refused.
 */
export function controlApiOptionsFromEnv(env: Env, version: string): ControlApiOptions {
  const token = text(env, 'QCLOUD_API_DEV_TOKEN');
  const role = text(env, 'QCLOUD_API_DEV_TOKEN_ROLE');
  if (role !== undefined && role !== 'viewer' && role !== 'operator') {
    throw new ControlApiConfigError('QCLOUD_API_DEV_TOKEN_ROLE must be "viewer" or "operator"');
  }
  const oidc = oidcFromEnv(env);
  const origins = list(env, 'QCLOUD_API_CORS_ORIGINS');
  const maxBodyBytes = integer(env, 'QCLOUD_API_MAX_BODY_BYTES');
  const requestTimeoutMs = integer(env, 'QCLOUD_API_REQUEST_TIMEOUT_MS');
  const rateLimit = rateLimitFromEnv(env);
  return {
    version,
    production: env.NODE_ENV === 'production',
    ...(oidc === undefined ? {} : { oidc }),
    ...(token === undefined ? {} : { devToken: { token, role: (role ?? 'operator') as Role } }),
    ...(origins === undefined ? {} : { corsOrigins: origins }),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  };
}

export interface ListenSettings {
  readonly hostname: string;
  readonly port: number;
}

/** Where to listen: `QCLOUD_API_HOST` (default loopback) and `QCLOUD_API_PORT` (default 8080). */
export function listenFromEnv(env: Env): ListenSettings {
  const port = integer(env, 'QCLOUD_API_PORT') ?? 8080;
  if (port > 65_535) throw new ControlApiConfigError('QCLOUD_API_PORT must be a port number');
  return { hostname: text(env, 'QCLOUD_API_HOST') ?? '127.0.0.1', port };
}
