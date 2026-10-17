import type { Clock } from '@qelay-cloud/core';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { OidcSettings } from '../config';
import { ApiError } from '../errors';
import type { Role } from '../types';
import type { Principal } from './principal';

type Settings = Required<OidcSettings>;

/** Why a token was refused, for the operator's log. It is never sent to the caller. */
export type RejectReason =
  | 'expired'
  | 'not-yet-valid'
  | 'issuer'
  | 'audience'
  | 'signature'
  | 'unknown-key'
  | 'claims'
  | 'malformed'
  | 'keys-unavailable';

export interface OidcVerifier {
  /** The principal a valid token names, or the reason it is not valid. Throws `ApiError` (403) for a valid token with no role. */
  verify(token: string): Promise<Principal | RejectReason>;
}

/** The claim as a list of strings: an array, or a string split on whitespace. A literal key wins over a dotted path. */
export function claimValues(payload: JWTPayload, path: string): string[] {
  let node: unknown = payload[path];
  if (node === undefined) {
    node = payload;
    for (const key of path.split('.')) {
      if (typeof node !== 'object' || node === null) return [];
      node = (node as Record<string, unknown>)[key];
    }
  }
  if (typeof node === 'string') return node.split(/\s+/).filter((value) => value !== '');
  if (Array.isArray(node))
    return node.filter((value): value is string => typeof value === 'string');
  return [];
}

export function roleFor(payload: JWTPayload, settings: Settings): Role | null {
  const granted = new Set(claimValues(payload, settings.roleClaim));
  if (settings.operatorRoles.some((name) => granted.has(name))) return 'operator';
  if (settings.viewerRoles.some((name) => granted.has(name))) return 'viewer';
  return null;
}

function reasonOf(error: unknown): RejectReason {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return 'issuer';
    if (error.claim === 'aud') return 'audience';
    if (error.claim === 'nbf') return 'not-yet-valid';
    return 'claims';
  }
  if (error instanceof errors.JWKSNoMatchingKey) return 'unknown-key';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'signature';
  if (
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  ) {
    return 'malformed';
  }
  // A key set that cannot be fetched or read is the service's fault, and the operator's to fix.
  return 'keys-unavailable';
}

/**
 * Verifies a bearer JWT with `jose`: the signature against the issuer's JWKS, an allow-list of
 * asymmetric algorithms, the issuer, the audience, `exp` (required) and `nbf` with a clock
 * tolerance, and a `sub`. Keys are fetched from `jwksUrl`, cached, and refetched when a token names
 * a `kid` that is not cached, at most once per `jwksCooldownMs`. Nothing about a refusal reaches
 * the caller: they see 401 whatever the reason.
 */
export function oidcVerifier(
  settings: Settings,
  clock: Clock,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(settings.jwksUrl), {
    cooldownDuration: settings.jwksCooldownMs,
    cacheMaxAge: settings.jwksCacheMs,
    timeoutDuration: 5_000,
  })
): OidcVerifier {
  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer: settings.issuer,
          audience: [...settings.audience],
          algorithms: [...settings.algorithms],
          clockTolerance: settings.clockToleranceSec,
          currentDate: new Date(clock.now()),
          requiredClaims: ['exp', 'sub'],
        }));
      } catch (error) {
        return reasonOf(error);
      }
      const role = roleFor(payload, settings);
      if (role === null) {
        throw new ApiError(403, 'forbidden', 'the token grants no role on this service');
      }
      return { subject: payload.sub as string, role, source: 'oidc' };
    },
  };
}
