import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import type { Database, DatabaseOptions } from '../src/connection/connect';
import { openDatabase } from '../src/connection/connect';
import { outcome } from './fault';

/**
 * TLS and a rotating password, against the Postgres of the `tls` compose profile (port 55433).
 * That server accepts plaintext too, so the same instance proves what each option really does.
 * The certificate is exported by the container to `test/support/pgbouncer/.tls/server.crt`.
 */
const CERT = `${import.meta.dir}/../../../test/support/pgbouncer/.tls/server.crt`;
const URL_NO_PASSWORD = 'postgres://qcloud@127.0.0.1:55433/qcloud_test';
const URL = 'postgres://qcloud:qcloud@127.0.0.1:55433/qcloud_test';

async function reachable(): Promise<boolean> {
  if (!existsSync(CERT)) return false;
  const sql = new SQL(URL, {
    max: 1,
    connectionTimeout: 2,
    prepare: false,
    tls: { ca: await Bun.file(CERT).text() },
  });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close({ timeout: 1 }).catch(() => {});
  }
}

const required = process.env.QCLOUD_REQUIRE_TLS === '1';
const available = required || (await reachable());
if (!available) {
  console.warn(
    '[connection.tls] The TLS Postgres is not reachable on 127.0.0.1:55433: TLS suites are skipped. ' +
      'Start it with `docker compose -f docker-compose.test.yml --profile tls up -d --wait postgres-tls`, ' +
      'or set QCLOUD_REQUIRE_TLS=1 to fail instead of skip.'
  );
}
const describeTls: typeof describe = available ? describe : describe.skip;

describeTls('connection: TLS', () => {
  let ca: string;
  let otherCa: string;
  let work: string;
  const opened: Database[] = [];

  beforeAll(async () => {
    ca = await Bun.file(CERT).text();
    work = mkdtempSync(join(tmpdir(), 'qcloud-tls-'));
    // An unrelated self-signed certificate: a CA the server's certificate does not chain to.
    const made = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-days',
      '1',
      '-subj',
      '/CN=unrelated',
      '-keyout',
      join(work, 'k.pem'),
      '-out',
      join(work, 'c.pem'),
    ]);
    if (made.exitCode !== 0) throw new Error('openssl is needed to make an unrelated certificate');
    otherCa = await Bun.file(join(work, 'c.pem')).text();
  });
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close({ timeout: 1000 }).catch(() => {});
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const open = (options: Partial<DatabaseOptions> = {}) => {
    const db = openDatabase({
      url: URL,
      poolSize: 1,
      connectTimeoutSeconds: 4,
      operationDeadlineMs: 5_000,
      ...options,
    });
    opened.push(db);
    return db;
  };

  /** Whether the session is encrypted, as the server sees it. */
  const sessionSsl = async (db: Database): Promise<boolean> => {
    const rows = await db.run(
      'ssl',
      (sql) => sql`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`
    );
    return Boolean(rows[0]!.ssl);
  };
  const failure = async (db: Database) => {
    try {
      await db.run('ping', (sql) => sql`SELECT 1`);
      return null;
    } catch (error) {
      const caught = error as { code?: string; message?: string };
      return `${caught.code ?? ''} ${caught.message ?? ''}`.trim();
    }
  };

  test('a loopback host with no tls option is plaintext, even when the server offers TLS', async () => {
    expect(await sessionSsl(open())).toBe(false);
  });

  test("tls: 'unverified' encrypts without checking the server", async () => {
    expect(await sessionSsl(open({ tls: 'unverified' }))).toBe(true);
  });

  test('tls: { ca } encrypts and verifies, by address and by name', async () => {
    expect(await sessionSsl(open({ tls: { ca } }))).toBe(true);
    expect(
      await sessionSsl(open({ url: URL.replace('127.0.0.1', 'localhost'), tls: { ca } }))
    ).toBe(true);
  });

  test('verification refuses an unrelated CA and a server name the certificate does not carry', async () => {
    expect(await failure(open({ tls: { ca: otherCa } }))).not.toBeNull();
    expect(await failure(open({ tls: { ca, serverName: 'db.invalid.example' } }))).not.toBeNull();
  });

  test('a password function is called for each new connection, so a token can be minted fresh', async () => {
    let calls = 0;
    const db = open({
      url: URL_NO_PASSWORD,
      tls: { ca },
      password: async () => {
        calls++;
        return 'qcloud';
      },
    });
    const admin = open({ tls: { ca } });
    expect(await sessionSsl(db)).toBe(true);
    expect(calls).toBe(1);
    // End the session on the server: the pool reconnects and must ask for a password again.
    await admin.run(
      'terminate',
      (sql) =>
        sql`SELECT pg_terminate_backend(pid) FROM pg_stat_ssl WHERE pid <> pg_backend_pid() AND ssl`
    );
    let recovered = false;
    for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
      recovered = (await failure(db)) === null;
      if (!recovered) await Bun.sleep(100);
    }
    expect(recovered).toBe(true);
    expect(calls).toBe(2);
  });

  test('a rejected password is a server error within the deadline, not a hang', async () => {
    const db = open({
      url: URL_NO_PASSWORD,
      tls: { ca },
      password: async () => 'expired-token',
      operationDeadlineMs: 3_000,
    });
    const result = await outcome(() => db.run('ping', (sql) => sql`SELECT 1`), 5_000);
    expect(result.result).toBe('error');
    expect(await failure(db)).toMatch(/password authentication failed/);
  });
});
