import type { OidcSession } from './oidc';

/**
 * The running sign-in, for the parts of the app that react to it (the 401 handler, the sign-out
 * button). Null in demo mode and in token mode, where the token prompt is the whole story.
 */
let active: OidcSession | null = null;

export const getActiveSession = (): OidcSession | null => active;
export function setActiveSession(session: OidcSession | null): void {
  active = session;
}
