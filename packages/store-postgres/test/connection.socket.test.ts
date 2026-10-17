import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { openDatabase } from '../src/connection/connect';
import { migrate } from '../src/schema/migrate';
import { MIGRATIONS } from '../src/schema/migrations';
import { freshSchema } from './helpers';

/**
 * A unix socket, the way Cloud Run gives a Cloud SQL connection:
 * `/cloudsql/<project:region:instance>/.s.PGSQL.5432`. Here a socket file forwards to the test
 * database, in a directory whose name carries colons, which no URL can hold.
 */
type Pipe = { up: Bun.Socket<unknown> | null; pending: Uint8Array[] };

/** A socket path must fit in 104 bytes on macOS, which tmpdir() there may not allow for. */
function shortTempDir(): string {
  const preferred = mkdtempSync(join(tmpdir(), 'qc-'));
  if (join(preferred, 'p:r:i', '.s.PGSQL.5432').length < 100) return preferred;
  rmSync(preferred, { recursive: true, force: true });
  return mkdtempSync('/tmp/qc-');
}

describeDb('connection: unix socket', () => {
  const target = new URL(testDatabaseUrl());
  const credentials = {
    username: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database: target.pathname.slice(1),
  };
  let dir: string;
  let instanceDir: string;
  let socketFile: string;
  let listener: Bun.UnixSocketListener<Pipe> | null = null;

  beforeAll(() => {
    dir = shortTempDir();
    instanceDir = join(dir, 'p:r:i');
    mkdirSync(instanceDir);
    socketFile = join(instanceDir, '.s.PGSQL.5432');
    listener = Bun.listen<Pipe>({
      unix: socketFile,
      socket: {
        open(client) {
          const pipe: Pipe = { up: null, pending: [] };
          client.data = pipe;
          void Bun.connect({
            hostname: target.hostname,
            port: Number(target.port || 5432),
            socket: {
              open(upstream) {
                pipe.up = upstream;
                for (const chunk of pipe.pending.splice(0)) upstream.write(chunk);
              },
              data(_upstream, chunk) {
                client.write(chunk);
              },
              close() {
                client.end();
              },
              error() {
                client.end();
              },
              connectError() {
                client.end();
              },
            },
          });
        },
        data(client, chunk) {
          if (client.data.up) client.data.up.write(chunk);
          else client.data.pending.push(chunk);
        },
        close(client) {
          client.data.up?.end();
        },
        error(client) {
          client.data.up?.end();
        },
      },
    });
  });
  afterAll(() => {
    listener?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('socketPath reaches Postgres, as the directory or as the socket file', async () => {
    for (const socketPath of [instanceDir, socketFile]) {
      const db = openDatabase({ socketPath, ...credentials, poolSize: 1 });
      try {
        const rows = await db.run('who', (sql) => sql`SELECT current_user AS u`);
        expect(rows[0]!.u).toBe(credentials.username);
      } finally {
        await db.close({ timeout: 1000 });
      }
    }
  });

  test('a schema is migrated over the socket', async () => {
    const fresh = await freshSchema();
    const db = openDatabase({ socketPath: instanceDir, ...credentials, schema: fresh.name });
    try {
      expect(await migrate(db)).toMatchObject({
        from: null,
        applied: MIGRATIONS.map((migration) => migration.version),
      });
      const [row] = await fresh.sql`SELECT count(*)::int AS n FROM qcloud_schema_migrations`;
      expect(row!.n).toBe(MIGRATIONS.length);
    } finally {
      await db.close({ timeout: 1000 });
      await fresh.drop();
    }
  });

  test('a libpq-style ?host=/dir url is refused up front, not read as a TCP host', () => {
    const url = `postgres://u:p@localhost:1/d?host=${encodeURIComponent(instanceDir)}`;
    expect(() => openDatabase({ url })).toThrow(/socketPath/);
  });
});
