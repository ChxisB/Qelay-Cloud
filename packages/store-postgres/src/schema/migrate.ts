import type { TransactionSQL } from 'bun';
import type { Database } from '../connection/connect';
import { MigrationError, SchemaDriftError, SchemaVersionError } from '../errors';
import type { Queryable } from '../time';
import type { Migration } from './migrations';
import { expectedObjects, MIGRATIONS, migrationChecksum } from './migrations';

/** The `NOTIFY` channel that tells listeners a queue changed. */
export const POSTGRES_EVENT_CHANNEL = 'qcloud_jobs_changed';

/** A migration may rebuild an index over a large table, so it gets more than an ordinary operation. */
export const DEFAULT_MIGRATION_DEADLINE_MS = 120_000;

export interface MigrateOptions {
  readonly deadlineMs?: number;
  /** For tests of the runner itself. Defaults to the package's migrations. */
  readonly migrations?: readonly Migration[];
}

export interface MigrationResult {
  /** The version found before this run, or null for an empty database. */
  readonly from: number | null;
  readonly to: number;
  /** Versions applied by this call. Empty when the database was already current. */
  readonly applied: readonly number[];
}

interface Recorded {
  readonly present: boolean;
  readonly checksums: ReadonlyMap<number, string>;
}

/**
 * Brings the database to the latest schema version, or leaves it untouched and throws.
 *
 * - **Current database:** one read, no lock, no write. Every process start takes this path.
 * - **Concurrent starters:** each pending run takes `pg_advisory_xact_lock` (transaction-scoped, so
 *   it is safe behind a transaction pooler) and re-reads the version under it, so the second
 *   starter finds the first one's work and applies nothing.
 * - **Newer database:** refused with `SchemaVersionError`. Old code never runs against a schema it
 *   does not know.
 * - **Edited migration or missing object:** `SchemaDriftError`.
 * - **A migration fails:** the whole migration rolls back (Postgres DDL is transactional).
 */
export async function migrate(
  db: Database,
  options: MigrateOptions = {}
): Promise<MigrationResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]!.version;
  const deadlineMs = options.deadlineMs ?? DEFAULT_MIGRATION_DEADLINE_MS;

  const current = await db.run('migrate:check', async (sql) => {
    const version = checkRecorded(await readRecorded(sql), migrations, latest);
    if (version === latest) await verifyObjects(sql, migrations, latest);
    return version;
  });
  if (current === latest) return { from: latest, to: latest, applied: [] };

  return db.run(
    'migrate:apply',
    (sql) => sql.begin((tx) => applyPending(tx, migrations, latest)),
    deadlineMs
  );
}

async function applyPending(
  tx: TransactionSQL,
  migrations: readonly Migration[],
  latest: number
): Promise<MigrationResult> {
  // A lock per schema, so databases that hold several deployments do not wait on each other.
  await tx.unsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended('qcloud:migrate:' || coalesce(current_schema(), ''), 0))`
  );
  const recorded = await readRecorded(tx);
  const from = checkRecorded(recorded, migrations, latest);
  if (from === latest) return { from, to: latest, applied: [] };

  // A server-wide `statement_timeout` (infra sets 30 s) must not kill an index build. The client's
  // migration deadline is the bound, and `lock_timeout` stays, so a DDL that cannot lock gives up.
  await tx.unsafe(`SELECT set_config('statement_timeout', '0', true)`);
  if (!recorded.present) {
    await refuseForeignTables(tx, migrations, latest);
    await tx.unsafe(`CREATE TABLE qcloud_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL,
      checksum TEXT NOT NULL
    )`);
  }
  const applied: number[] = [];
  for (const migration of migrations.filter((candidate) => candidate.version > (from ?? 0))) {
    await applyOne(tx, migration);
    applied.push(migration.version);
  }
  return { from, to: latest, applied };
}

async function applyOne(tx: TransactionSQL, migration: Migration): Promise<void> {
  for (const [index, statement] of migration.statements.entries()) {
    try {
      await tx.unsafe(statement);
    } catch (error) {
      const first = statement.trimStart().split('\n', 1)[0];
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed at statement ${index + 1} ` +
          `of ${migration.statements.length} (${first}); it was rolled back`,
        migration.version,
        { cause: error }
      );
    }
  }
  // The database's own clock, so a worker's skewed clock never writes the record.
  await tx.unsafe(
    `INSERT INTO qcloud_schema_migrations (version, applied_at, checksum)
     VALUES ($1, floor(extract(epoch from clock_timestamp()) * 1000)::bigint, $2)`,
    [migration.version, migrationChecksum(migration)]
  );
}

