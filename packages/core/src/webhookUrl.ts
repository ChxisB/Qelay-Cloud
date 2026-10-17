import { MAX_WEBHOOK_URL_CHARS } from './webhook';

/**
 * Where a webhook may point. The service sends requests to addresses an operator typed, from inside
 * the operator's network, so the destination is the attack: a URL that reaches the cloud metadata
 * service, a database or an admin port turns an operator's mistake (or a stolen operator token) into
 * a read of what the network trusts. Two checks, both here, both pure:
 *
 * - `validateWebhookUrl`, at registration and again at send time: the scheme, no credentials in the
 *   URL, and a host that is neither a private name nor an address in a range that is not global
 *   unicast. `URL` already turns decimal, hex, octal and short IPv4 forms and the mixed IPv6 forms
 *   into one canonical host, so what is checked is what a socket would connect to.
 * - `firstBlockedAddress`, at send time, on what the name resolved to. A name can point anywhere, and
 *   can point somewhere else a second later (rebinding), so the sender resolves once, rejects the
 *   delivery if ANY answer is blocked, and connects to the address it checked, never to the name.
 *
 * The rules are an allow-list for IPv6 (only 2000::/3, minus the documentation and protocol
 * assignment blocks) and a deny-list for IPv4 (everything the registry marks as not globally
 * reachable). Addresses that embed an IPv4 address (mapped, NAT64, 6to4) are judged by it.
 * `allowPrivate` turns the address and name checks off, for a development setup that delivers to
 * localhost; `allowHttp` allows `http:`.
 */

export interface WebhookUrlPolicy {
  /** Allow `http:` (default: `https:` only). */
  readonly allowHttp: boolean;
  /** Allow loopback, private and internal destinations. Development only. */
  readonly allowPrivate: boolean;
}

export const STRICT_URL_POLICY: WebhookUrlPolicy = { allowHttp: false, allowPrivate: false };

export type UrlRefusal =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_not_allowed'
  | 'host_not_allowed';

export type UrlVerdict =
  | {
      readonly ok: true;
      readonly url: URL;
      /** Lower case, without brackets or a trailing dot. */
      readonly host: string;
      readonly port: number;
      /** The host is an IP address, so there is nothing to resolve. */
      readonly literal: boolean;
    }
  | { readonly ok: false; readonly code: UrlRefusal; readonly message: string };

const refuse = (code: UrlRefusal, message: string): UrlVerdict => ({ ok: false, code, message });

// --- IPv4 -------------------------------------------------------------------------------------

type Octets = readonly [number, number, number, number];

/** Four decimal parts and nothing else. `URL` and the resolver both hand over this form. */
function parseIPv4(text: string): Octets | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out as unknown as Octets;
}

const u32 = ([a, b, c, d]: Octets): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

