import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { createTestSchema, describeDb, testDatabaseUrl } from './db';
import type { TestSchema } from './db';

describeDb('test database helper', () => {
  let first: TestSchema;
  let second: TestSchema;

  beforeAll(async () => {
    first = await createTestSchema();
    second = await createTestSchema();
  });

  afterAll(async () => {
    await first?.drop();
    await second?.drop();
  });

  test('pins the connection to its own schema', async () => {
    const [row] = await first.sql`SELECT current_schema() AS schema`;
    expect(row.schema).toBe(first.name);
    expect(second.name).not.toBe(first.name);
  });

  test('tables created in one schema are invisible to another', async () => {
    await first.sql`CREATE TABLE widget (id integer PRIMARY KEY)`;
    await first.sql`INSERT INTO widget (id) VALUES (1)`;

    const [own] = await first.sql`SELECT count(*)::int AS n FROM widget`;
    expect(own.n).toBe(1);

    const [other] = await second.sql`SELECT to_regclass('widget') AS found`;
    expect(other.found).toBeNull();
  });

  test('drop removes the schema and is idempotent', async () => {
    const scratch = await createTestSchema();
    await scratch.sql`CREATE TABLE gone (id integer)`;

    await scratch.drop();
    await scratch.drop();

    const probe = new SQL({ url: testDatabaseUrl(), max: 1 });
    try {
      const rows = await probe`SELECT 1 FROM pg_namespace WHERE nspname = ${scratch.name}`;
      expect(rows.length).toBe(0);
    } finally {
      await probe.close();
    }
  });
});
