import type { Clock } from '@qelay-cloud/core';
import { systemClock } from '@qelay-cloud/core';
import type { Logger } from './http/log';
import { jsonLogger } from './http/log';
import type { Role } from './types';

/** Thrown at startup for a configuration that must not run. The message never repeats a secret. */
export class ControlApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlApiConfigError';
  }
}

export const MIN_DEV_TOKEN_LENGTH = 24;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT = { burst: 100, perSecond: 20 } as const;

export interface OidcSettings {
  /** The `iss` claim every token must carry, exactly. */
  readonly issuer: string;
  /** Accepted `aud` values: a token is valid when it names at least one. */
  readonly audience: string | readonly string[];
  /** Where the issuer publishes its signing keys. Fetched, cached, and refetched for an unknown `kid`. */
  readonly jwksUrl: string;
  /** Signature algorithms accepted. Default `RS256` and `ES256`; `none` and `HS*` are refused. */
  readonly algorithms?: readonly string[];
  /** Tolerance on `exp` and `nbf`, in seconds. Default 30. */
  readonly clockToleranceSec?: number;
  /** Least time between two JWKS fetches, so a flood of unknown `kid`s cannot hammer the issuer. Default 30 s. */
  readonly jwksCooldownMs?: number;
  /** How long fetched keys are used before they are fetched again. Default 10 minutes. */
  readonly jwksCacheMs?: number;
  /** The claim that lists the caller's roles: a string or an array, as a dotted path. Default `roles`. */
  readonly roleClaim?: string;
  /** Claim values that grant `operator`. Default `operator`. */
  readonly operatorRoles?: readonly string[];
  /** Claim values that grant `viewer`. Default `viewer`. */
  readonly viewerRoles?: readonly string[];
}

export interface DevTokenSettings {
  /** A static bearer token, at least 24 characters. For local development only. */
  readonly token: string;
  /** The role it grants. Default `operator`. */
  readonly role?: Role;
}

export interface RateLimitSettings {
  /** Writes a principal may make at once. */
  readonly burst: number;
  /** Writes per second a principal may keep making. */
  readonly perSecond: number;
}

/** The shape of the fleet the deployer runs, so `/deployment` can set connection use against what it needs. */
export interface FleetSettings {
  /** Worker processes. */
  readonly workers: number;
  /** Connections each process may open. Default the SDK's. */
  readonly poolSize?: number;
  /** Processes that hold a LISTEN connection. Default none. */
  readonly listeners?: number;
  /** Control API and tick processes. Default the budget's. */
  readonly controlProcesses?: number;
  /** The fleet connects through a transaction pooler. */
  readonly pooler?: boolean;
  /** Server connections the pooler may open. Default the budget's. */
  readonly poolerPoolSize?: number;
}

export interface DeploymentSettings {
  /** The commit (or tag) this build came from, shown on the Deployment page. Letters, digits and `._-` only. */
  readonly commit?: string;
  /** Tick age at which the status is "late" (amber), in ms. Default 60,000. */
  readonly tickLateAfterMs?: number;
  /** Tick age at which the status is "stale" (red), in ms, past `tickLateAfterMs`. Default 300,000. */
  readonly tickStaleAfterMs?: number;
  /** The longest gap between ticks the deployer promises (the scheduler's period). Unset: not declared, so no timing warning. */
  readonly tickIntervalMs?: number;
  readonly fleet?: FleetSettings;
  /** How long this instance keeps the answers of `/transport` and `/deployment`, in ms. 0 turns it off. Default 2,000. */
  readonly cacheMs?: number;
  /** Queues `/transport` reports on, at most. The rest are counted in `truncated`. Default 50. */
  readonly maxQueues?: number;
}

export interface ResolvedDeployment {
  readonly commit: string | null;
  readonly tickLateAfterMs: number;
  readonly tickStaleAfterMs: number;
  readonly tickIntervalMs: number | null;
  readonly fleet: FleetSettings | null;
  readonly cacheMs: number;
  readonly maxQueues: number;
}

