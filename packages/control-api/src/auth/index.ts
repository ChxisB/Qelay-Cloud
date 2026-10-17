import { createHash, timingSafeEqual } from 'node:crypto';
import type { JWTVerifyGetKey } from 'jose';
import type { ResolvedConfig } from '../config';
import type { Logger } from '../http/log';
import { oidcVerifier } from './oidc';
import type { Authenticator, Principal } from './principal';
import { bearerToken } from './principal';

export type { Authenticator, Principal } from './principal';
export { bearerToken, roleAllows } from './principal';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Builds the service's authenticator from the resolved configuration: the development token (if
 * configured, which `resolveConfig` refuses in production) and the OIDC verifier (if configured). A
 * request with no valid bearer token gets `null`. A valid token that carries no role throws a 403
 * `ApiError`, which the pipeline sends as it is.
 *
 * The comparison of the development token is constant-time over fixed-length digests.
 */
export function createAuthenticator(
  config: ResolvedConfig,
  logger: Logger,
  keys?: JWTVerifyGetKey
): Authenticator {
  const oidc = config.oidc === null ? null : oidcVerifier(config.oidc, config.clock, keys);
  const dev =
    config.devToken === null ? null : { ...config.devToken, hash: digest(config.devToken.token) };
  if (dev !== null) {
    logger.warn('the development token is enabled: use it for local development only');
  }
  return async (request) => {
    const token = bearerToken(request);
    if (token === null) return null;
    if (dev !== null && timingSafeEqual(digest(token), dev.hash)) {
      return { subject: 'dev-token', role: dev.role, source: 'dev-token' } satisfies Principal;
    }
    if (oidc === null || token.split('.').length !== 3) return null;
    const result = await oidc.verify(token);
    if (typeof result === 'string') {
      logger.warn('token refused', { reason: result });
      return null;
    }
    return result;
  };
}
