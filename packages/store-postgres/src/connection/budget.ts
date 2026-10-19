import { ConnectionBudgetError } from '../errors';

/**
 * The connection budget: how many Postgres connections a deployment needs, as a function of how
 * many processes it runs. Measured in docs/spikes/05-db-access-and-delay.md; `bun run
 * scripts/connection-budget.ts` prints the table from this file, so the write-up cannot drift.
 *
 * The one fact the formula rests on: **the SDK holds a connection only for the length of one
 * statement or one short transaction, never while user code runs.** A worker's `concurrency` is
 * therefore not in the formula (test/fleet.test.ts: 50 concurrent jobs, pool of 2, never more than
 * 2 server connections).
 */

/** Per-process connection cap the SDK enforces unless the deployer sets another. */
export const DEFAULT_POOL_SIZE = 2;

/** Postgres `superuser_reserved_connections` (3) plus migration, monitoring and an operator. */
export const RESERVED_CONNECTIONS = 3 + 3;

/** Processes of the Control API and the maintenance tick, when the deployer does not say. */
export const DEFAULT_CONTROL_PROCESSES = 3;

/** Server connections a pooler may open per database-and-user pair, when the deployer does not say. */
export const DEFAULT_POOLER_POOL_SIZE = 20;

export interface ProcessKind {
  readonly name: string;
  /** Pool size: connections for claim, heartbeat, settle and event writes. */
  readonly pool: number;
  /** Dedicated LISTEN connection (the local transport's), which cannot go through a transaction pooler. */
  readonly listen: number;
  readonly count: number;
}

export interface Budget {
  readonly workers: number;
  /** Connections the application processes can open at once. */
  readonly application: number;
  /** Held back for the database itself: superuser reserve, migrations, monitoring, a console. */
  readonly reserved: number;
  /** `max_connections` needed with no pooler: application + reserved. */
  readonly direct: number;
  /** Server connections needed behind a transaction pooler of `poolerPoolSize`. */
  readonly pooled: number;
  readonly kinds: readonly ProcessKind[];
}

export interface BudgetInput {
  readonly workers: number;
  readonly poolSize?: number;
  /** Processes that hold a LISTEN connection (the local transport; `QueueEvents` polls and holds none). Default: none. */
  readonly listeners?: number;
  /** Control API and maintenance-tick processes. Default: 2 API + 1 tick. */
  readonly controlProcesses?: number;
  /** Server connections the pooler may open per database-and-user pair. */
  readonly poolerPoolSize?: number;
}

export function budget(input: BudgetInput): Budget {
  const pool = input.poolSize ?? DEFAULT_POOL_SIZE;
  const listeners = input.listeners ?? 0;
  const control = input.controlProcesses ?? DEFAULT_CONTROL_PROCESSES;
  const poolerPool = input.poolerPoolSize ?? DEFAULT_POOLER_POOL_SIZE;
  const kinds: ProcessKind[] = [
    { name: 'worker', pool, listen: 0, count: input.workers },
    { name: 'events', pool: 0, listen: 1, count: listeners },
    { name: 'control', pool, listen: 0, count: control },
  ];
  const application = kinds.reduce((sum, k) => sum + k.count * (k.pool + k.listen), 0);
  // Behind a pooler the processes share `poolerPoolSize` server connections; LISTEN connections
  // bypass it and go straight to the database.
  const pooled = poolerPool + listeners + RESERVED_CONNECTIONS;
  return {
    workers: input.workers,
    application,
    reserved: RESERVED_CONNECTIONS,
    direct: application + RESERVED_CONNECTIONS,
    pooled,
    kinds,
  };
}

/**
 * The `CONNECTION LIMIT` for the database role the workers log in as: the share of the budget that
 * the worker fleet may take (the workers' pools and their LISTEN connections; behind a pooler, the
 * pooler's server pool and the LISTEN connections). A scale-out mistake (a wrong autoscaler setting,
 * a manual scale, a raised desired count) then fails the extra workers with `53300` instead of using
 * the connections the Control API and the tick need. It only protects them if they log in as another
 * role.
 */
export function workerRoleLimit(result: Budget, pooled = false): number {
  if (pooled) return result.pooled - result.reserved;
  return result.kinds
    .filter((kind) => kind.name !== 'control')
    .reduce((sum, kind) => sum + kind.count * (kind.pool + kind.listen), 0);
}

/** The one statement that sets it; run it as an administrator, once, when the role is created. */
export function workerRoleLimitSql(role: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`A connection limit is a whole number from 1, not ${limit}.`);
  }
  return `ALTER ROLE "${role.replaceAll('"', '""')}" CONNECTION LIMIT ${limit}`;
}

export interface BudgetCheck extends BudgetInput {
  /** The database's `max_connections`. */
  readonly maxConnections: number;
  /** Whether the fleet connects through a transaction pooler. Default: no. */
  readonly pooler?: boolean;
}

/**
 * Refuses a fleet that needs more connections than the database allows. At the cap Postgres
 * answers `53300` and workers fail at random, so the check belongs where the fleet is configured,
 * not where it falls over.
 */
export function assertWithinBudget(input: BudgetCheck): Budget {
  const result = budget(input);
  const needed = input.pooler ? result.pooled : result.direct;
  if (needed <= input.maxConnections) return result;
  const parts = result.kinds
    .filter((kind) => kind.count > 0)
    .map((kind) => `${kind.count} ${kind.name} x ${kind.pool + kind.listen}`);
  const how = input.pooler
    ? `${input.poolerPoolSize ?? DEFAULT_POOLER_POOL_SIZE} pooler connections + ${input.listeners ?? 0} listeners`
    : parts.join(' + ');
  throw new ConnectionBudgetError(
    `The fleet needs ${needed} database connections (${how} + ${result.reserved} reserved) ` +
      `but max_connections is ${input.maxConnections}. Lower the pool size or the process count, ` +
      'raise max_connections, or put a transaction pooler in front of the database.'
  );
}

/** Cloud SQL for PostgreSQL default `max_connections` by instance memory (GB), from the flags page. */
export const CLOUD_SQL_DEFAULTS: ReadonlyArray<{ memoryGb: string; maxConnections: number }> = [
  { memoryGb: '0.6 (shared core)', maxConnections: 25 },
  { memoryGb: '1.7 (shared core)', maxConnections: 50 },
  { memoryGb: '3.75 to < 6', maxConnections: 100 },
  { memoryGb: '6 to < 7.5', maxConnections: 200 },
  { memoryGb: '7.5 to < 15', maxConnections: 400 },
  { memoryGb: '15 to < 30', maxConnections: 500 },
  { memoryGb: '30 to < 60', maxConnections: 600 },
  { memoryGb: '60 to < 120', maxConnections: 800 },
  { memoryGb: '>= 120', maxConnections: 1000 },
];

/** RDS for PostgreSQL: LEAST(DBInstanceClassMemory / 9531392, 5000). An upper bound: the memory
 *  RDS reports is below the nominal size. */
export function rdsMaxConnections(nominalGiB: number): number {
  return Math.min(Math.floor((nominalGiB * 1024 ** 3) / 9_531_392), 5000);
}
