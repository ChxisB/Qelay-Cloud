import { UnsupportedOptionError } from './errors';
import type { WebhookDocument } from './webhookPath';

/**
 * Inbound sources and the requests they take (DESIGN.md D12 and D14): the part that needs no I/O. The tables are
 * `store.webhooks`' (`qcloud_sources`, `qcloud_requests`), the public listener is `@qelay-cloud/ingest`.
 */

export const VERIFICATION_KINDS = ['none', 'hmac', 'basic', 'api_key'] as const;
export type SourceVerificationKind = (typeof VERIFICATION_KINDS)[number];

/** How a source checks who is posting. The secret is never part of it: the store seals it. */
export interface SourceVerification {
  readonly kind: SourceVerificationKind;
  /** `hmac`: the header that carries the signature. `api_key`: the header that carries the key. Lower case. */
  readonly header: string | null;
  /** `basic`: the user name; the secret is the password. */
  readonly username: string | null;
}

/** Sources one namespace can have. */
export const MAX_SOURCES = 100;
/** Largest request body the ingest takes, in bytes. */
export const MAX_REQUEST_BODY_BYTES = 262_144;
/** Most headers (and, separately, query parameters) a stored request keeps, and the longest value of each in characters. */
export const MAX_REQUEST_PAIRS = 64;
export const MAX_REQUEST_VALUE_CHARS = 2_048;
/** Rejected requests one source stores in a fixed minute; the ones over it are counted and not stored. */
export const MAX_REJECTED_PER_MINUTE = 60;
export const REJECT_WINDOW_MS = 60_000;
/** Replaces the value of a header that carries a credential. */
export const REDACTED = '[redacted]';
/** What a delivery of a request is named: the thing a route's destination was sent. */
export const WEBHOOK_REQUEST_EVENT = 'request.received';

/** Headers whose values are never stored, whatever the source (the source's own verification header is added to them). */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
]);

export const isVerificationKind = (kind: unknown): kind is SourceVerificationKind =>
  typeof kind === 'string' && (VERIFICATION_KINDS as readonly string[]).includes(kind);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/u;
// A user name may not hold ':' (the basic scheme splits on the first one) or a control character.
// oxlint-disable-next-line no-control-regex -- the control characters are what it refuses
const USERNAME = /^[^:\u0000-\u001f\u007f]{1,128}$/u;

/** The verification as the store keeps it, or `UnsupportedOptionError('verification', …)`. */
export function validateVerification(input: unknown): SourceVerification {
  const fail = (reason: string): never => {
    throw new UnsupportedOptionError('verification', reason);
  };
  if (input === undefined || input === null) return { kind: 'none', header: null, username: null };
  if (typeof input !== 'object' || Array.isArray(input)) return fail('must be an object');
  const { kind, header, username } = input as Record<string, unknown>;
  if (!isVerificationKind(kind))
    return fail(`kind must be one of ${VERIFICATION_KINDS.join(', ')}`);
  const wantsHeader = kind === 'hmac' || kind === 'api_key';
  if (!wantsHeader && header != null) return fail(`a ${kind} source has no header`);
  if (kind !== 'basic' && username != null) return fail(`a ${kind} source has no username`);
  if (wantsHeader && (typeof header !== 'string' || !HEADER_NAME.test(header))) {
    return fail('header must be a header name: letters, digits and dashes, up to 64 characters');
  }
  if (kind === 'basic' && (typeof username !== 'string' || !USERNAME.test(username))) {
    return fail('username must be 1 to 128 characters with no colon or control character');
  }
  return {
    kind,
    header: wantsHeader ? (header as string).toLowerCase() : null,
    username: kind === 'basic' ? (username as string) : null,
  };
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A new URL token: `qin_` and 32 random bytes in base64url (47 characters). It is shown once; the store keeps its hash. */
export function generateSourceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const text = btoa(String.fromCharCode(...bytes));
  return `qin_${text.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

/** A new shared secret for a source's verification: `qsec_` and 32 random bytes in hex. */
export const generateSourceSecret = (): string =>
  `qsec_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;

/** What the store keeps of a token, so a copy of the database does not open the source URLs. */
export async function hashSourceToken(token: string): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  );
}

/**
 * Header or query pairs as a request keeps them: names lower case, at most `MAX_REQUEST_PAIRS` of them, values cut to
 * `MAX_REQUEST_VALUE_CHARS`, and the value of a credential header (`REDACTED_HEADERS`, and `alsoRedact`) replaced. It
 * returns a new object with no prototype to reach, and a name such as `__proto__` is an ordinary key.
 */
export function clipPairs(
  pairs: Readonly<Record<string, string>>,
  alsoRedact: string | null = null
): Record<string, string> {
  const kept = new Map<string, string>();
  for (const [name, value] of Object.entries(pairs)) {
    const key = clipText(name.toLowerCase());
    if (!kept.has(key) && kept.size >= MAX_REQUEST_PAIRS) continue;
    kept.set(key, REDACTED_HEADERS.has(key) || key === alsoRedact ? REDACTED : clipText(value));
  }
  return Object.fromEntries(kept);
}

/**
 * Text as a stored request keeps it: no NUL (a `jsonb` or `text` column refuses it, and `%00` in a query string puts one
 * there), at most `MAX_REQUEST_VALUE_CHARS`, and no half of a surrogate pair left by the cut.
 */
export function clipText(text: string): string {
  const cut = text.replaceAll('\0', '').slice(0, MAX_REQUEST_VALUE_CHARS);
  return /[\ud800-\udbff]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

/** Whether a content type says the body is JSON: `application/json`, `application/x+json` or `text/json`. */
export const isJsonContentType = (contentType: string | null): boolean =>
  contentType !== null &&
  /^(?:application\/(?:[\w.-]+\+)?json|text\/json)\s*(?:;|$)/iu.test(contentType.trim());

export interface RequestParts {
  readonly method: string;
  /** As `clipPairs` returns them: redacted and clipped. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

/**
 * The event document of a request: what a route's `filter`, `shape` and `dedupe` read (D14). `body` is there only when
 * the request was JSON and parsed; any other body passes through whole and cannot be addressed.
 */
export function requestDocument(parts: RequestParts): WebhookDocument {
  const document: Record<string, unknown> = {
    method: parts.method.toUpperCase(),
    headers: parts.headers,
    query: parts.query,
  };
  if (parts.body.length > 0 && isJsonContentType(parts.contentType)) {
    try {
      document.body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parts.body));
    } catch {
      // Not JSON after all: it is delivered as it came, and a rule that reads `body` sees nothing.
    }
  }
  return document;
}
