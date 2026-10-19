import type { Socket } from 'bun';
import type { PostFailure, PostFunction, PostRequest, PostResult } from './webhookHttp';
import { append, encodeRequest, NO_BODY, readBody, readFraming, readStatus } from './webhookHttp';

/**
 * One HTTP/1.1 POST over a socket to an address the caller already checked. `fetch` is not used
 * because it resolves the name itself and follows redirects: here the connection goes to exactly
 * the address given (so a name cannot be re-pointed between the check and the connect), TLS is
 * verified against the host name the operator wrote, and nothing is followed. The whole exchange,
 * connect and handshake included, is bounded by `timeoutMs`.
 *
 * With `keepAliveMs` above 0 a connection that answered cleanly waits for the next request instead of
 * closing, and a request to the same address, port and TLS name takes it: a new TLS connection to a
 * receiver costs about three round trips, a reused one none. The pool is keyed by all of them (and the
 * extra CA), so a connection verified for one name is never used for another, and it carries no
 * state between requests: every request brings its own headers and signature. A connection is parked
 * only when the answer's end is known (`readFraming`) and nothing else came after it. With 0 each
 * request asks the receiver to close (`Connection: close`) and nothing is pooled.
 *
 * A parked connection can be closed by the receiver at the moment of the next request. When a reused
 * connection fails before a byte of the answer, the request goes again once on a new connection: it
 * never reached the receiver, or the receiver closed it unread, and at-least-once delivery already
 * has receivers deduplicate on the delivery id.
 */

/** Idle connections kept in all; past it the oldest closes. */
export const MAX_IDLE_CONNECTIONS = 256;

/** How long an answered connection may take to finish its body before it is dropped instead of parked. */
const DRAIN_MS = 2_000;

export interface SocketPoolOptions {
  /** How long an idle connection is kept. 0: no pooling, each request closes its connection. */
  readonly keepAliveMs: number;
  readonly maxIdle?: number;
}

export interface SocketPool {
  readonly post: PostFunction;
  /** Connections waiting for a request. */
  idle(): number;
  /** Closes every idle connection. A request in flight finishes, and its connection is closed after it. */
  close(): void;
}

/** What a request on a connection is told: the connection's handlers call these. */
interface Exchange {
  open(socket: Socket<undefined>): void;
  shaken(socket: Socket<undefined>, ok: boolean): void;
  drain(socket: Socket<undefined>): void;
  data(chunk: Uint8Array): void;
  closed(): void;
  errored(): void;
  refused(): void;
}

interface Conn {
  readonly key: string;
  socket: Socket<undefined> | null;
  exchange: Exchange | null;
  timer: ReturnType<typeof setTimeout> | null;
  reused: boolean;
}

const keyOf = (request: PostRequest): string =>
  [
    request.secure ? 's' : 'p',
    request.address,
    request.port,
    request.serverName ?? '',
    request.ca === undefined ? '' : Bun.hash(request.ca),
  ].join('|');

