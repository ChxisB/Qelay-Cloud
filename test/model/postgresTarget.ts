import { migrate, openDatabase, PostgresStore } from '../../packages/store-postgres/src/index';
import type { TestSchema } from '../support/db';
import { createTestSchema, testDatabaseUrl } from '../support/db';
import type { StoreFactory } from './store';

/**
 * The real `PostgresStore`, driven by the harness clock. One migrated schema serves every run of
 * the process, and each run gets its own namespace in it, so runs never see each other's jobs and
 * nothing has to be cleaned between them. `closePostgresTarget` drops the schema.
 *
 * The store reads time from the injected `VirtualClock`, not from the database, which is what
 * lets the harness move time (`advanceClock`, delays, lease expiry) without sleeping.
 */
let schema: Promise<TestSchema> | null = null;
let runs = 0;

async function sharedSchema(): Promise<TestSchema> {
  schema ??= (async () => {
    const created = await createTestSchema();
    const setup = openDatabase({ url: testDatabaseUrl(), schema: created.name, poolSize: 1 });
    try {
      await migrate(setup);
    } finally {
      await setup.close({ timeout: 1000 });
    }
    return created;
  })();
  return schema;
}

export const postgresFactory: StoreFactory = async (env) => {
  const { name } = await sharedSchema();
  runs += 1;
  const db = openDatabase({
    url: testDatabaseUrl(),
    schema: name,
    // Four, so the ticks of `concurrentTicks` can each hold a connection at once.
    poolSize: 4,
    applicationName: 'qcloud:model',
    clock: env.clock,
  });
  // The store owns `db`: closing the store closes it.
  return new PostgresStore({
    db,
    namespace: `${env.namespace}-${runs}`,
    ringWindowMs: 0,
    leaseMs: env.lockTtlMs,
  });
};

/** The commands the Postgres store implements: all of them, since task 15 landed the tick and the operator actions. */
export const POSTGRES_COMMANDS = [
  'enqueue',
  'enqueueDelayed',
  'claim',
  'heartbeat',
  'release',
  'complete',
  'completeMany',
  'fail',
  'promote',
  'changePriority',
  'cancel',
  'retryDlq',
  'tick',
  'recover',
  'zombie',
  'advanceClock',
  'expireLease',
  'pause',
  'resume',
  'setRateLimit',
  'setConcurrencyLimit',
  'crash',
  'deliverLate',
  'upsertCron',
  'concurrentTicks',
] as const;

/**
 * With real workers every claim is a worker's, so `crash` (the model forgetting a worker's leases)
 * has no counterpart: the process-kill case is `packages/sdk/test/worker.crash.test.ts`. `completeMany`
 * writes for leases a worker holds, so it is left to the store target.
 */
export const POSTGRES_WORKER_COMMANDS = POSTGRES_COMMANDS.filter(
  (name) => name !== 'crash' && name !== 'completeMany'
);

export async function closePostgresTarget(): Promise<void> {
  const open = schema;
  schema = null;
  runs = 0;
  if (open) await (await open).drop();
}
