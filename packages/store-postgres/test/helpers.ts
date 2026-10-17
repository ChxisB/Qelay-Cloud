import type { SQL } from 'bun';
import { createTestSchema, testDatabaseUrl } from '../../../test/support/db';
import type { Database, DatabaseOptions } from '../src/connection/connect';
import { openDatabase } from '../src/connection/connect';

export interface FreshSchema {
  readonly name: string;
  /** The store's own connection, pinned to the schema by a `search_path` startup parameter. */
  readonly db: Database;
  /** A second pool on the same schema, for arranging and inspecting state behind the store's back. */
  readonly sql: SQL;
  drop(): Promise<void>;
}

/** An empty schema with a `Database` opened on it. Nothing is migrated. */
export async function freshSchema(options: Partial<DatabaseOptions> = {}): Promise<FreshSchema> {
  const schema = await createTestSchema();
  const db = openDatabase({
    url: testDatabaseUrl(),
    schema: schema.name,
    poolSize: 4,
    applicationName: 'qcloud:test',
    ...options,
  });
  return {
    name: schema.name,
    db,
    sql: schema.sql,
    async drop() {
      await db.close({ timeout: 1000 }).catch(() => {});
      await schema.drop();
    },
  };
}

export interface Catalog {
  readonly relations: string[];
  readonly functions: string[];
  readonly triggers: string[];
}

/** Every relation, function and non-internal trigger in the schema, sorted. */
export async function catalog(sql: SQL, schema: string): Promise<Catalog> {
  const rows = await sql<Array<{ kind: string; name: string }>>`
    SELECT 'relations' AS kind, c.relname::text AS name FROM pg_class c
      WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${schema})
        AND c.relkind IN ('r', 'p', 'i', 'I', 'S')
    UNION ALL
    SELECT 'functions', p.proname::text FROM pg_proc p
      WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${schema})
    UNION ALL
    SELECT 'triggers', t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${schema})
        AND NOT t.tgisinternal`;
  const pick = (kind: string) =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => row.name)
      .sort();
  return { relations: pick('relations'), functions: pick('functions'), triggers: pick('triggers') };
}
