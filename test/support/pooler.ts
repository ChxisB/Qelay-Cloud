import { describe } from 'bun:test';
import { SQL } from 'bun';
import { testDatabaseUrl } from './db';

/**
 * PgBouncer 1.26 in transaction mode, in front of the test Postgres (compose profile
 * `pgbouncer`). A stand-in for a managed transaction-mode pooler: Cloud SQL managed connection
 * pooling is PgBouncer-based, RDS Proxy is not (see docs/spikes/05-db-access-and-delay.md).
 *
 * Two instances differ in one setting, `max_prepared_statements`, which is the setting that
 * decides whether Bun.SQL's default (named prepared statements) works at all:
 *   - 56432: 200, protocol-level prepared statements are tracked per client;
 *   - 56433: 0, Cloud SQL's default.
 */
export const POOLER_TRACKING_PREPARED = 56432;
export const POOLER_NOT_TRACKING_PREPARED = 56433;

/** The test database, direct, as the admin user. */
export const DIRECT_URL = testDatabaseUrl();

/** A URL to a pooler instance for a role whose password is its own name. */
export const poolerUrl = (port: number, user = 'qcloud') =>
  `postgres://${user}:${user}@127.0.0.1:${port}/qcloud_test`;

/** The test database, direct, as a role whose password is its own name. */
export function directUrlFor(role: string): string {
  const url = new URL(testDatabaseUrl());
  url.username = role;
  url.password = role;
  return url.toString();
}

/** One client with one connection and no prepared statements: the baseline the tests vary. */
export const open = (url: string, options: SQL.Options = {}) =>
  new SQL(url, { max: 1, connectionTimeout: 5, prepare: false, ...options });

/** The message of what `run` throws, or null if it did not throw. */
export const rejection = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

async function isReachable(port: number): Promise<boolean> {
  const sql = new SQL(poolerUrl(port), { max: 1, connectionTimeout: 2, prepare: false });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close({ timeout: 1 }).catch(() => {});
  }
}

const required = process.env.QCLOUD_REQUIRE_PGBOUNCER === '1';
const reachable =
  required ||
  ((await isReachable(POOLER_TRACKING_PREPARED)) &&
    (await isReachable(POOLER_NOT_TRACKING_PREPARED)));

if (!reachable) {
  console.warn(
    '[test/support/pooler] PgBouncer is not reachable on 127.0.0.1:56432 and :56433: pooler suites ' +
      'are skipped. Start it with `docker compose -f docker-compose.test.yml --profile pgbouncer up ' +
      '-d --wait pgbouncer pgbouncer-noprep`, or set QCLOUD_REQUIRE_PGBOUNCER=1 to fail instead of skip.'
  );
}

/** `describe` for suites that need the poolers. Combine with `describeDb`. */
export const describePooler: typeof describe = reachable ? describe : describe.skip;

/**
 * A login role whose `search_path` is the test schema, set on the role so that every server
 * connection the role gets, direct or pooled, starts with it. This is the pooler-safe way to pick
 * a schema (the other is to qualify names). Call after the schema's tables exist.
 */
export async function createSchemaRole(
  admin: SQL,
  role: string,
  schema: string,
  settings: Readonly<Record<string, string>> = {}
): Promise<void> {
  const exists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  if (exists.length > 0) {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`;
    await admin.unsafe(`DROP OWNED BY ${role}`);
    await admin.unsafe(`DROP ROLE ${role}`);
  }
  await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'`);
  await admin.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await admin.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  await admin.unsafe(`ALTER ROLE ${role} SET search_path = ${schema}`);
  for (const [name, value] of Object.entries(settings)) {
    await admin.unsafe(`ALTER ROLE ${role} SET ${name} = '${value}'`);
  }
}

/** Removes a role made by `createSchemaRole`, ending its sessions first. */
export async function dropRole(admin: SQL, role: string): Promise<void> {
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`;
  await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
}
