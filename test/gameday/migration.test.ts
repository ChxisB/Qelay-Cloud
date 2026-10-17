import { expect, test } from 'bun:test';
import {
  LATEST_VERSION,
  MIGRATIONS,
  migrate,
  PostgresStore,
} from '../../packages/store-postgres/src';
import { SchemaDriftError, SchemaVersionError } from '../../packages/store-postgres/src/errors';
import { freshSchema } from '../../packages/store-postgres/test/helpers';
import { MemoryTransport } from '../../packages/transport-local/src';
import { describeDb } from '../support/db';
import { operator } from './support';

/**
 * docs/runbooks/failed-migration.md: a service started before its migration, a shipped migration
 * that was edited, and a database newer than the build. The runbook's own check is `GET /deployment`
 * and `/health/ready`; its fixes are the migrate step and restoring the file.
 */
describeDb('game day: a migration', () => {
  test('behind, drifted and ahead: what /deployment says each time, and that the migrate step settles it', async () => {
    const fresh = await freshSchema({ poolSize: 4 });
    try {
      const store = new PostgresStore({ db: fresh.db, namespace: 'gameday' });
      const api = operator({ store, sql: fresh.sql, transport: new MemoryTransport() });
      const state = async () => (await api.deployment()).schema;

      // A release rolled out before its migration job finished: the previous version is all there is.
      await migrate(fresh.db, { migrations: MIGRATIONS.slice(0, -1) });
      expect(await state()).toMatchObject({
        state: 'behind',
        current: LATEST_VERSION - 1,
        expected: LATEST_VERSION,
      });
      expect(await api.codes()).toContain('schema_behind');
      expect((await api.call('GET', '/health/ready')).status).toBe(503);

      // The migrate job runs: waiting ends by itself, with nothing else done.
      expect((await migrate(fresh.db)).applied).toEqual([LATEST_VERSION]);
      expect(await state()).toMatchObject({ state: 'current' });
      expect(await api.codes()).not.toContain('schema_behind');
      expect((await api.call('GET', '/health/ready')).status).toBe(200);

      // Someone edited a shipped migration: migrate refuses, and restoring the record is the whole fix.
      const [row] = await fresh.sql<
        Array<{ checksum: string }>
      >`SELECT checksum FROM qcloud_schema_migrations WHERE version = 1`;
      await fresh.sql`UPDATE qcloud_schema_migrations SET checksum = 'edited' WHERE version = 1`;
      const drift = await migrate(fresh.db).catch((error) => error);
      expect(drift).toBeInstanceOf(SchemaDriftError);
      expect(drift.message).toMatch(/Migration 1 .* was edited/);
      await fresh.sql`UPDATE qcloud_schema_migrations SET checksum = ${row!.checksum} WHERE version = 1`;
      expect((await migrate(fresh.db)).applied).toEqual([]);

      // An older build ran against a newer database: a warning, still ready, and migrate refuses to touch it.
      await fresh.sql`INSERT INTO qcloud_schema_migrations VALUES (${LATEST_VERSION + 1}, 1, 'from-the-future')`;
      expect(await state()).toMatchObject({ state: 'ahead' });
      expect(await api.codes()).toContain('schema_ahead');
      expect((await api.call('GET', '/health/ready')).status).toBe(200);
      expect(await migrate(fresh.db).catch((error) => error)).toBeInstanceOf(SchemaVersionError);
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});
