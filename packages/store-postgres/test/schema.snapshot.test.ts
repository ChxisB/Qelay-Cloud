import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { describeDb } from '../../../test/support/db';
import { schemaSnapshot } from '../../../test/support/schemaSnapshot';
import { migrate } from '../src/schema/migrate';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

const SNAPSHOT = `${import.meta.dir}/schema.snapshot.txt`;

/**
 * The schema the migrations produce, as the catalog describes it. A change to a migration or a new
 * migration shows up here as a diff to review. Regenerate on purpose with
 * `QCLOUD_UPDATE_SNAPSHOT=1 bun test packages/store-postgres/test/schema.snapshot.test.ts`.
 */
describeDb('schema snapshot', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
    await migrate(fresh.db);
  });
  afterAll(async () => {
    await fresh?.drop();
  });

  test('the migrated schema matches the committed snapshot', async () => {
    const actual = await schemaSnapshot(fresh.sql, fresh.name);
    if (process.env.QCLOUD_UPDATE_SNAPSHOT === '1') {
      await Bun.write(SNAPSHOT, `${actual.join('\n')}\n`);
    }
    if (!existsSync(SNAPSHOT)) {
      throw new Error(`No snapshot at ${SNAPSHOT}. Create it with QCLOUD_UPDATE_SNAPSHOT=1.`);
    }
    const expected = (await Bun.file(SNAPSHOT).text()).trimEnd().split('\n');
    expect(actual).toEqual(expected);
  });

  test('the snapshot does not depend on the schema name', async () => {
    const other = await freshSchema();
    try {
      await migrate(other.db);
      expect(await schemaSnapshot(other.sql, other.name)).toEqual(
        await schemaSnapshot(fresh.sql, fresh.name)
      );
    } finally {
      await other.drop();
    }
  });

  test('the snapshot names no broker, no qelay_ object and nothing outside the qcloud_ prefix', async () => {
    const lines = await schemaSnapshot(fresh.sql, fresh.name);
    const text = lines.join('\n');
    expect(text).not.toMatch(/broker/i);
    expect(text).not.toMatch(/\bqelay_/);
    for (const line of lines.filter((candidate) => candidate.startsWith('TABLE '))) {
      expect(line).toMatch(/^TABLE qcloud_/);
    }
    for (const line of lines.filter((candidate) => candidate.startsWith('SEQUENCE '))) {
      expect(line).toMatch(/^SEQUENCE qcloud_/);
    }
  });
});
