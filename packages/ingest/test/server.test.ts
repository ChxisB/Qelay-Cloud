import { afterEach, describe, expect, test } from 'bun:test';
import { testDatabaseUrl } from '../../../test/support/db';
import type { RunningIngest } from '../src';
import { drain, main, startIngest } from '../src';
import { handlerFor, PATH, stubStore } from './support';

const running: RunningIngest[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop(true);
});

const serve = (
  handler: (request: Request) => Promise<Response>,
  over: { maxBodyBytes?: number; readTimeoutMs?: number } = {}
) => {
  const server = startIngest(handler, {
    hostname: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1_024,
    readTimeoutMs: 300,
    ...over,
  });
  running.push(server);
  return server;
};
const at = (server: RunningIngest, path: string) => `http://127.0.0.1:${server.port}${path}`;

/** Writes `raw` to the port and returns what comes back until the server closes or `waitMs` has passed. */
async function raw(port: number, text: string, waitMs: number): Promise<string> {
  let received = '';
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data: (_, data) => {
        received += data.toString();
        done.resolve();
      },
      close: () => done.resolve(),
      error: () => done.resolve(),
    },
  });
  socket.write(text);
  await Promise.race([done.promise, Bun.sleep(waitMs)]);
  socket.end();
  return received;
}

describe('over a real socket', () => {
  test('/healthz answers, and a stored request is answered with its id', async () => {
    const { store, calls } = stubStore();
    const server = serve(handlerFor(store));
    expect((await fetch(at(server, '/healthz'))).status).toBe(200);
    const answer = await fetch(at(server, PATH), { method: 'POST', body: '{"id":500}' });
    expect([answer.status, await answer.json()]).toEqual([200, { id: 'req_1' }]);
    expect(calls.accepted).toHaveLength(1);
  });

  test('a body that streams past the cap is cut off and stored without its body', async () => {
    const { store, calls } = stubStore();
    const server = serve(handlerFor(store, { maxBodyBytes: 1_024 }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i += 1) controller.enqueue(new Uint8Array(1_024));
        controller.close();
      },
    });
    const answer = await fetch(at(server, PATH), {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(answer.status).toBe(413);
    expect(calls.accepted).toEqual([]);
    expect(calls.rejected.map((r) => [r.cause, r.request.body.length])).toEqual([
      ['body too large', 0],
    ]);
  });

  test('a body far past the cap never reaches the handler as a request', async () => {
    const { store, calls } = stubStore();
    const server = serve(handlerFor(store, { maxBodyBytes: 1_024 }));
    const answer = await fetch(at(server, PATH), {
      method: 'POST',
      body: new Uint8Array(512 * 1_024),
    }).catch(() => null);
    expect(answer === null || answer.status === 413).toBe(true);
    expect(calls.accepted).toEqual([]);
  });

  test('a length that is declared and not delivered is cut off at the deadline, stored without a body', async () => {
    const { store, calls } = stubStore();
    const server = serve(handlerFor(store, { readTimeoutMs: 200 }), { readTimeoutMs: 200 });
    const head = `POST ${PATH} HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\nabc`;
    const started = Date.now();
    const text = await raw(server.port, head, 3_000);
    expect(text.startsWith('HTTP/1.1 408')).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.accepted).toEqual([]);
    expect(calls.rejected.map((r) => [r.cause, r.request.body.length])).toEqual([
      ['body not received in time', 0],
    ]);
  });
});

describe('drain', () => {
  test('lets a request in flight finish, then stops', async () => {
    const server = serve(async () => {
      await Bun.sleep(150);
      return new Response('done');
    });
    const inFlight = fetch(at(server, '/')).then((r) => r.text());
    await Bun.sleep(30);
    await drain(server, 2_000);
    expect(await inFlight).toBe('done');
    await expect(fetch(at(server, '/'))).rejects.toThrow();
  });

  test('closes what is still open when the grace has passed', async () => {
    const server = serve(() => new Promise<Response>(() => {}));
    const inFlight = fetch(at(server, '/')).then(
      (r) => r.status,
      () => 'closed'
    );
    await Bun.sleep(30);
    const started = Date.now();
    await drain(server, 100);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await inFlight).toBe('closed');
  });
});

describe('main', () => {
  const env = { QCLOUD_DATABASE_URL: testDatabaseUrl(), QCLOUD_INGEST_PORT: '0' };
  const io = () => {
    const err: string[] = [];
    return { err, io: { out: () => {}, err: (line: string) => void err.push(line) } };
  };

  test('serves until it is asked to stop, then exits 0 after a drain', async () => {
    const stop = new AbortController();
    const { err, io: sink } = io();
    let url = '';
    const exit = main([], env, sink, {
      stopSignal: stop.signal,
      onListening: (server) => {
        url = `http://127.0.0.1:${server.port}`;
      },
    });
    while (url === '') await Bun.sleep(10);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    stop.abort();
    expect(await exit).toBe(0);
    expect(err.map((line) => JSON.parse(line).msg)).toEqual(['listening', 'draining']);
  });

  test('a setting that is wrong stops it with exit 2 and the usage, repeating no value', async () => {
    for (const bad of [
      { QCLOUD_INGEST_PORT: '70000' },
      { QCLOUD_INGEST_MAX_BODY_BYTES: '999999999' },
      { QCLOUD_INGEST_RATE_PER_SOURCE: '0' },
      { QCLOUD_INGEST_SHUTDOWN_GRACE_MS: 'soon' },
      { QCLOUD_DATABASE_URL: '' },
    ]) {
      const { err, io: sink } = io();
      expect(await main([], { ...env, ...bad }, sink), JSON.stringify(bad)).toBe(2);
      const said = err.join('\n');
      expect(said).toContain('usage: qcloud-ingest');
      for (const value of Object.values(bad))
        if (value.length > 3) expect(said).not.toContain(value);
    }
    const { io: sink } = io();
    expect(await main(['serve'], env, sink)).toBe(2);
  });
});
