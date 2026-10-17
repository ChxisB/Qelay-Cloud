import type { SQL } from 'bun';

/**
 * What the Postgres transport needs from its surroundings, as structural types so this package
 * does not import `@qelay-cloud/store-postgres`: its `Database` is a `LocalDatabase` and
 * `PostgresStore.doorbell` is a `QueueSource`.
 */

export interface LocalDatabase {
  /** Runs one statement or transaction on the pool (through a pooler if there is one). */
  run<T>(operation: string, work: (sql: SQL) => Promise<T>, deadlineMs?: number): Promise<T>;
  /**
   * A dedicated connection for `LISTEN` on a direct target, owned by the caller. Throws when there
   * is none to give (the connection is pooled and no `listenUrl` was set): the transport then runs
   * on its poll loop alone.
   */
  openListener(): SQL;
}

export interface QueueSnapshot {
  readonly ready: number;
  readonly delayed: number;
  readonly active: number;
  readonly failed: number;
  readonly oldestReadyAgeMs: number | null;
  readonly observedAt: number;
}

export interface QueueSource {
  /** Whether a claim of the queue could find a job now. Read on every poll. */
  hasClaimable(queue: string): Promise<boolean>;
  snapshot(queue: string): Promise<QueueSnapshot>;
}
