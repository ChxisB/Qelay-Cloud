import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@qelay-cloud/core';
import { systemClock, UnsupportedOptionError } from '@qelay-cloud/core';

/** Decides whether a request may run a tick. Never throws: an error is a refusal. */
export type Authenticator = (request: Request) => Promise<boolean>;

const BEARER = /^Bearer ([^\s]+)$/i;

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header === null ? null : BEARER.exec(header);
  return match?.[1] ?? null;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** The shortest shared secret accepted. */
export const MIN_SECRET_LENGTH = 24;

/**
 * A shared secret in `Authorization: Bearer <secret>`, for development and for a caller that
 * cannot present an identity token. Compared in constant time (over digests, so length does not
 * leak either). Production deployments use `oidcAuthenticator`.
 */
export function sharedSecretAuthenticator(secret: string): Authenticator {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new UnsupportedOptionError(
      'secret',
      `must be at least ${MIN_SECRET_LENGTH} characters; generate one with: openssl rand -hex 24`
    );
  }
  const expected = digest(secret);
  return async (request) => {
    const given = bearer(request);
    return given !== null && timingSafeEqual(digest(given), expected);
  };
}

/** One RSA public key of a JWKS document. */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
  readonly use?: string;
}

/** `importKey` for a JWK, typed here because the runtime's declarations name the key type only in a namespace. */
type ImportJwk = (
  format: 'jwk',
  key: Jwk,
  algorithm: { readonly name: string; readonly hash: string },
  extractable: boolean,
  usages: readonly ['verify']
) => Promise<CryptoKey>;
const importJwk = crypto.subtle.importKey.bind(crypto.subtle) as unknown as ImportJwk;

/** The public keys of an issuer, as a JWKS document. */
export interface Jwks {
  readonly keys: readonly Jwk[];
}

export interface OidcOptions {
  /** The audience the token must name: the tick endpoint's URL, as Cloud Scheduler is told to use. */
  readonly audience: string;
  /** Emails of the service accounts allowed to call. At least one: a token from any Google account is not enough. */
  readonly allowedEmails: readonly string[];
  /** Default: Google's two issuer spellings. */
  readonly issuers?: readonly string[];
  /** Fetches the issuer's JWKS. Default: Google's certs endpoint. Tests inject their own keys. */
  readonly fetchJwks?: () => Promise<Jwks>;
  /** Token expiry and not-before are judged on this clock. Default: the system clock. */
  readonly clock?: Clock;
  /** Tolerated clock difference, in ms. Default 30,000. */
  readonly skewMs?: number;
  /** How long fetched keys are kept, in ms. Default 1 hour. A key id never seen forces one refetch, at most once a minute. */
  readonly keyTtlMs?: number;
}

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';

async function fetchGoogleJwks(): Promise<Jwks> {
  const response = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`JWKS request failed with ${response.status}`);
  return (await response.json()) as Jwks;
}

interface Claims {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
}

const decodeJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verifies a Google-style OIDC identity token (RS256): the signature against the issuer's keys,
 * the issuer, the audience, the time window, and that the email is a verified one on the allow
 * list. This is what Cloud Scheduler sends with an OIDC token, and what a Cloud Run service sees
 * from any IAM caller. Keys are cached and refetched when a token names a key id not seen yet.
 */
export function oidcAuthenticator(options: OidcOptions): Authenticator {
  if (options.audience === '') throw new UnsupportedOptionError('audience', 'must not be empty');
  if (options.allowedEmails.length === 0) {
    throw new UnsupportedOptionError('allowedEmails', 'needs at least one service account');
  }
  const allowed = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
  const issuers = new Set<string>(options.issuers ?? GOOGLE_ISSUERS);
  const clock = options.clock ?? systemClock;
  const skewMs = options.skewMs ?? 30_000;
  const keyTtlMs = options.keyTtlMs ?? 3_600_000;
  const fetchJwks = options.fetchJwks ?? fetchGoogleJwks;
  const imported = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let loading: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    loading ??= fetchJwks()
      .then(async (jwks) => {
        const next = new Map<string, CryptoKey>();
        for (const jwk of jwks.keys) {
          if (jwk.kid === undefined || jwk.kty !== 'RSA') continue;
          next.set(
            jwk.kid,
            await importJwk('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
              'verify',
            ])
          );
        }
        imported.clear();
        for (const [kid, key] of next) imported.set(kid, key);
        fetchedAt = clock.now();
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  const keyFor = async (kid: string): Promise<CryptoKey | null> => {
    const age = clock.now() - fetchedAt;
    if (age >= keyTtlMs) await refresh();
    else if (!imported.has(kid) && age >= 60_000) await refresh();
    return imported.get(kid) ?? null;
  };

  return async (request) => {
    try {
      const token = bearer(request);
      const parts = token?.split('.');
      if (parts?.length !== 3) return false;
      const [head, body, signature] = parts as [string, string, string];
      const header = decodeJson(head) as { alg?: unknown; kid?: unknown };
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
      const key = await keyFor(header.kid);
      if (key === null) return false;
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${head}.${body}`)
      );
      if (!valid) return false;

      const claims = decodeJson(body) as Claims;
      const now = clock.now();
      if (typeof claims.iss !== 'string' || !issuers.has(claims.iss)) return false;
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audience.includes(options.audience)) return false;
      if (typeof claims.exp !== 'number' || claims.exp * 1000 + skewMs <= now) return false;
      if (
        claims.nbf !== undefined &&
        (typeof claims.nbf !== 'number' || claims.nbf * 1000 - skewMs > now)
      ) {
        return false;
      }
      return (
        claims.email_verified === true &&
        typeof claims.email === 'string' &&
        allowed.has(claims.email.toLowerCase())
      );
    } catch {
      return false;
    }
  };
}
