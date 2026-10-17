import type { Socket } from 'bun';

/**
 * One HTTP/1.1 POST over a socket to an address the caller already checked. `fetch` is not used
 * because it resolves the name itself and follows redirects: here the connection goes to exactly
 * the address given (so a name cannot be re-pointed between the check and the connect), TLS is
 * verified against the host name the operator wrote, and nothing is followed. The request closes the
 * connection (`Connection: close`), so there is no pooling to leak between webhooks.
 *
 * Only the status line of the answer is read. The rest of the answer is never buffered, so a
 * receiver cannot make the tick hold a large body, and nothing it says is kept (a body in an error
 * message would let a webhook read back from an internal service). The whole exchange, connect and
 * handshake included, is bounded by `timeoutMs`.
 */

/** The longest status line read. A receiver that sends more before the first line break is not speaking HTTP. */
export const MAX_STATUS_LINE_BYTES = 16 * 1024;

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
  readonly timeoutMs: number;
  /** Extra trusted certificate authority (PEM), for a receiver behind a private CA and for tests. */
  readonly ca?: string;
}

export type PostFailure = 'timeout' | 'refused' | 'tls' | 'reset' | 'protocol';

export type PostResult =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'failed'; readonly failure: PostFailure };

export type PostFunction = (request: PostRequest) => Promise<PostResult>;

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |$)/u;
const encoder = new TextEncoder();
const latin1 = new TextDecoder('latin1');

function encodeRequest(request: PostRequest): Uint8Array {
  const body = encoder.encode(request.body);
  const lines = [
    `POST ${request.path} HTTP/1.1`,
    `Host: ${request.hostHeader}`,
    'User-Agent: qelay-cloud-webhooks/1',
    'Content-Type: application/json',
    `Content-Length: ${body.byteLength}`,
    'Connection: close',
    ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
  ];
  const head = encoder.encode(`${lines.join('\r\n')}\r\n\r\n`);
  const bytes = new Uint8Array(head.byteLength + body.byteLength);
  bytes.set(head, 0);
  bytes.set(body, head.byteLength);
  return bytes;
}

function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a, 0);
  joined.set(b, a.byteLength);
  return joined;
}

/** The status the first line of `received` carries; `'more'` while the line is incomplete. */
function readStatus(received: Uint8Array): number | 'more' | 'bad' {
  const end = received.indexOf(0x0a);
  if (end === -1) return received.byteLength > MAX_STATUS_LINE_BYTES ? 'bad' : 'more';
  const match = STATUS_LINE.exec(latin1.decode(received.subarray(0, end)).replace(/\r$/u, ''));
  if (match === null) return 'bad';
  const status = Number(match[1]);
  // A `1xx` is an interim answer to a request that asked for none: not a result.
  return status < 200 ? 'bad' : status;
}

export const postOverSocket: PostFunction = (request) =>
  new Promise<PostResult>((resolve) => {
    let settled = false;
    let socket: Socket<undefined> | null = null;
    let received: Uint8Array = new Uint8Array(0);
    let pending = encodeRequest(request);
    // Before the handshake is verified a socket error is a TLS failure; after it, a connection that broke.
    let verified = !request.secure;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: PostResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        socket?.terminate();
      } catch {
        // Already closed.
      }
      resolve(result);
    };
    const fail = (failure: PostFailure): void => finish({ kind: 'failed', failure });
    const flush = (target: Socket<undefined>): void => {
      if (pending.byteLength === 0) return;
      const written = target.write(pending);
      pending = pending.subarray(Math.max(0, written));
    };

    timer = setTimeout(() => fail('timeout'), request.timeoutMs);
    const tls = request.secure
      ? {
          rejectUnauthorized: true,
          ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
          ...(request.ca === undefined ? {} : { ca: request.ca }),
        }
      : undefined;
    Bun.connect<undefined>({
      hostname: request.address,
      port: request.port,
      ...(tls === undefined ? {} : { tls }),
      socket: {
        open(opened) {
          socket = opened;
          // A TLS socket opens before its handshake: nothing may be written until `handshake` says it is verified.
          if (!request.secure) flush(opened);
        },
        handshake(shaken, ok) {
          socket = shaken;
          verified = ok;
          if (ok) flush(shaken);
          else fail('tls');
        },
        drain(drained) {
          flush(drained);
        },
        data(_open, chunk) {
          const status = readStatus((received = append(received, chunk)));
          if (status === 'more') return;
          if (status === 'bad') fail('protocol');
          else finish({ kind: 'status', status });
        },
        close() {
          fail('reset');
        },
        error() {
          fail(verified ? 'reset' : 'tls');
        },
        connectError() {
          fail('refused');
        },
        timeout() {
          fail('timeout');
        },
      },
    }).then(
      (connected) => {
        socket = connected;
        // Settled while connecting (the deadline): the socket that just arrived is not wanted.
        if (settled) connected.terminate();
      },
      () => fail('refused')
    );
  });
