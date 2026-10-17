import { describe } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { SQL } from 'bun';

/**
 * Test database helper. Every test file that needs Postgres creates its own schema, so files
 * can run in parallel against one database without seeing each other's tables.
 *
 * `QCLOUD_TEST_DATABASE_URL` overrides the default, which points at docker-compose.test.yml.
 * If the database is unreachable, `describeDb` skips its suite with a warning, unless
 * `QCLOUD_REQUIRE_DB=1` (CI, and any task that touches the store), in which case it fails.
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://qcloud:qcloud@127.0.0.1:55432/qcloud_test';

const SCHEMA_NAME = /^qcloud_t_[0-9a-f]{16}$/;

export interface TestSchema {
  readonly name: string;
  /** Connection pinned to the schema: unqualified table names resolve inside it. */
  readonly sql: SQL;
  /** Drops the schema and closes the connection. Safe to call more than once. */
  drop(): Promise<void>;
}

export function testDatabaseUrl(): string {
  return process.env.QCLOUD_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export async function isDatabaseReachable(): Promise<boolean> {
  const sql = new SQL({ url: testDatabaseUrl(), max: 1, connectionTimeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}

export async function createTestSchema(): Promise<TestSchema> {
  const url = testDatabaseUrl();
  const name = `qcloud_t_${randomBytes(8).toString('hex')}`;
  if (!SCHEMA_NAME.test(name)) throw new Error(`Unexpected test schema name: ${name}`);

  const admin = new SQL({ url, max: 1, connectionTimeout: 5 });
  try {
    await admin.unsafe(`CREATE SCHEMA ${name}`);
  } catch (error) {
    await admin.close().catch(() => {});
    throw new Error(
      `Cannot create a test schema at ${redact(url)}. Start the test database with ` +
        `\`docker compose -f docker-compose.test.yml up -d --wait\` or set ` +
        `QCLOUD_TEST_DATABASE_URL. Cause: ${error instanceof Error ? error.message : error}`
    );
  }

  const sql = new SQL({ url, max: 4, connection: { search_path: name } });
  let dropped = false;
  return {
    name,
    sql,
    async drop() {
      if (dropped) return;
      dropped = true;
      await sql.close().catch(() => {});
      try {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      } finally {
        await admin.close().catch(() => {});
      }
    },
  };
}

const requireDb = process.env.QCLOUD_REQUIRE_DB === '1';
const reachable = requireDb || (await isDatabaseReachable());

if (!reachable) {
  console.warn(
    `[test/support/db] Postgres not reachable at ${redact(testDatabaseUrl())}: database suites ` +
      'are skipped. Run `docker compose -f docker-compose.test.yml up -d --wait`, or set ' +
      'QCLOUD_REQUIRE_DB=1 to fail instead of skip.'
  );
}

/** `describe` for suites that need Postgres. See the file comment for skip/fail behaviour. */
export const describeDb: typeof describe = reachable ? describe : describe.skip;

function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}