const V4_BLOCKS = (
  [
    ['0.0.0.0', 8, 'this network'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'shared address space'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local (cloud metadata)'],
    ['172.16.0.0', 12, 'private'],
    ['192.0.0.0', 24, 'protocol assignments'],
    ['192.0.2.0', 24, 'documentation'],
    ['192.88.99.0', 24, '6to4 relay'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['198.51.100.0', 24, 'documentation'],
    ['203.0.113.0', 24, 'documentation'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved'],
  ] as const
).map(([base, bits, why]) => [u32(parseIPv4(base)!), bits, why] as const);

function v4Reason(octets: Octets): string | null {
  const ip = u32(octets);
  for (const [base, bits, why] of V4_BLOCKS) {
    if ((ip ^ base) >>> (32 - bits) === 0) return why;
  }
  return null;
}

// --- IPv6 -------------------------------------------------------------------------------------

/** Sixteen bytes, from the text form (brackets and zone ids are not part of it). Null if malformed. */
function parseIPv6(text: string): Uint8Array | null {
  if (text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string, mayEndInV4: boolean): number[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    const groups: number[] = [];
    for (const [i, piece] of pieces.entries()) {
      if (piece.includes('.')) {
        const v4 = i === pieces.length - 1 && mayEndInV4 ? parseIPv4(piece) : null;
        if (v4 === null) return null;
        groups.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      } else if (/^[0-9a-f]{1,4}$/iu.test(piece)) {
        groups.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const head = groupsOf(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groupsOf(halves[1]!, true) : [];
  if (head === null || tail === null) return null;
  let groups = head;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else if (head.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function inPrefix(bytes: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i += 1) if (bytes[i] !== prefix[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[whole]! & mask) === (prefix[whole]! & mask);
}

const v6 = (text: string): Uint8Array => parseIPv6(text)!;

const MAPPED = v6('::ffff:0:0');
const NAT64 = v6('64:ff9b::');
const SIX_TO_FOUR = v6('2002::');
const GLOBAL_UNICAST = v6('2000::');
const V6_BLOCKS: ReadonlyArray<readonly [Uint8Array, number, string]> = [
  [v6('2001::'), 23, 'protocol assignments (Teredo, ORCHID, benchmarking)'],
  [v6('2001:db8::'), 32, 'documentation'],
  [v6('3fff::'), 20, 'documentation'],
];

const octetsAt = (bytes: Uint8Array, at: number): Octets => [
  bytes[at]!,
  bytes[at + 1]!,
  bytes[at + 2]!,
  bytes[at + 3]!,
];

function v6Reason(bytes: Uint8Array): string | null {
  // An address that carries an IPv4 address goes where that address goes.
  if (inPrefix(bytes, MAPPED, 96)) return v4Reason(octetsAt(bytes, 12));
  if (inPrefix(bytes, NAT64, 96)) return v4Reason(octetsAt(bytes, 12));
  if (inPrefix(bytes, SIX_TO_FOUR, 16)) return v4Reason(octetsAt(bytes, 2));
  for (const [prefix, bits, why] of V6_BLOCKS) if (inPrefix(bytes, prefix, bits)) return why;
  return inPrefix(bytes, GLOBAL_UNICAST, 3) ? null : 'not a global unicast address';
}

/**
 * Why a connection to `address` is refused, or null when it may go ahead. `address` is the text a
 * resolver returns, with or without brackets. Anything that does not parse is refused.
 */
export function addressBlockReason(address: string): string | null {
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (text.includes(':')) {
    const bytes = parseIPv6(text);
    return bytes === null ? 'not a valid IP address' : v6Reason(bytes);
  }
  const octets = parseIPv4(text);
  return octets === null ? 'not a valid IP address' : v4Reason(octets);
}

/** The first of `addresses` that may not be connected to, with why; null when all may. An empty list is refused. */
export function firstBlockedAddress(
  addresses: readonly string[]
): { readonly address: string; readonly reason: string } | null {
  if (addresses.length === 0) return { address: '', reason: 'the name did not resolve' };
  for (const address of addresses) {
    const reason = addressBlockReason(address);
    if (reason !== null) return { address, reason };
  }
  return null;
}

// --- Names ------------------------------------------------------------------------------------

const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'localdomain',
  'home.arpa',
  'lan',
  'corp',
  'intranet',
];
const PRIVATE_NAMES = ['metadata.goog'];

function nameReason(host: string): string | null {
  if (!host.includes('.')) return 'a name with no dot is resolved inside the local network';
  if (PRIVATE_NAMES.includes(host)) return 'a cloud metadata name';
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return `a private name (.${suffix})`;
  }
  // `URL` has already turned every valid numeric form into an address, so a last label that is
  // all digits or `0x..` here is one a resolver might still read as a number.
  const last = host.slice(host.lastIndexOf('.') + 1);
  if (/^(?:\d+|0x[0-9a-f]*)$/iu.test(last)) return 'an ambiguous numeric host';
  return null;
}

/**
 * Checks a webhook URL without touching the network. `ok` carries the parsed URL and the host to
 * connect to; a refusal carries a stable `code` and a message an operator can act on.
 */
export function validateWebhookUrl(raw: unknown, policy: WebhookUrlPolicy): UrlVerdict {
  if (typeof raw !== 'string' || raw === '') return refuse('invalid_url', 'url must be a string');
  if (raw.length > MAX_WEBHOOK_URL_CHARS) {
    return refuse('invalid_url', `url must be at most ${MAX_WEBHOOK_URL_CHARS} characters`);
  }
  if (raw !== raw.trim()) return refuse('invalid_url', 'url must not have surrounding whitespace');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('invalid_url', 'url is not a valid absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    return refuse(
      'scheme_not_allowed',
      policy.allowHttp ? 'url must be http or https' : 'url must be https'
    );
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('credentials_not_allowed', 'url must not contain a user name or password');
  }
  const bracketed = url.hostname.startsWith('[');
  const host = (bracketed ? url.hostname.slice(1, -1) : url.hostname)
    .replace(/\.$/u, '')
    .toLowerCase();
  if (host === '') return refuse('invalid_url', 'url has no host');
  const literal = bracketed || parseIPv4(host) !== null;
  if (!policy.allowPrivate) {
    const reason = literal ? addressBlockReason(host) : nameReason(host);
    if (reason !== null) return refuse('host_not_allowed', `host is not allowed: ${reason}`);
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return { ok: true, url, host, port, literal };
}