export function createSocketPool(options: SocketPoolOptions): SocketPool {
  const { keepAliveMs } = options;
  const maxIdle = options.maxIdle ?? MAX_IDLE_CONNECTIONS;
  const parked = new Set<Conn>();
  const idleBy = new Map<string, Conn[]>();
  let closed = false;

  const unpark = (conn: Conn): void => {
    if (conn.timer !== null) clearTimeout(conn.timer);
    conn.timer = null;
    if (!parked.delete(conn)) return;
    const rest = (idleBy.get(conn.key) ?? []).filter((other) => other !== conn);
    if (rest.length === 0) idleBy.delete(conn.key);
    else idleBy.set(conn.key, rest);
  };
  const destroy = (conn: Conn): void => {
    unpark(conn);
    conn.exchange = null;
    try {
      conn.socket?.terminate();
    } catch {
      // Already closed.
    }
  };
  const park = (conn: Conn): void => {
    conn.exchange = null;
    if (closed) return destroy(conn);
    conn.timer = setTimeout(() => destroy(conn), keepAliveMs);
    parked.add(conn);
    idleBy.set(conn.key, [...(idleBy.get(conn.key) ?? []), conn]);
    if (parked.size > maxIdle) destroy(parked.values().next().value!);
  };
  const take = (key: string): Conn | null => {
    const conn = idleBy.get(key)?.at(-1) ?? null;
    if (conn !== null) unpark(conn);
    return conn;
  };

  const post: PostFunction = (request) =>
    new Promise<PostResult>((resolve) => {
      const key = keyOf(request);
      let answered = false;
      let finished = false;
      let conn: Conn | null = null;
      let received: Uint8Array = new Uint8Array(0);
      let pending: Uint8Array = new Uint8Array(0);
      let verified = false;
      let retried = false;
      let status = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const answer = (result: PostResult): void => {
        if (answered) return;
        answered = true;
        resolve(result);
      };
      const statusResult = (body: string): PostResult =>
        body === '' ? { kind: 'status', status } : { kind: 'status', status, body };
      /** The exchange is over: the connection is parked when it ended clean, closed otherwise. */
      const end = (reuse: boolean): void => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimeout(timer);
        if (conn === null) return;
        if (reuse) park(conn);
        else destroy(conn);
      };
      const fail = (failure: PostFailure): void => {
        if (answered) return end(false);
        if (status !== 0) {
          // The status came and the body is what was awaited: a slow or cut body does not change the answer.
          answer(statusResult(readBody(received, status, request.captureBytes ?? 0).text));
          return end(false);
        }
        if (conn?.reused === true && received.byteLength === 0 && !retried) {
          retried = true;
          destroy(conn);
          return start(false);
        }
        answer({ kind: 'failed', failure });
        end(false);
      };
      const flush = (target: Socket<undefined>): void => {
        if (pending.byteLength === 0) return;
        const written = target.write(pending);
        pending = pending.subarray(Math.max(0, written));
      };

      const exchange: Exchange = {
        // A TLS socket opens before its handshake: nothing may be written until `shaken` says it is verified.
        open(socket) {
          if (!request.secure) flush(socket);
        },
        shaken(socket, ok) {
          verified = ok;
          if (ok) flush(socket);
          else fail('tls');
        },
        drain: flush,
        data(chunk) {
          received = append(received, chunk);
          if (!answered) {
            if (status === 0) {
              const first = readStatus(received);
              if (first === 'more') return;
              if (first === 'bad') return fail('protocol');
              status = first;
            }
            // A failing answer's first bytes are kept as the reason, so its answer waits for them.
            const capture = request.captureBytes ?? 0;
            const body =
              status < 300 || capture === 0 ? NO_BODY : readBody(received, status, capture);
            if (!body.done) return;
            answer(statusResult(body.text));
            if (keepAliveMs === 0) return end(false);
            // The rest of the answer is read and dropped, to see whether the connection is clean.
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => end(false), DRAIN_MS);
          }
          const framing = readFraming(received, status);
          if (framing === 'more' || (framing !== null && received.byteLength < framing.total))
            return;
          end(
            framing !== null && received.byteLength === framing.total && pending.byteLength === 0
          );
        },
        closed() {
          fail('reset');
        },
        // Before the handshake is verified a socket error is a TLS failure; after it, a connection that broke.
        errored() {
          fail(verified ? 'reset' : 'tls');
        },
        refused() {
          fail('refused');
        },
      };

      const connect = (): void => {
        const created: Conn = { key, socket: null, exchange, timer: null, reused: false };
        conn = created;
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
            open(socket) {
              created.socket = socket;
              created.exchange?.open(socket);
            },
            handshake(socket, ok) {
              created.socket = socket;
              created.exchange?.shaken(socket, ok);
            },
            drain(socket) {
              created.exchange?.drain(socket);
            },
            data(_socket, chunk) {
              // Bytes on a parked connection are not an answer to anything: it is not trusted again.
              if (created.exchange === null) destroy(created);
              else created.exchange.data(chunk);
            },
            close() {
              if (created.exchange === null) unpark(created);
              else created.exchange.closed();
            },
            error() {
              if (created.exchange === null) destroy(created);
              else created.exchange.errored();
            },
            connectError() {
              created.exchange?.refused();
            },
          },
        }).then(
          (connected) => {
            created.socket = connected;
            // Ended while connecting (the deadline): the socket that just arrived is not wanted.
            if (finished || created.exchange !== exchange) connected.terminate();
          },
          () => created.exchange?.refused()
        );
      };

      const start = (reuse: boolean): void => {
        received = new Uint8Array(0);
        pending = encodeRequest(request, keepAliveMs > 0);
        verified = !request.secure;
        const parkedConn = reuse ? take(key) : null;
        const socket = parkedConn?.socket ?? null;
        if (parkedConn === null || socket === null) {
          if (parkedConn !== null) destroy(parkedConn);
          return connect();
        }
        conn = parkedConn;
        parkedConn.reused = true;
        parkedConn.exchange = exchange;
        flush(socket);
      };

      timer = setTimeout(() => fail('timeout'), request.timeoutMs);
      start(keepAliveMs > 0);
    });

  return {
    post,
    idle: () => parked.size,
    close() {
      closed = true;
      for (const conn of [...parked]) destroy(conn);
    },
  };
}

/** One request per connection, closed after the answer: what a tick that runs once wants. */
export const postOverSocket: PostFunction = createSocketPool({ keepAliveMs: 0 }).post;
