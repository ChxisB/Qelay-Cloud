import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * A throwaway OIDC issuer for the smoke test (`scripts/smoke-gcp.ts --local`): one ES256 key, a JWKS
 * endpoint on a loopback port, and a way to sign a token the Control API accepts. It lives here
 * because `jose` is this package's dependency. It is not an identity provider: it signs whatever it
 * is asked to, for whoever runs it, on 127.0.0.1.
 */
export interface LocalIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  token(claims?: Record<string, unknown>): Promise<string>;
  stop(): Promise<void>;
}

export async function startLocalIssuer(
  issuer = 'http://127.0.0.1/smoke-issuer',
  audience = 'qelay-control-api-smoke'
): Promise<LocalIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'smoke-1', alg: 'ES256', use: 'sig' };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => Response.json({ keys: [jwk] }),
  });
  return {
    issuer,
    audience,
    jwksUrl: `http://127.0.0.1:${server.port}/jwks.json`,
    async token(claims = {}) {
      const nowSec = Math.floor(Date.now() / 1000);
      return new SignJWT({ roles: ['operator'], ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: 'smoke-1' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('smoke-test')
        .setIssuedAt(nowSec)
        .setExpirationTime(nowSec + 600)
        .sign(privateKey);
    },
    async stop() {
      await server.stop(true);
    },
  };
}
