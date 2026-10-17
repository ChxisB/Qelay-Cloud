import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestSchema } from '../../../test/support/db';
import { createTestSchema, describeDb, testDatabaseUrl } from '../../../test/support/db';
import { LATEST_VERSION } from '../../store-postgres/src';
import type { ReadinessResponse, RunningServer } from '../src';
import { main } from '../src';

const TOKEN = 'dev-token-0123456789-abcdefghij';

/** The environment of a process aimed at one isolated test schema, over the real database. */
const envFor = (schema: TestSchema): Record<string, string> => ({
  QCLOUD_DATABASE_URL: testDatabaseUrl(),
  QCLOUD_DATABASE_SCHEMA: schema.name,
  QCLOUD_NAMESPACE: 'runtime-test',
  QCLOUD_TRANSPORT: 'postgres',
  QCLOUD_API_DEV_TOKEN: TOKEN,
  QCLOUD_API_PORT: '0',
});

function sink() {
  const lines = { out: [] as string[], err: [] as string[] };
  return {
    lines,
    io: { out: (l: string) => lines.out.push(l), err: (l: string) => lines.err.push(l) },
  };
}

/** Serves from the real runtime (no fake `open`) until the returned `stop()` is called. */
async function serve(env: Record<string, string>) {
  const stop = new AbortController();
  const { io } = sink();
  let server!: RunningServer;
  let code: number | undefined;
  const listening = new Promise<void>((resolve) => {
    void main([], env, io, {
      stopSignal: stop.signal,
      onListening: (s) => {
        server = s;
        resolve();
      },
    }).then((exit) => {
      code = exit;
    });
  });
  await listening;
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      stop.abort();
      for (let i = 0; i < 200 && code === undefined; i += 1) await Bun.sleep(10);
      return code;
    },
  };
}

const ready = (url: string) =>
  fetch(`${url}/health/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });

describeDb('qcloud-api migrate and the readiness of a database it has not migrated', () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
  });
  afterAll(() => schema.drop());

  test('the service is not ready on an unmigrated database, and is once the release step has run', async () => {
    const env = envFor(schema);
    const app = await serve(env);
    try {
      const before = await ready(app.url);
      expect(before.status).toBe(503);
      const body = (await before.json()) as ReadinessResponse;
      expect(body.checks.schema).toEqual({
        state: 'behind',
        current: 0,
        expected: LATEST_VERSION,
      });
      expect(body.storage?.error).toContain('run the migrations');
      // Liveness is not readiness: the process must not be restarted for waiting on a migration.
      expect((await fetch(`${app.url}/health`)).status).toBe(200);

      const { io, lines } = sink();
      expect(await main(['migrate'], env, io)).toBe(0);
      const result = JSON.parse(lines.out[0]!) as {
        from: number | null;
        to: number;
        applied: number[];
      };
      expect(result.to).toBe(LATEST_VERSION);
      expect(result.applied.at(-1)).toBe(LATEST_VERSION);

      const after = await ready(app.url);
      expect(after.status).toBe(200);
      expect(((await after.json()) as ReadinessResponse).checks.schema).toEqual({
        state: 'current',
        current: LATEST_VERSION,
        expected: LATEST_VERSION,
      });
    } finally {
      expect(await app.stop()).toBe(0);
    }
  });

  test('a second run applies nothing and still exits 0', async () => {
    const { io, lines } = sink();
    expect(await main(['migrate'], envFor(schema), io)).toBe(0);
    expect(JSON.parse(lines.out[0]!)).toMatchObject({
      from: LATEST_VERSION,
      to: LATEST_VERSION,
      applied: [],
    });
  });

  test('a database a newer release has migrated is refused with exit 1, naming the reason', async () => {
    await schema.sql`
      INSERT INTO qcloud_schema_migrations (version, applied_at, checksum)
      VALUES (${LATEST_VERSION + 1}, 0, 'from-a-newer-release')`;
    try {
      const { io, lines } = sink();
      expect(await main(['migrate'], envFor(schema), io)).toBe(1);
      const text = lines.err.join('\n');
      expect(text).toContain('schema_ahead');
      expect(text).not.toContain(testDatabaseUrl());
      expect(lines.out).toEqual([]);
    } finally {
      await schema.sql`DELETE FROM qcloud_schema_migrations WHERE version = ${LATEST_VERSION + 1}`;
    }
  });
});

describe('qcloud-api migrate, configuration', () => {
  test('without a database URL it is exit 2 and writes nothing to stdout', async () => {
    const { io, lines } = sink();
    expect(await main(['migrate'], {}, io)).toBe(2);
    expect(lines.err.join('\n')).toMatch(/"QCLOUD_DATABASE_URL" is required/);
    expect(lines.out).toEqual([]);
  });

  test('it needs no OIDC or token settings: only the database', async () => {
    // Unreachable on purpose: reaching the connection (exit 1) proves the settings were accepted.
    const { io } = sink();
    const code = await main(
      ['migrate'],
      { QCLOUD_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none?connect_timeout=1' },
      io
    );
    expect(code).toBe(1);
  });

  test('extra arguments are a usage error', async () => {
    const { io, lines } = sink();
    expect(await main(['migrate', '--force'], {}, io)).toBe(2);
    expect(lines.err.join('\n')).toMatch(/^usage: qcloud-api/);
  });
});
