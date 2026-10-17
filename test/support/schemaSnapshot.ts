import type { SQL } from 'bun';

/**
 * A text description of everything in a schema, read from the Postgres catalog: columns, constraints,
 * indexes, sequences, functions and triggers. It is what a snapshot test compares, so a change to
 * the DDL shows up as a diff of this text.
 *
 * Choices that keep it stable across servers and schema names:
 * - the schema name is replaced by `<schema>` wherever Postgres prints it;
 * - nullability comes from `pg_attribute.attnotnull`, and `pg_constraint` rows of type `n` (which
 *   PostgreSQL 18 stores for every NOT NULL, and 16 does not) are left out;
 * - everything is sorted by name, never by oid.
 */
export async function schemaSnapshot(sql: SQL, schema: string): Promise<string[]> {
  const ns = sql`(SELECT oid FROM pg_namespace WHERE nspname = ${schema})`;
  const lines: string[] = [];

  const columns = await sql<Array<{ table: string; line: string }>>`
    SELECT c.relname::text AS "table",
           format('%s %s%s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                  CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                  CASE WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END,
                  CASE WHEN a.attidentity <> '' THEN ' IDENTITY ' || a.attidentity::text ELSE '' END) AS line
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = ${ns} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`;
  let current = '';
  for (const row of columns) {
    if (row.table !== current) {
      current = row.table;
      lines.push(`TABLE ${row.table}`);
    }
    lines.push(`  ${row.line}`);
  }

  const constraints = await sql<Array<{ line: string }>>`
    SELECT format('CONSTRAINT %s.%s %s', c.relname, k.conname, pg_get_constraintdef(k.oid)) AS line
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE k.connamespace = ${ns} AND k.contype <> 'n' ORDER BY c.relname, k.conname`;
  lines.push(...constraints.map((row) => row.line));

  const indexes = await sql<Array<{ line: string }>>`
    SELECT pg_get_indexdef(i.indexrelid) AS line
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relnamespace = ${ns} ORDER BY c.relname`;
  lines.push(...indexes.map((row) => row.line));

  const sequences = await sql<Array<{ line: string }>>`
    SELECT format('SEQUENCE %s %s start %s min %s max %s increment %s cycle %s cache %s',
                  sequencename, data_type, start_value, min_value, max_value, increment_by, cycle, cache_size) AS line
    FROM pg_sequences WHERE schemaname = ${schema} ORDER BY sequencename`;
  lines.push(...sequences.map((row) => row.line));

  const functions = await sql<Array<{ line: string }>>`
    SELECT format(E'FUNCTION %s(%s) RETURNS %s LANGUAGE %s\\n%s', p.proname,
                  pg_get_function_arguments(p.oid), pg_get_function_result(p.oid), l.lanname, p.prosrc) AS line
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.pronamespace = ${ns} ORDER BY p.proname`;
  lines.push(...functions.flatMap((row) => row.line.split('\n')));

  const triggers = await sql<Array<{ line: string }>>`
    SELECT pg_get_triggerdef(t.oid) AS line
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = ${ns} AND NOT t.tgisinternal ORDER BY t.tgname`;
  lines.push(...triggers.map((row) => row.line));

  const own = new RegExp(`\\b${schema}\\.`, 'g');
  return lines.map((line) => line.replace(own, '').replaceAll(schema, '<schema>'));
}
