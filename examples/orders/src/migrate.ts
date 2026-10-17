/** Brings the database schema to the latest version. Run it before the first producer or worker, and on each release. */
import { migrate } from '../../../packages/store-postgres/src';
import { openRuntime, ordersEnv } from './runtime';

export async function migrateOrders(env = ordersEnv()): Promise<void> {
  const runtime = openRuntime(env);
  try {
    const result = await migrate(runtime.db);
    console.log(
      result.applied.length === 0
        ? `schema already at version ${result.to}`
        : `schema migrated from ${result.from ?? 'empty'} to ${result.to}`
    );
  } finally {
    await runtime.close();
  }
}

if (import.meta.main) await migrateOrders();
