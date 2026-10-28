/**
 * The wire side of one webhook POST: the request as HTTP/1.1 bytes, and how much of the answer is
 * read. The sockets are in `webhookPool.ts`.
 *
 * The status line is always read. The rest of the answer is never buffered, with one exception: when
 * the request asks (`captureBytes`), the first bytes of a failing answer's body are kept as text for
 * the delivery history (`readBody`), so "why did it fail" has an answer better than "HTTP 400". The
 * sender only connects to addresses that passed its public-address check, so what is kept is what a
 * public receiver said about its own request. A connection is reused only when the answer's end can
 * be known from its headers (`readFraming`); anything else closes it.
 */

/** The longest status line, and the longest header block, read. A receiver that sends more is not speaking HTTP. */
export const MAX_STATUS_LINE_BYTES = 16 * 1024;

/** The largest answer body a connection is kept for: it is read and thrown away to find the next answer's start. */
export const MAX_DRAIN_BYTES = 64 * 1024;

export interface PostRequest {
  /** The address to connect to: the one that passed the address check, never the name. */
  readonly address: string;
  readonly port: number;
  readonly secure: boolean;
  /** What the certificate is checked against. Left out for an IP literal. */
  readonly serverName?: string;
  /** The `Host` header: the URL's host and, if not the default, its port. */
  readonly hostHeader: string;
  /** The path and query of the URL. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Sent instead of `body`, as they are: a request's own bytes (D14). */
  readonly bytes?: Uint8Array;
  /** The `Content-Type` header. Absent: `application/json`. */
  readonly contentType?: string;
  readonly timeoutMs: number;
  /** Extra trusted certificate authority (PEM), for a receiver behind a private CA and for tests. */
  readonly ca?: string;
  /** Bytes of a failing answer's body to keep (`readBody`). Absent or 0: none, and the answer is not waited for. */
  readonly captureBytes?: number;
  /** The `User-Agent` header. Absent: `DEFAULT_USER_AGENT`. */
  readonly userAgent?: string;
}

export type PostFailure = 'timeout' | 'refused' | 'tls' | 'reset' | 'protocol';

export type PostResult =
  | { readonly kind: 'status'; readonly status: number; readonly body?: string }
  | { readonly kind: 'failed'; readonly failure: PostFailure };

export type PostFunction = (request: PostRequest) => Promise<PostResult>;

export const DEFAULT_USER_AGENT = 'qelay-cloud-webhooks/1';

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |$)/u;
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

/** `keepAlive` false asks the receiver to close after the answer. */
export function encodeRequest(request: PostRequest, keepAlive: boolean): Uint8Array {
  const body = request.bytes ?? encoder.encode(request.body);
  const lines = [
    `POST ${request.path} HTTP/1.1`,
    `Host: ${request.hostHeader}`,
    `User-Agent: ${request.userAgent ?? DEFAULT_USER_AGENT}`,
    `Content-Type: ${request.contentType ?? 'application/json'}`,
    `Content-Length: ${body.byteLength}`,
    `Connection: ${keepAlive ? 'keep-alive' : 'close'}`,
    ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
  ];
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head, 0);
  bytes.set(body, head.byteLength);
  return bytes;
}

export function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  return joined;
}

/** The status the first line of `received` carries; `'more'` while the line is incomplete. */
export function readStatus(received: Uint8Array): number | 'more' | 'bad' {
  const end = received.indexOf(0x0a);
  if (end === -1) return received.byteLength > MAX_STATUS_LINE_BYTES ? 'bad' : 'more';
  const match = STATUS_LINE.exec(latin1.decode(received.subarray(0, end)).replace(/\r$/u, ''));
  if (match === null) return 'bad';
  const status = Number(match[1]);
  // A `1xx` is an interim answer to a request that asked for none: not a result.
  return status < 200 ? 'bad' : status;
}

/**
 * How many bytes the whole answer is (`total`, head and body), when the connection may carry another
 * request after it: `'more'` while the header block is incomplete, null when it may not. That is any
 * answer that says `Connection: close`, has no single plain `Content-Length` (chunked or closed by the
 * end of the stream), or has a body larger than `MAX_DRAIN_BYTES`.
 */
