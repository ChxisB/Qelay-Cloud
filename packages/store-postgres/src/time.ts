import type { Clock } from '@qelay-cloud/core';
import type { SQL, TransactionSQL } from 'bun';

/** Anything a store statement can run on: the pool, a transaction or a reserved connection. */
export type Queryable = SQL | TransactionSQL;

/**
 * The store's source of "now", in epoch milliseconds.
 *
 * **Mechanism.** An operation asks for `now` once, at its start, and passes that number to every
 * statement it runs as a bound parameter. No query text computes the time itself, so the injected
 * `Clock` reaches all of them and one operation sees one instant.
 *
 * - **Default (no clock injected):** the database's own clock, read with one cheap statement.
 *   A worker's clock is never consulted, so skew between workers cannot move a lease deadline.
 * - **Injected `Clock`:** its value is returned without touching the database. Tests and the model
 *   harness drive time this way.
 */
export interface StoreTime {
  /** Whether a `Clock` was injected. False means the database clock is the source of truth. */
  readonly injected: boolean;
  now(sql: Queryable): Promise<number>;
}

const DATABASE_NOW = 'floor(extract(epoch from clock_timestamp()) * 1000)::bigint';

export function createStoreTime(clock?: Clock): StoreTime {
  if (clock) return { injected: true, now: async () => clock.now() };
  return {
    injected: false,
    now: async (sql) => {
      const [row] = await sql.unsafe<Array<{ now: number | string | bigint }>>(
        `SELECT ${DATABASE_NOW} AS now`
      );
      return Number(row!.now);
    },
  };
}
