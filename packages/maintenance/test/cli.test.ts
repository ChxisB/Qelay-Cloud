import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import { resetTables } from '../../store-postgres/test/finishHelpers';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { enqueueN, openTestStore } from '../../store-postgres/test/storeHelpers';
import type { CliRuntime } from '../src/cli';
import { main, USAGE } from '../src/cli';
import type { RunReport } from '../src/tick';
import { RecordingTransport } from './support';

const PASSWORD = 'hunter2-not-a-real-password';
const DB_URL = `postgres://qcloud:${PASSWORD}@127.0.0.1:1/qcloud`;
const SECRET = 'a-development-secret-of-24+';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) },
  };
}

describe('qcloud-tick: usage and configuration errors', () => {
  test.each([[['bogus']], [['run', 'extra']], [['serve', '--port', '1']], [['--help']]])(
    '%j prints the usage and exits 2',
    async (argv) => {
      const { io, err, out } = capture();
      expect(await main(argv, { QCLOUD_DATABASE_URL: DB_URL }, io)).toBe(2);
      expect(err).toEqual([USAGE]);
      expect(out).toEqual([]);
    }
  );

  test('a missing database URL exits 2 and names the variable', async () => {
    const { io, err } = capture();
    expect(await main(['run'], {}, io)).toBe(2);
    expect(err[0]).toMatch(/UnsupportedOptionError.*QCLOUD_DATABASE_URL/);
    expect(err[1]).toBe(USAGE);
  });

  test('a bad setting exits 2 and names the variable, never the URL or its password', async () => {
    for (const env of [
      { QCLOUD_TRANSPORT: 'sqs' },
      { QCLOUD_TICK_INTERVAL_MS: 'soon' },
      { QCLOUD_TICK_INTERVAL_MS: '1000', QCLOUD_TICK_RE_RING_AFTER_MS: '2000' },
    ]) {
      const { io, err } = capture();
      expect(await main(['run'], { QCLOUD_DATABASE_URL: DB_URL, ...env }, io)).toBe(2);
      expect(err.join('\n')).toMatch(/QCLOUD_|reRingAfterMs/);
      expect(err.join('\n')).not.toContain(PASSWORD);
    }
  });

  test('serve without an audience or a shared secret exits 2 rather than serving an open endpoint', async () => {
    const { io, err } = capture();
    const env = { QCLOUD_DATABASE_URL: DB_URL, QCLOUD_TRANSPORT: 'postgres' };
    expect(await main(['serve'], env, io)).toBe(2);
    expect(err[0]).toMatch(/QCLOUD_TICK_AUDIENCE/);
  });

  test('serve with an audience and no allowed email exits 2', async () => {
    const { io, err } = capture();
    const env = {
      QCLOUD_DATABASE_URL: DB_URL,
      QCLOUD_TICK_AUDIENCE: 'https://tick.example.test/internal/tick',
    };
    expect(await main(['serve'], env, io)).toBe(2);
    expect(err[0]).toMatch(/allowedEmails/);
  });

  test('serve with a short shared secret exits 2, and the secret is not printed', async () => {
    const { io, err } = capture();
    const secret = 'short-secret-value';
    const env = { QCLOUD_DATABASE_URL: DB_URL, QCLOUD_TICK_SHARED_SECRET: secret };
    expect(await main(['serve'], env, io)).toBe(2);
    expect(err.join('\n')).not.toContain(secret);
  });

  test('an unreachable database is exit 1 with one JSON error line, and no password anywhere', async () => {
    const { io, err, out } = capture();
    const code = await main(
      ['run'],
      { QCLOUD_DATABASE_URL: DB_URL, QCLOUD_TRANSPORT: 'postgres' },
      io
    );
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
    expect(JSON.parse(err[0]!)).toMatchObject({ level: 'error', step: 'tick' });
    expect(err.join('\n')).not.toContain(PASSWORD);
  }, 30_000);
});

