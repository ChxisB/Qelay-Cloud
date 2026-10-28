import { timingSafeEqual } from 'node:crypto';
import type { SourceAuth } from '@qelay-cloud/store-postgres';

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Equal text without the length or the first differing byte showing in the time it takes: both are hashed first. */
async function sameText(a: string, b: string): Promise<boolean> {
  return timingSafeEqual(await digest(a), await digest(b));
}

/** The 32 bytes of a signature written as hex or base64 (url-safe too), with or without a `sha256=` prefix; else null. */
function signatureBytes(header: string): Uint8Array<ArrayBuffer> | null {
  const value = header.trim().replace(/^sha256=/iu, '');
  if (/^[0-9a-f]{64}$/iu.test(value)) return Uint8Array.from(Buffer.from(value, 'hex'));
  if (/^[A-Za-z0-9+/_-]{43}=?$/u.test(value)) {
    const bytes = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    return bytes.length === 32 ? Uint8Array.from(bytes) : null;
  }
  return null;
}

async function hmacMatches(
  secret: string,
  signature: Uint8Array<ArrayBuffer>,
  body: Uint8Array<ArrayBuffer>
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, signature, body);
}

/** The user name and password of a `Basic` header, or null when it is not one. The user name has no colon (the store sees to it). */
function basicCredentials(header: string): { user: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+=*)\s*$/iu.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon < 0 ? null : { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Whether the request is from someone who holds the source's secret. One answer, no reason: the caller must not tell a
 * wrong credential from a missing one. A source that verifies but whose secret could not be opened accepts nothing.
 * The current secret and, while it still verifies, the one before the last rotation are both tried.
 */
export async function verifies(
  source: SourceAuth,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>
): Promise<boolean> {
  const { kind, header, username } = source.verification;
  if (kind === 'none') return true;
  const secrets = [source.secret, source.previousSecret].filter((s): s is string => s !== null);
  if (source.secretUnreadable || secrets.length === 0) return false;

  if (kind === 'hmac') {
    const signature = signatureBytes(headers.get(header ?? '') ?? '');
    if (signature === null) return false;
    let ok = false;
    for (const secret of secrets) ok = (await hmacMatches(secret, signature, body)) || ok;
    return ok;
  }
  if (kind === 'api_key') {
    const given = headers.get(header ?? '');
    if (given === null) return false;
    let ok = false;
    for (const secret of secrets) ok = (await sameText(given, secret)) || ok;
    return ok;
  }
  const given = basicCredentials(headers.get('authorization') ?? '');
  if (given === null) return false;
  const userOk = await sameText(given.user, username ?? '');
  let passwordOk = false;
  for (const secret of secrets) passwordOk = (await sameText(given.password, secret)) || passwordOk;
  return userOk && passwordOk;
}