async function readRecorded(sql: Queryable): Promise<Recorded> {
  if (!(await relationExists(sql, 'qcloud_schema_migrations'))) {
    return { present: false, checksums: new Map() };
  }
  const rows = await sql.unsafe<Array<{ version: number; checksum: string }>>(
    `SELECT version, checksum FROM qcloud_schema_migrations ORDER BY version`
  );
  return {
    present: true,
    checksums: new Map(rows.map((row) => [Number(row.version), row.checksum])),
  };
}

/** The recorded version (null when empty). Throws if it is newer than the code or disagrees with it. */
function checkRecorded(
  recorded: Recorded,
  migrations: readonly Migration[],
  latest: number
): number | null {
  const versions = [...recorded.checksums.keys()];
  const highest = versions.length ? Math.max(...versions) : null;
  if (highest !== null && highest > latest) {
    throw new SchemaVersionError(
      `The database is at schema version ${highest} and this code supports up to ${latest}. ` +
        'Nothing was changed. Upgrade this code, or run the version that wrote the schema.',
      highest,
      latest
    );
  }
  for (const [version, checksum] of recorded.checksums) {
    const known = migrations.find((migration) => migration.version === version);
    if (!known) {
      throw new SchemaDriftError(
        `The database records migration ${version}, which this code does not have`
      );
    }
    if (migrationChecksum(known) !== checksum) {
      throw new SchemaDriftError(
        `Migration ${version} (${known.name}) was edited after it was applied to this database. ` +
          'Migrations are forward-only: restore the original and add a new migration instead.'
      );
    }
  }
  return highest;
}

/**
 * Whether the current schema has a relation of this name. It reads `pg_class` and not
 * `to_regclass`: that is answered from the backend's catalog name cache, which a backend that waited
 * for the migration lock has not refreshed, so it can still say "absent" for what the lock holder
 * created and committed meanwhile (the starter then mistook the holder's schema for a foreign one).
 */
async function relationExists(sql: Queryable, name: string): Promise<boolean> {
  const [row] = await sql.unsafe<Array<{ found: boolean }>>(
    `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relname = $1 AND n.nspname = current_schema()) AS found`,
    [name]
  );
  return row!.found;
}

/** A database that has qcloud tables but no migration record is not one this code created. */
async function refuseForeignTables(
  tx: TransactionSQL,
  migrations: readonly Migration[],
  latest: number
): Promise<void> {
  const tables = [...expectedObjects(migrations).relations].filter((name) =>
    name.startsWith('qcloud_')
  );
  for (const name of tables) {
    if (await relationExists(tx, name)) {
      throw new SchemaVersionError(
        `"${name}" exists but there is no migration record (qcloud_schema_migrations). This code did ` +
          'not create this schema, and will not change it. Use an empty schema, or restore the record.',
        null,
        latest
      );
    }
  }
}

/** The cheap half of drift detection: every object the migrations create is still there. */
async function verifyObjects(
  sql: Queryable,
  migrations: readonly Migration[],
  version: number
): Promise<void> {
  const expected = expectedObjects(migrations, version);
  const rows = await sql.unsafe<Array<{ kind: string; name: string }>>(
    `SELECT 'relations' AS kind, relname::text AS name FROM pg_class
       WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p', 'i', 'I', 'S')
     UNION ALL
     SELECT 'functions', proname::text FROM pg_proc
       WHERE pronamespace = current_schema()::regnamespace
     UNION ALL
     SELECT 'triggers', trigger.tgname::text FROM pg_trigger AS trigger
       JOIN pg_class AS owner ON owner.oid = trigger.tgrelid
       WHERE owner.relnamespace = current_schema()::regnamespace AND NOT trigger.tgisinternal`
  );
  const present: Record<keyof typeof expected, Set<string>> = {
    relations: new Set(),
    functions: new Set(),
    triggers: new Set(),
  };
  for (const row of rows) present[row.kind as keyof typeof expected].add(row.name);
  const missing: string[] = [];
  for (const kind of ['relations', 'functions', 'triggers'] as const) {
    for (const name of expected[kind]) {
      if (!present[kind].has(name)) missing.push(`${kind.slice(0, -1)} ${name}`);
    }
  }
  if (missing.length) {
    throw new SchemaDriftError(
      `The database is at schema version ${version} but is missing: ${missing.join(', ')}. ` +
        'Something changed the schema outside a migration. Nothing was changed.'
    );
  }
}