export const DEFAULT_TICK_LATE_AFTER_MS = 60_000;
export const DEFAULT_TICK_STALE_AFTER_MS = 300_000;
export const DEFAULT_DEPLOYMENT_CACHE_MS = 2_000;
export const DEFAULT_MAX_TRANSPORT_QUEUES = 50;

export interface ControlApiOptions {
  /** Reported by `/health` and `/capabilities`. */
  readonly version: string;
  /** Production mode: also on whenever `NODE_ENV` is `production`, so this can turn it on and never off. The development token is refused in it. */
  readonly production?: boolean;
  readonly oidc?: OidcSettings;
  readonly devToken?: DevTokenSettings;
  /** The only origins a browser may call from, each as `scheme://host[:port]`. No wildcard exists. */
  readonly corsOrigins?: readonly string[];
  /** Largest request body, in bytes, for a route that does not set its own. */
  readonly maxBodyBytes?: number;
  /** Longest a request may run before it is answered with 504, in ms, for a route that does not set its own. */
  readonly requestTimeoutMs?: number;
  /** Per-principal limit on mutating routes, per instance. `false` turns it off. */
  readonly rateLimit?: RateLimitSettings | false;
  /** What the Deployment page reports and warns about. */
  readonly deployment?: DeploymentSettings;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface ResolvedConfig {
  readonly version: string;
  readonly production: boolean;
  readonly oidc: Required<OidcSettings> | null;
  readonly devToken: { readonly token: string; readonly role: Role } | null;
  readonly corsOrigins: ReadonlySet<string>;
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly rateLimit: RateLimitSettings | null;
  readonly deployment: ResolvedDeployment;
  readonly clock: Clock;
  readonly logger: Logger;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_ALGORITHMS = /^(none|HS\d+)$/i;

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ControlApiConfigError(`${name} must be a positive integer`);
  }
  return value;
}

function secureUrl(name: string, raw: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlApiConfigError(`${name} is not a URL`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !production)) {
    throw new ControlApiConfigError(
      `${name} must be an https URL (plain http is accepted only for a loopback address outside production)`
    );
  }
  return raw;
}

function oidcSettings(oidc: OidcSettings, production: boolean): Required<OidcSettings> {
  if (oidc.issuer === '') throw new ControlApiConfigError('the OIDC issuer must not be empty');
  const audience = typeof oidc.audience === 'string' ? [oidc.audience] : [...oidc.audience];
  if (audience.length === 0 || audience.some((entry) => entry === '')) {
    throw new ControlApiConfigError('the OIDC audience must name at least one non-empty value');
  }
  const algorithms = oidc.algorithms ?? ['RS256', 'ES256'];
  if (algorithms.length === 0 || algorithms.some((name) => FORBIDDEN_ALGORITHMS.test(name))) {
    throw new ControlApiConfigError('the OIDC algorithms must be asymmetric (no none, no HS*)');
  }
  const operatorRoles = oidc.operatorRoles ?? ['operator'];
  const viewerRoles = oidc.viewerRoles ?? ['viewer'];
  if (operatorRoles.length === 0) {
    throw new ControlApiConfigError('at least one claim value must grant the operator role');
  }
  return {
    issuer: oidc.issuer,
    audience,
    jwksUrl: secureUrl('the OIDC JWKS URL', oidc.jwksUrl, production),
    algorithms,
    clockToleranceSec: oidc.clockToleranceSec ?? 30,
    jwksCooldownMs: oidc.jwksCooldownMs ?? 30_000,
    jwksCacheMs: oidc.jwksCacheMs ?? 600_000,
    roleClaim: oidc.roleClaim ?? 'roles',
    operatorRoles,
    viewerRoles,
  };
}

