import type { Clock, JobOptions } from '@qelay-cloud/core';
import { ManualClock } from '../../../test/support/clock';
import type { PostgresStoreOptions } from '../src/postgresStore';
import { PostgresStore } from '../src/postgresStore';
import { migrate } from '../src/schema/migrate';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

export const START = 1_800_000_000_000;

export interface TestStore {
  readonly store: PostgresStore;
  readonly fresh: FreshSchema;
  readonly clock: ManualClock;
  /** Opens a second store on the same schema and namespace, for races between callers. */
  another(options?: Partial<PostgresStoreOptions>): PostgresStore;
  drop(): Promise<void>;
}

/**
 * A migrated schema with a `PostgresStore` on it, driven by a manual clock. Pass `clock: null` to
 * use the database clock.
 */
export async function openTestStore(
  options: Partial<PostgresStoreOptions> & { clock?: Clock | null; poolSize?: number } = {}
): Promise<TestStore> {
  const { clock: given, poolSize, ...storeOptions } = options;
  const clock = given === undefined ? new ManualClock(START) : given;
  const fresh = await freshSchema({ ...(clock && { clock }), ...(poolSize && { poolSize }) });
  await migrate(fresh.db);
  const make = (extra: Partial<PostgresStoreOptions> = {}) =>
    new PostgresStore({ db: fresh.db, namespace: 'test', ...storeOptions, ...extra });
  return {
    store: make(),
    fresh,
    clock: clock as ManualClock,
    another: make,
    drop: () => fresh.drop(),
  };
}

/** Puts the manual clock back at `START`, so a test that failed before it undid its own advance cannot skew the next. */
export function rewind(t: Pick<TestStore, 'clock'>): void {
  t.clock.advance(START - t.clock.now());
}

/** Enqueues `count` jobs, `data` being their position, and returns their ids in that order. */
export async function enqueueN(
  store: Pick<PostgresStore, 'enqueue'>,
  count: number,
  options: JobOptions = {},
  queue = 'q'
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < count; from += 1000) {
    const size = Math.min(1000, count - from);
    const batch = await store.enqueue(
      Array.from({ length: size }, (_, offset) => ({ queue, data: from + offset, options }))
    );
    ids.push(...batch.map((job) => job.id));
  }
  return ids;
}
