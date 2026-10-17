import type { Clock } from '@qelay-cloud/core';
import type { Database, PostgresStore } from '@qelay-cloud/store-postgres';
import type { ReadinessProbes } from './deps';
import type { CheckState } from './types';

/** How long the last observation of the broker is believed, in ms. */
export const REACHABILITY_STALE_MS = 5 * 60_000;

/**
 * Records whether the broker answered the last time a route used it. The Control API holds no
 * connection to the broker just to be asked about it: the routes that ring (an enqueue, a retry) call
 * `record` with what the transport said, and `state` reports `unknown` once the last observation is
 * older than `staleAfterMs` rather than guess.
 */
export class TransportReachability {
  #ok: boolean | null = null;
  #at = 0;

  constructor(
    private readonly clock: Clock,
    private readonly staleAfterMs = REACHABILITY_STALE_MS
  ) {}

  record(ok: boolean): void {
    this.#ok = ok;
    this.#at = this.clock.now();
  }

  state = (): CheckState => {
    if (this.#ok === null || this.clock.now() - this.#at > this.staleAfterMs) return 'unknown';
    return this.#ok ? 'ok' : 'failed';
  };
}

/**
 * The probes over a Postgres store: a trivial query for the database, the tick's own row for the
 * tick. Neither reads a job. `transport` is the reachability the routes keep (see above).
 */
export function postgresReadiness(
  db: Database,
  store: PostgresStore,
  reachability: Pick<TransportReachability, 'state'>
): ReadinessProbes {
  return {
    database: async () => {
      await db.run('readiness', async (sql) => {
        await sql`SELECT 1`;
      });
    },
    transport: reachability.state,
    schemaVersion: () => store.deployment.schemaVersion(),
    tick: async () => {
      try {
        return await store.maintenance.tickStatus();
      } catch {
        return null;
      }
    },
  };
}
