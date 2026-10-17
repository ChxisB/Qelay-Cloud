import type { Role } from '../types';

/** Who is calling, as far as the service knows. */
export interface Principal {
  readonly subject: string;
  readonly role: Role;
  readonly source: 'oidc' | 'dev-token';
}

/** A principal, or null when the request carries no valid credential. */
export type Authenticator = (request: Request) => Promise<Principal | null>;

/** Upper bound on an Authorization header, so a hostile one is refused before any parsing. */
export const MAX_AUTHORIZATION_BYTES = 8 * 1024;

/** The token of a well-formed `Authorization: Bearer <token>` header, else null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null || header.length > MAX_AUTHORIZATION_BYTES) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export const roleAllows = (role: Role, needed: Role): boolean =>
  needed === 'viewer' || role === 'operator';