export function readFraming(
  received: Uint8Array,
  status: number
): { readonly total: number } | 'more' | null {
  const text = latin1.decode(received);
  // HTTP/1.0 closes unless the receiver says otherwise; it is not worth reading that out.
  if (!text.startsWith('HTTP/1.1')) return null;
  const split = text.indexOf('\r\n\r\n');
  if (split === -1) return received.byteLength > MAX_STATUS_LINE_BYTES ? null : 'more';
  let length: number | null = status === 204 || status === 304 ? 0 : null;
  for (const line of text.slice(0, split).split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'connection' && /close/iu.test(value)) return null;
    if (name === 'transfer-encoding') return null;
    if (name === 'content-length' && status !== 204 && status !== 304) {
      // Two lengths are a request-smuggling shape: not trusted.
      if (length !== null || !/^\d{1,9}$/u.test(value)) return null;
      length = Number(value);
    }
  }
  if (length === null || length > MAX_DRAIN_BYTES) return null;
  return { total: split + 4 + length };
}

const CONTROL = /\p{Cc}/gu;

/** Nothing to wait for and nothing to keep. */
export const NO_BODY = { text: '', done: true } as const;

/**
 * The first `cap` bytes of an answer's body as text (control characters become spaces, bad UTF-8
 * becomes U+FFFD), and whether that is all there will be: `done` is false while more bytes are
 * needed to fill `cap` or to reach the body's end. A chunked body is decoded. A body with a
 * `Content-Encoding` is bytes, not text, and a 204 or 304 has none: both are empty and done.
 */
export function readBody(
  received: Uint8Array,
  status: number,
  cap: number
): { readonly text: string; readonly done: boolean } {
  if (status === 204 || status === 304) return NO_BODY;
  const text = latin1.decode(received);
  const split = text.indexOf('\r\n\r\n');
  if (split === -1) {
    return received.byteLength > MAX_STATUS_LINE_BYTES ? NO_BODY : { text: '', done: false };
  }
  let chunked = false;
  let length: number | null = null;
  for (const line of text.slice(0, split).split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) return NO_BODY;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'content-encoding' && !/^identity$/iu.test(value)) return NO_BODY;
    if (name === 'transfer-encoding') chunked = /chunked/iu.test(value);
    if (name === 'content-length' && /^\d{1,9}$/u.test(value)) length = Number(value);
  }
  const start = split + 4;
  const wanted = Math.min(length ?? cap, cap);
  const taken = chunked
    ? dechunk(received, start, cap)
    : {
        bytes: received.subarray(start, start + wanted),
        done: received.byteLength - start >= wanted,
      };
  const body = new TextDecoder()
    .decode(taken.bytes)
    .replace(CONTROL, (c) => (c === '\n' || c === '\t' ? c : ' '))
    .trim();
  return { text: body, done: taken.done };
}

/** The first `cap` bytes of the chunks that begin at `from`; `done` at the last chunk or when `cap` is reached. */
function dechunk(
  received: Uint8Array,
  from: number,
  cap: number
): { readonly bytes: Uint8Array; readonly done: boolean } {
  const out = new Uint8Array(cap);
  let got = 0;
  let at = from;
  for (;;) {
    if (got >= cap) return { bytes: out.subarray(0, got), done: true };
    const lineEnd = received.indexOf(0x0a, at);
    if (lineEnd === -1) return { bytes: out.subarray(0, got), done: false };
    const size = Number.parseInt(
      latin1.decode(received.subarray(at, lineEnd)).split(';')[0]!.trim(),
      16
    );
    if (!Number.isSafeInteger(size) || size <= 0)
      return { bytes: out.subarray(0, got), done: true };
    const data = lineEnd + 1;
    const have = Math.min(size, received.byteLength - data, cap - got);
    out.set(received.subarray(data, data + have), got);
    got += have;
    if (have < size && got < cap) return { bytes: out.subarray(0, got), done: false };
    at = data + size + 2;
  }
}