describeDb('qcloud-tick over a real store', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 3_600_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** A runtime on the test schema whose `close` only counts, so the schema outlives the command. */
  function runtime(transport: RecordingTransport, store: PostgresStore = t.store) {
    const closed = { store: 0, transport: 0 };
    const built: CliRuntime = {
      store: Object.assign(Object.create(store) as PostgresStore, {
        close: async () => void (closed.store += 1),
      }),
      transport: {
        capabilities: transport.capabilities,
        ring: (items) => transport.ring(items),
        close: async () => void (closed.transport += 1),
      },
    };
    return { closed, open: () => built };
  }
  const ENV = { QCLOUD_DATABASE_URL: DB_URL, QCLOUD_TICK_RING_GRACE_MS: '0' };

  test('run: one invocation, one JSON report line, exit 0, and the connections are closed', async () => {
    const [id] = await enqueueN(t.store, 1);
    const transport = new RecordingTransport();
    const { open, closed } = runtime(transport);
    const { io, out, err } = capture();

    expect(await main(['run'], ENV, io, { open })).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, ring: { due: 1, rung: 1 } });
    expect(transport.attempts.map((attempt) => attempt.jobId)).toEqual([id!]);
    expect(closed).toEqual({ store: 1, transport: 1 });
  });

  test('run is the default command', async () => {
    const { io, out } = capture();
    expect(await main([], ENV, io, { open: runtime(new RecordingTransport()).open })).toBe(0);
    expect(out).toHaveLength(1);
  });

  test('run with a broker that is down: the report says so, exit 1, and the exit code is how a job runner notices', async () => {
    await enqueueN(t.store, 3);
    const transport = new RecordingTransport();
    transport.throwNext(5);
    const { open, closed } = runtime(transport);
    const { io, out, err } = capture();

    expect(await main(['run'], ENV, io, { open })).toBe(1);
    expect(JSON.parse(out[0]!) as RunReport).toMatchObject({
      ok: false,
      ring: { due: 3, unreachable: 3 },
    });
    expect(err.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ level: 'error', step: 'ring' })
    );
    expect(closed).toEqual({ store: 1, transport: 1 });
  });

  test('run with a store that fails: exit 1, one JSON error line, connections still closed', async () => {
    const transport = new RecordingTransport();
    const built = runtime(transport);
    const broken = Object.assign(Object.create(built.open().store) as PostgresStore, {
      tick: async () => {
        throw new Error(`connect failed for ${DB_URL}`);
      },
    });
    const { io, out, err } = capture();
    const code = await main(['run'], ENV, io, {
      open: () => ({ store: broken, transport }),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0]!)).toMatchObject({ level: 'error', step: 'tick' });
    // The driver's message named the URL; the line that reached stderr does not.
    expect(err.join('\n')).not.toContain(PASSWORD);
    expect(err.join('\n')).toContain('***');
  });

  describe('serve', () => {
    async function serving(env: Record<string, string>, transport = new RecordingTransport()) {
      const { open, closed } = runtime(transport);
      const { io, err } = capture();
      const stop = new AbortController();
      const done = main(
        ['serve'],
        { ...ENV, PORT: '0', QCLOUD_TICK_HOST: '127.0.0.1', ...env },
        io,
        {
          open,
          stopSignal: stop.signal,
        }
      );
      const deadline = Date.now() + 5_000;
      let port = 0;
      while (port === 0) {
        const line = err
          .map((text) => JSON.parse(text))
          .find((entry) => entry.message === 'serving');
        if (line) port = line.port;
        else if (Date.now() > deadline) throw new Error('the server did not start');
        else await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { port, stop, done, closed, transport, err };
    }

    test('answers an authenticated POST with the report, refuses the rest, and stops on the signal', async () => {
      const [id] = await enqueueN(t.store, 1);
      const server = await serving({ QCLOUD_TICK_SHARED_SECRET: SECRET });
      const url = `http://127.0.0.1:${server.port}/internal/tick`;

      expect((await fetch(url, { method: 'POST' })).status).toBe(401);
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { authorization: 'Bearer nope-nope-nope-nope-nope' },
          })
        ).status
      ).toBe(401);
      expect(server.transport.attempts).toEqual([]);

      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, ring: { rung: 1 } });
      expect(server.transport.attempts.map((attempt) => attempt.jobId)).toEqual([id!]);
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);

      server.stop.abort();
      expect(await server.done).toBe(0);
      expect(server.closed).toEqual({ store: 1, transport: 1 });
      await expect(fetch(url, { method: 'POST' })).rejects.toThrow();
    });

    test('with an audience, a request without a Google token is refused', async () => {
      const server = await serving({
        QCLOUD_TICK_AUDIENCE: 'https://tick.example.test/internal/tick',
        QCLOUD_TICK_ALLOWED_EMAILS: 'scheduler@project.iam.gserviceaccount.com',
      });
      const url = `http://127.0.0.1:${server.port}/internal/tick`;
      const forged = `${btoa('{"alg":"none"}')}.${btoa('{}')}.`;
      expect((await fetch(url, { method: 'POST' })).status).toBe(401);
      expect(
        (await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${forged}` } }))
          .status
      ).toBe(401);
      server.stop.abort();
      expect(await server.done).toBe(0);
    });

    test('a stop signal that fired before the server was up still returns', async () => {
      const { open } = runtime(new RecordingTransport());
      const { io } = capture();
      const stop = new AbortController();
      stop.abort();
      const env = {
        ...ENV,
        PORT: '0',
        QCLOUD_TICK_HOST: '127.0.0.1',
        QCLOUD_TICK_SHARED_SECRET: SECRET,
      };
      expect(await main(['serve'], env, io, { open, stopSignal: stop.signal })).toBe(0);
    });
  });
});
