import { openDatabase } from '../src/connection/connect';
import { migrate } from '../src/schema/migrate';

/**
 * A process that migrates one schema and prints the result as JSON. `schema.migrate.test.ts` starts
 * several at once to prove that concurrent starters leave one consistent schema. The connection
 * string comes from QCLOUD_TEST_DATABASE_URL (env, not argv).
 */
const url = process.env.QCLOUD_TEST_DATABASE_URL;
const schema = process.argv[2];
if (!url || !schema) {
  console.error('QCLOUD_TEST_DATABASE_URL and a schema name argument are required');
  process.exit(2);
}
const db = openDatabase({ url, schema });
try {
  console.log(JSON.stringify(await migrate(db)));
} finally {
  await db.close({ timeout: 2000 });
}
