import { describe, expect, test } from 'bun:test';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { OpenRuntime, RunningServer } from '../src';
import { drain, main } from '../src';

const TOKEN = 'dev-token-0123456789-abcdefghij';
const PASSWORD = 'hunter2-db-password';
const ENV = {
  QCLOUD_DATABASE_URL: `postgres://qcloud:${PASSWORD}@db.internal:5432/qcloud`,
  QCLOUD_API_DEV_TOKEN: TOKEN,
  QCLOUD_API_PORT: '0',
};

function io() {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    lines,
    io: { out: (l: string) => lines.out.push(l), err: (l: string) => lines.err.push(l) },
  };
}

/** A runtime with no database: what the process does around the store is what these tests cover. */
function fakeOpen(): { open: OpenRuntime; closed: () => number; seen: string[] } {
  let closed = 0;
  const seen: string[] = [];
  const open: OpenRuntime = (settings) => {
    seen.push(`${settings.namespace}/${settings.transport}`);
    return {
      deps: {
        transport: { name: 'memory', capabilities: new MemoryTransport().capabilities },
        readiness: {
          database: async () => {},
          transport: () => 'ok',
          tick: async () => null,
        },
      },
      close: async () => {
        closed += 1;
      },
    };
  };
  return { open, closed: () => closed, seen };
}

async function running(env: Record<string, string>, open: OpenRuntime) {
  const stop = new AbortController();
  const { io: sink, lines } = io();
  let server!: RunningServer;
  const listening = new Promise<void>((resolve) => {
    void main([], env, sink, {
      open,
      stopSignal: stop.signal,
      onListening: (s) => {
        server = s;
        resolve();
      },
    }).then((code) => {
      exit = code;
    });
  });
  let exit: number | undefined;
  await listening;
  return {
    server,
    lines,
    stop: async () => {
      stop.abort();
      for (let i = 0; i < 100 && exit === undefined; i += 1) await Bun.sleep(10);
      return exit;
    },
  };
}

describe('main', () => {
  test('serves, answers /health without a token, then drains and closes on stop', async () => {
    const fake = fakeOpen();
    const app = await running(
      { ...ENV, QCLOUD_NAMESPACE: 'staging', QCLOUD_TRANSPORT: 'postgres' },
      fake.open
    );
    const base = `http://127.0.0.1:${app.server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, status: 'healthy' });

    // Everything else is behind the token.
    expect((await fetch(`${base}/health/ready`)).status).toBe(401);
    const ready = await fetch(`${base}/health/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ready.status).toBe(200);

    expect(fake.seen).toEqual(['staging/postgres']);
    expect(await app.stop()).toBe(0);
    expect(fake.closed()).toBe(1);
    expect(app.lines.err.join('\n')).toContain('draining');
    // The port is released: nothing answers.
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  test('a configuration error is exit 2, names the variable, opens nothing and repeats no secret', async () => {
    const fake = fakeOpen();
    const { io: sink, lines } = io();
    const code = await main(
      [],
      { ...ENV, NODE_ENV: 'production', QCLOUD_API_HOST: '0.0.0.0' },
      sink,
      { open: fake.open }
    );
    expect(code).toBe(2);
    expect(fake.seen).toEqual([]);
    const text = lines.err.join('\n');
    expect(text).toMatch(/production/);
    for (const secret of [TOKEN, PASSWORD]) expect(text).not.toContain(secret);
  });

  test('a missing database URL is exit 2', async () => {
    const { io: sink, lines } = io();
    const { QCLOUD_DATABASE_URL: _omitted, ...rest } = ENV;
    expect(await main([], rest, sink, { open: fakeOpen().open })).toBe(2);
    expect(lines.err.join('\n')).toMatch(/"QCLOUD_DATABASE_URL" is required/);
  });

  test('a stray argument is a usage error', async () => {
    const { io: sink, lines } = io();
    expect(await main(['--port', '1'], ENV, sink, { open: fakeOpen().open })).toBe(2);
    expect(lines.err.join('\n')).toMatch(/^usage: qcloud-api/);
  });

  test('a failure to start is exit 1 with the secret removed, and the runtime is still closed', async () => {
    let closed = 0;
    const { io: sink, lines } = io();
    const open: OpenRuntime = () => ({
      deps: fakeOpen().open({} as never).deps,
      close: async () => {
        closed += 1;
      },
    });
    // The port is taken, so listening fails after the runtime was opened.
    const holder = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const code = await main([], { ...ENV, QCLOUD_API_PORT: String(holder.port) }, sink, { open });
    holder.stop(true);
    expect(code).toBe(1);
    expect(closed).toBe(1);
    expect(lines.err.join('\n')).not.toContain(PASSWORD);
  });
});

describe('drain', () => {
  test('lets a request in flight finish inside the grace period', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async () => {
        await Bun.sleep(150);
        return new Response('done');
      },
    });
    const pending = fetch(`http://127.0.0.1:${server.port}/`).then((r) => r.text());
    await Bun.sleep(30);
    const started = Date.now();
    await drain({ port: server.port ?? 0, url: server.url, stop: (f) => server.stop(f) }, 2_000);
    expect(await pending).toBe('done');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test('closes a stream that never ends once the grace period is over', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(': open\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        ),
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const reader = response.body!.getReader();
    await reader.read();

    const started = Date.now();
    await drain({ port: server.port ?? 0, url: server.url, stop: (f) => server.stop(f) }, 200);
    expect(Date.now() - started).toBeLessThan(3_000);
    // The client sees the end of the stream (or a reset) rather than waiting for ever.
    const ended = await reader.read().then(
      (chunk) => chunk.done,
      () => true
    );
    expect(ended).toBe(true);
  });
});