function origins(list: readonly string[]): ReadonlySet<string> {
  for (const origin of list) {
    let canonical: string | null = null;
    try {
      canonical = new URL(origin).origin;
    } catch {
      // Reported below.
    }
    if (origin.includes('*') || canonical !== origin || origin === 'null') {
      throw new ControlApiConfigError(
        `a CORS origin must be an exact scheme://host[:port], with no path, wildcard or "null": got "${origin}"`
      );
    }
  }
  return new Set(list);
}

const COMMIT = /^[A-Za-z0-9._-]{1,64}$/;

function deploymentSettings(input: DeploymentSettings = {}): ResolvedDeployment {
  if (input.commit !== undefined && !COMMIT.test(input.commit)) {
    throw new ControlApiConfigError(
      'the deployment commit must be 1 to 64 letters, digits, dots, dashes or underscores'
    );
  }
  const late = positive('tickLateAfterMs', input.tickLateAfterMs ?? DEFAULT_TICK_LATE_AFTER_MS);
  const stale = positive('tickStaleAfterMs', input.tickStaleAfterMs ?? DEFAULT_TICK_STALE_AFTER_MS);
  if (stale <= late) {
    throw new ControlApiConfigError('tickStaleAfterMs must be greater than tickLateAfterMs');
  }
  const { fleet } = input;
  if (fleet !== undefined && (!Number.isSafeInteger(fleet.workers) || fleet.workers < 0)) {
    throw new ControlApiConfigError('the fleet worker count must be a non-negative integer');
  }
  const cacheMs = input.cacheMs ?? DEFAULT_DEPLOYMENT_CACHE_MS;
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0) {
    throw new ControlApiConfigError('the deployment cacheMs must be a non-negative integer');
  }
  return {
    commit: input.commit ?? null,
    tickLateAfterMs: late,
    tickStaleAfterMs: stale,
    tickIntervalMs:
      input.tickIntervalMs === undefined ? null : positive('tickIntervalMs', input.tickIntervalMs),
    fleet: fleet ?? null,
    cacheMs,
    maxQueues: positive('maxQueues', input.maxQueues ?? DEFAULT_MAX_TRANSPORT_QUEUES),
  };
}

/**
 * Validates the options and fills the defaults. It is the one place that decides whether the service
 * may start: it refuses to run with no way to authenticate, and refuses the development token in
 * production mode.
 */
export function resolveConfig(
  options: ControlApiOptions,
  env: Readonly<Record<string, string | undefined>> = {}
): ResolvedConfig {
  const production = options.production === true || env.NODE_ENV === 'production';
  if (options.devToken !== undefined && production) {
    throw new ControlApiConfigError(
      'the development token cannot be enabled in production mode (NODE_ENV=production): configure OIDC'
    );
  }
  if (options.oidc === undefined && options.devToken === undefined) {
    throw new ControlApiConfigError(
      'no authentication is configured: set the OIDC issuer, audience and JWKS URL (or, outside production, a development token)'
    );
  }
  if (options.devToken !== undefined && options.devToken.token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new ControlApiConfigError(
      `the development token must be at least ${MIN_DEV_TOKEN_LENGTH} characters`
    );
  }
  const limit = options.rateLimit === undefined ? DEFAULT_RATE_LIMIT : options.rateLimit;
  if (limit !== false) {
    positive('the rate limit burst', limit.burst);
    positive('the rate limit refill rate', limit.perSecond);
  }
  return {
    version: options.version,
    production,
    oidc: options.oidc === undefined ? null : oidcSettings(options.oidc, production),
    devToken:
      options.devToken === undefined
        ? null
        : { token: options.devToken.token, role: options.devToken.role ?? 'operator' },
    corsOrigins: origins(options.corsOrigins ?? []),
    maxBodyBytes: positive('maxBodyBytes', options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES),
    requestTimeoutMs: positive(
      'requestTimeoutMs',
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    ),
    rateLimit: limit === false ? null : limit,
    deployment: deploymentSettings(options.deployment),
    clock: options.clock ?? systemClock,
    logger: options.logger ?? jsonLogger(),
  };
}
