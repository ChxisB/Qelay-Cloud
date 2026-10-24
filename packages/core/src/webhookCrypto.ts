import { UnsupportedOptionError } from './errors';

/**
 * Signing and sealing for webhooks, on WebCrypto only (core is pure: no `node:` and no `Bun.`).
 *
 * Signing: `X-Webhook-Signature: v1=<hex>` is HMAC-SHA256 over `<timestamp>.<body>` with the
 * webhook's secret, where `<timestamp>` is the `X-Webhook-Timestamp` header (epoch milliseconds, as
 * sent). The timestamp is in the signed text, so a captured request cannot be replayed with a fresh
 * timestamp; a receiver rejects one more than `DEFAULT_REPLAY_TOLERANCE_MS` from its own clock, and
 * deduplicates on `X-Webhook-Id`.
 *
 * Sealing: a secret is stored encrypted, AES-256-GCM under a key the operator supplies and the
 * database never holds, with the row's identity as the authenticated data so a sealed secret copied
 * to another row does not open.
 */

/** How far a delivery's timestamp may be from the receiver's clock, in either direction. */
export const DEFAULT_REPLAY_TOLERANCE_MS = 300_000;

/** The signature scheme's version prefix. */
export const SIGNATURE_VERSION = 'v1';

const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function fromHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || text.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const hmacKey = (secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

/** `<timestamp>.<body>` as bytes: a body that is bytes (a request's own) is signed as received, never re-encoded. */
const signedText = (
  timestamp: number | string,
  body: string | Uint8Array
): Uint8Array<ArrayBuffer> => {
  const prefix = encoder.encode(`${timestamp}.`);
  const tail = typeof body === 'string' ? encoder.encode(body) : body;
  const signed = new Uint8Array(prefix.byteLength + tail.byteLength);
  signed.set(prefix);
  signed.set(tail, prefix.byteLength);
  return signed;
};

/** A new signing secret: `whsec_` and 32 random bytes in hex (70 characters, within the secret limits). */
export const generateWebhookSecret = (): string =>
  `whsec_${toHex(crypto.getRandomValues(new Uint8Array(32)))}`;

/** The `X-Webhook-Signature` value for a delivery. */
export async function signWebhook(
  secret: string,
  timestamp: number | string,
  body: string | Uint8Array
): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const mac = await crypto.subtle.sign('HMAC', key, signedText(timestamp, body));
  return `${SIGNATURE_VERSION}=${toHex(new Uint8Array(mac))}`;
}

export interface VerifyInput {
  readonly secret: string;
  /** The `X-Webhook-Timestamp` header, as received. */
  readonly timestamp: string;
  readonly body: string;
  /** The `X-Webhook-Signature` header. Several, comma separated, are accepted (a secret being rotated). */
  readonly signature: string;
  /** The receiver's clock, epoch milliseconds. */
  readonly now: number;
  readonly toleranceMs?: number;
}

/**
 * What a receiver does. False for a timestamp outside the window, a malformed signature or a wrong
 * one; the comparison is `crypto.subtle.verify`, which is constant-time.
 */
export async function verifyWebhookSignature(input: VerifyInput): Promise<boolean> {
  const timestamp = Number(input.timestamp);
  const tolerance = input.toleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
  if (!/^\d{1,16}$/u.test(input.timestamp) || Math.abs(input.now - timestamp) > tolerance) {
    return false;
  }
  const key = await hmacKey(input.secret, 'verify');
  const data = signedText(input.timestamp, input.body);
  let matched = false;
  for (const part of input.signature.split(',')) {
    const [version, hex] = part.trim().split('=');
    const mac = version === SIGNATURE_VERSION && hex !== undefined ? fromHex(hex) : null;
    // Every candidate is checked, so the time taken does not say which one matched.
    if (mac !== null && (await crypto.subtle.verify('HMAC', key, mac, data))) matched = true;
  }
  return matched;
}

const SEAL_PREFIX = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The sealing key from its text: 64 hex digits or base64 of 32 bytes. Throws, naming `name`, for anything else. */
export function parseSealKey(text: string, name = 'webhook key'): Uint8Array<ArrayBuffer> {
  const trimmed = text.trim();
  const bytes = /^[0-9a-f]{64}$/iu.test(trimmed) ? fromHex(trimmed) : fromBase64(trimmed);
  if (bytes === null || bytes.length !== KEY_BYTES) {
    throw new UnsupportedOptionError(name, 'must be 32 bytes, as 64 hex digits or base64');
  }
  return bytes;
}

const aesKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> => {
  if (key.length !== KEY_BYTES) {
    throw new UnsupportedOptionError('webhook key', 'must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, [usage]);
};

/** `v1:<iv>:<ciphertext and tag>`, both base64. `context` is authenticated, not stored. */
export async function sealSecret(
  plaintext: string,
  key: Uint8Array,
  context: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await aesKey(key, 'encrypt'),
    encoder.encode(plaintext)
  );
  return `${SEAL_PREFIX}:${toBase64(iv)}:${toBase64(new Uint8Array(sealed))}`;
}

/** The secret, or null when the key or the context is not the one it was sealed with, or the text is damaged. */
export async function openSecret(
  sealed: string,
  key: Uint8Array,
  context: string
): Promise<string | null> {
  const [prefix, ivText, dataText, ...rest] = sealed.split(':');
  if (prefix !== SEAL_PREFIX || ivText === undefined || dataText === undefined || rest.length > 0) {
    return null;
  }
  const iv = fromBase64(ivText);
  const data = fromBase64(dataText);
  if (iv === null || data === null || iv.length !== IV_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      await aesKey(key, 'decrypt'),
      data
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
