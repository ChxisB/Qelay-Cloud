import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { migrate } from '../src/schema/migrate';
import { LATEST_VERSION, migrationChecksum, MIGRATIONS } from '../src/schema/migrations';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

describeDb('schema migrate: a starter that waited for the lock', () => {
  let fresh: FreshSchema;
  beforeEach(async () => {
    fresh = await freshSchema();
  });
  afterEach(async () => {
    await fresh.drop();
  });

  // `to_regclass` answers from the backend's catalog cache, and a backend that waits for an advisory
  // lock does not process the invalidations the holder's DDL sent unless the queue of them is long
  // (Postgres then signals a catch-up). So the starter read "no migration record" after the holder
  // had created it, and then found `qcloud_jobs`: ten parallel runs of the four-process test failed
  // 36 times in 40 with `SchemaVersionError: "qcloud_jobs" exists but there is no migration record`.
  // The holder here creates two tables only, so the queue stays short and the race is deterministic.
  test('sees what the lock holder migrated meanwhile and applies nothing', async () => {
    const holder = new SQL(testDatabaseUrl(), {
      max: 1,
      prepare: false,
      connection: { search_path: fresh.name },
    });
    const key = `hashtextextended('qcloud:migrate:${fresh.name}', 0)`;
    await holder.unsafe(`SELECT pg_advisory_lock(${key})`);
    let outcome: Promise<unknown>;
    try {
      outcome = migrate(fresh.db).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      await Bun.sleep(300);
      await holder.begin(async (tx) => {
        await tx.unsafe(`CREATE TABLE qcloud_schema_migrations (
          version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL, checksum TEXT NOT NULL)`);
        for (const migration of MIGRATIONS) {
          await tx.unsafe(
            `INSERT INTO qcloud_schema_migrations (version, applied_at, checksum) VALUES ($1, 0, $2)`,
            [migration.version, migrationChecksum(migration)]
          );
        }
        await tx.unsafe(`CREATE TABLE qcloud_jobs (id INTEGER)`);
      });
    } finally {
      await holder.unsafe(`SELECT pg_advisory_unlock(${key})`);
      await holder.close({ timeout: 1 });
    }
    expect(await outcome!).toEqual({
      result: { from: LATEST_VERSION, to: LATEST_VERSION, applied: [] },
    });
  });
});
