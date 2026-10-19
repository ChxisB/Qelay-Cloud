import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OperationDeadlineError } from '@qelay-cloud/core';
import { SQL } from 'bun';
import { ManualClock } from '../../../test/support/clock';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { MigrationError, SchemaDriftError, SchemaVersionError } from '../src/errors';
import { migrate } from '../src/schema/migrate';
import type { Migration } from '../src/schema/migrations';
import { LATEST_VERSION, migrationChecksum, MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { catalog, freshSchema } from './helpers';

const APPLIED = MIGRATIONS.map((migration) => migration.version);
const CORE_TABLES = ['qcloud_jobs', 'qcloud_events', 'qcloud_schema_migrations'];

describeDb('schema migrate', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  const registry = () =>
    fresh.sql<Array<{ version: number; applied_at: string; checksum: string }>>`
      SELECT version, applied_at, checksum FROM qcloud_schema_migrations ORDER BY version`;

  test('an empty schema is brought to the latest version, and a second run does nothing', async () => {
    expect(await migrate(fresh.db)).toEqual({ from: null, to: LATEST_VERSION, applied: APPLIED });
    const objects = await catalog(fresh.sql, fresh.name);
    for (const table of CORE_TABLES) expect(objects.relations).toContain(table);
    const [recorded] = await registry();
    expect(recorded!.checksum).toBe(migrationChecksum(MIGRATIONS[0]!));

    expect(await migrate(fresh.db)).toEqual({
      from: LATEST_VERSION,
      to: LATEST_VERSION,
      applied: [],
    });
    expect((await registry())[0]!.applied_at).toBe(recorded!.applied_at);
    expect(await catalog(fresh.sql, fresh.name)).toEqual(objects);
  });

  test('the record carries the database clock, not the worker clock', async () => {
    const skewed = await freshSchema({ clock: new ManualClock(946_684_800_000) });
    try {
      await migrate(skewed.db);
      const [row] = await skewed.sql<Array<{ drift: string }>>`
        SELECT abs(applied_at - floor(extract(epoch from clock_timestamp()) * 1000)) AS drift
        FROM qcloud_schema_migrations`;
      expect(Number(row!.drift)).toBeLessThan(60_000);
    } finally {
      await skewed.drop();
    }
  });

  describe('concurrent starters', () => {
    // A session that holds the migration lock from outside: what another starter looks like.
    const holder = async () => {
      const session = new SQL(testDatabaseUrl(), { max: 1, prepare: false });
      const key = `hashtextextended('qcloud:migrate:${fresh.name}', 0)`;
      await session.unsafe(`SELECT pg_advisory_lock(${key})`);
      return {
        release: async () => {
          await session.unsafe(`SELECT pg_advisory_unlock(${key})`);
          await session.close({ timeout: 1 });
        },
      };
    };

    test('a pending migration waits for the lock holder, then applies once', async () => {
      const lock = await holder();
      let settled = false;
      const running = migrate(fresh.db).finally(() => (settled = true));
      await Bun.sleep(400);
      expect(settled).toBe(false);
      await lock.release();
      expect((await running).applied).toEqual(APPLIED);
    });

    test('a current database is read without the lock, so a stuck migrator cannot block a restart', async () => {
      await migrate(fresh.db);
      const lock = await holder();
      try {
        const started = performance.now();
        expect((await migrate(fresh.db)).applied).toEqual([]);
        expect(performance.now() - started).toBeLessThan(1_000);
      } finally {
        await lock.release();
      }
    });

    test('a starter stuck behind the lock gives up at its deadline instead of hanging', async () => {
      const lock = await holder();
      try {
        const started = performance.now();
        await expect(migrate(fresh.db, { deadlineMs: 500 })).rejects.toBeInstanceOf(
          OperationDeadlineError
        );
        expect(performance.now() - started).toBeLessThan(2_000);
      } finally {
        await lock.release();
      }
      // The deadline means "outcome unknown": the retired pool finishes its transaction once the
      // lock is free, so the next start either applies the migration or finds it applied. Either
      // way the schema ends up whole, once.
      const next = await migrate(fresh.db);
      expect([APPLIED, []]).toContainEqual([...next.applied]);
      expect(await registry()).toHaveLength(APPLIED.length);
      expect((await migrate(fresh.db)).applied).toEqual([]);
    });

    test('four processes migrating one empty schema leave one consistent schema', async () => {
      const run = () =>
        Bun.spawn(['bun', `${import.meta.dir}/migrator.ts`, fresh.name], {
          env: { ...process.env, QCLOUD_TEST_DATABASE_URL: testDatabaseUrl() },
          stdout: 'pipe',
          stderr: 'pipe',
        });
      const processes = Array.from({ length: 4 }, run);
      const outcomes = await Promise.all(
        processes.map(async (child) => ({
          code: await child.exited,
          out: await new Response(child.stdout).text(),
          err: await new Response(child.stderr).text(),
        }))
      );
      for (const outcome of outcomes)
        expect({ code: outcome.code, err: outcome.err }).toEqual({ code: 0, err: '' });
      const results = outcomes.map((outcome) => JSON.parse(outcome.out) as { applied: number[] });
      expect(results.filter((result) => result.applied.length === APPLIED.length)).toHaveLength(1);
      expect(results.filter((result) => result.applied.length === 0)).toHaveLength(3);
      expect(await registry()).toHaveLength(APPLIED.length);
      expect((await migrate(fresh.db)).applied).toEqual([]);
    }, 60_000);
  });

  describe('refusals leave the database as it was', () => {
    const before = async () => JSON.stringify(await catalog(fresh.sql, fresh.name));

    test('a newer schema version is refused', async () => {
      await migrate(fresh.db);
      await fresh.sql`INSERT INTO qcloud_schema_migrations VALUES (${LATEST_VERSION + 1}, 1, 'from-the-future')`;
      const snapshot = await before();
      const error = await migrate(fresh.db).catch((caught) => caught);
      expect(error).toBeInstanceOf(SchemaVersionError);
      expect(error).toMatchObject({
        databaseVersion: LATEST_VERSION + 1,
        codeVersion: LATEST_VERSION,
      });
      expect(error.message).toMatch(/Nothing was changed/);
      expect(await before()).toBe(snapshot);
      expect(await registry()).toHaveLength(APPLIED.length + 1);
    });

    test('an edited migration is drift', async () => {
      await migrate(fresh.db);
      await fresh.sql`UPDATE qcloud_schema_migrations SET checksum = 'edited' WHERE version = 1`;
      const error = await migrate(fresh.db).catch((caught) => caught);
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect(error.message).toMatch(/Migration 1 \(initial schema\) was edited/);
    });

    test('a recorded version the code does not have is drift', async () => {
      const gap: Migration[] = [
        { version: 1, name: 'one', statements: ['CREATE TABLE qcloud_gap_a (id int)'] },
        { version: 3, name: 'three', statements: ['CREATE TABLE qcloud_gap_c (id int)'] },
      ];
      await migrate(fresh.db, { migrations: gap });
      await fresh.sql`INSERT INTO qcloud_schema_migrations VALUES (2, 1, 'x')`;
      await expect(migrate(fresh.db, { migrations: gap })).rejects.toThrow(/does not have/);
    });

    test.each([
      ['an index', 'DROP INDEX qcloud_jobs_ring_idx', 'relation qcloud_jobs_ring_idx'],
      ['a table', 'DROP TABLE qcloud_metric_totals', 'relation qcloud_metric_totals'],
      [
        'a trigger',
        'DROP TRIGGER qcloud_assign_event_commit ON qcloud_event_commits',
        'trigger qcloud_assign_event_commit',
      ],
      [
        'a function',
        'DROP FUNCTION qcloud_track_event_insertions CASCADE',
        'function qcloud_track_event_insertions',
      ],
    ])('%s that went missing is drift', async (_label, ddl, named) => {
      await migrate(fresh.db);
      await fresh.sql.unsafe(ddl);
      const error = await migrate(fresh.db).catch((caught) => caught);
      expect(error).toBeInstanceOf(SchemaDriftError);
      expect(error.message).toContain(named);
    });

    test('tables with no migration record are not ours to change', async () => {
      await fresh.sql`CREATE TABLE qcloud_jobs (id integer)`;
      const error = await migrate(fresh.db).catch((caught) => caught);
      expect(error).toBeInstanceOf(SchemaVersionError);
      expect(error).toMatchObject({ databaseVersion: null });
      expect(error.message).toMatch(/"qcloud_jobs" exists but there is no migration record/);
      const [row] = await fresh.sql`SELECT to_regclass('qcloud_schema_migrations') AS found`;
      expect(row!.found).toBeNull();
      expect((await catalog(fresh.sql, fresh.name)).relations).toEqual(['qcloud_jobs']);
    });
  });

  describe('applying migrations', () => {
    const one: Migration = {
      version: 1,
      name: 'first',
      statements: ['CREATE TABLE qcloud_a (id integer PRIMARY KEY, note text)'],
    };
    const two = (statements: string[]): Migration => ({ version: 2, name: 'second', statements });

    test('a later migration runs alone, and what the earlier ones stored is kept', async () => {
      await migrate(fresh.db, { migrations: [one] });
      await fresh.sql`INSERT INTO qcloud_a VALUES (1, 'kept')`;
      const result = await migrate(fresh.db, {
        migrations: [one, two(['ALTER TABLE qcloud_a ADD COLUMN extra integer'])],
      });
      expect(result).toEqual({ from: 1, to: 2, applied: [2] });
      const rows = await fresh.sql<Array<{ note: string; extra: number | null }>>`
        SELECT note, extra FROM qcloud_a`;
      expect([...rows]).toEqual([{ note: 'kept', extra: null }]);
    });

    test('a server statement_timeout does not stop a slow migration', async () => {
      const strict = await freshSchema({ statementTimeoutMs: 100 });
      try {
        const slow = { ...one, statements: [...one.statements, 'SELECT pg_sleep(0.4)'] };
        expect((await migrate(strict.db, { migrations: [slow] })).applied).toEqual([1]);
      } finally {
        await strict.drop();
      }
    });

    test('a statement that fails rolls the whole migration back and names the statement', async () => {
      await migrate(fresh.db, { migrations: [one] });
      const bad = two(['CREATE TABLE qcloud_b (id integer)', 'THIS IS NOT SQL']);
      const error = await migrate(fresh.db, { migrations: [one, bad] }).catch((caught) => caught);
      expect(error).toBeInstanceOf(MigrationError);
      expect(error).toMatchObject({ version: 2 });
      expect(error.message).toMatch(/Migration 2 \(second\) failed at statement 2 of 2/);
      expect(error.cause).toBeDefined();
      const objects = await catalog(fresh.sql, fresh.name);
      expect(objects.relations).not.toContain('qcloud_b');
      expect((await registry()).map((row) => row.version)).toEqual([1]);
    });

    test('a failure on an empty database leaves nothing behind, not even the record table', async () => {
      const bad: Migration = {
        version: 1,
        name: 'bad',
        statements: [...one.statements, 'SELECT nope()'],
      };
      await expect(migrate(fresh.db, { migrations: [bad] })).rejects.toBeInstanceOf(MigrationError);
      expect((await catalog(fresh.sql, fresh.name)).relations).toEqual([]);
    });
  });

  test('nothing in the database is named after the broker', async () => {
    await migrate(fresh.db);
    const rows = await fresh.sql<Array<{ name: string }>>`
      SELECT c.relname::text AS name FROM pg_class c
        WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name})
      UNION ALL SELECT a.attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name}) AND a.attnum > 0
      UNION ALL SELECT p.proname::text FROM pg_proc p
        WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name})
      UNION ALL SELECT t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${fresh.name})`;
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((row) => /broker/i.test(row.name))).toEqual([]);
    expect(rows.filter((row) => row.name.startsWith('qelay_'))).toEqual([]);
  });
});
