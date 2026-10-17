import { ConnectionConfigError } from '../errors';
import type { BudgetInput } from './budget';
import { assertWithinBudget, DEFAULT_POOL_SIZE } from './budget';
import type { ResolvedTarget, TargetOptions } from './target';
import { resolveTarget } from './target';

/**
 * `none`: the store connects to Postgres itself, so it may send session settings as startup
 * parameters. `transaction`: a transaction-mode pooler (PgBouncer, Cloud SQL managed pooling,
 * RDS Proxy) sits in between and shares server connections between clients.
 */
export type PoolerMode = 'none' | 'transaction';

export interface FleetPlan extends Omit<BudgetInput, 'poolSize'> {
  /** The database's `max_connections`. */
  readonly maxConnections: number;
}

export interface ConnectionOptions extends TargetOptions {
  /** Connections this process may hold. Default 2: the SDK holds one only per statement. */
  readonly poolSize?: number;
  readonly pooler?: PoolerMode;
  /** Schema to search. Direct connections only: behind a pooler, `ALTER ROLE ... SET search_path`. */
  readonly schema?: string;
  /** A direct URL for `LISTEN`, which a transaction pooler cannot carry. Needed to listen when pooled. */
  readonly listenUrl?: string;
  /** Upper bound on one store operation (a statement or a whole transaction). Default 10 s. */
  readonly operationDeadlineMs?: number;
  /** Time to open a connection. Default 10 s. */
  readonly connectTimeoutSeconds?: number;
  /** Age after which a connection is replaced; frees one a dead NAT mapping stalled. Default 300 s. */
  readonly maxLifetimeSeconds?: number;
  /** Idle time after which a connection is closed. Keep it under any NAT or proxy idle limit. Default 30 s. */
  readonly idleTimeoutSeconds?: number;
  /** Grace for closing a pool, in seconds. Default 5. */
  readonly closeTimeoutSeconds?: number;
  /** Session timeouts as startup parameters. Direct connections only: a pooler rejects them. */
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly applicationName?: string;
  /** When given, the fleet is checked against `maxConnections` before anything connects. */
  readonly fleet?: FleetPlan;
}

export interface ResolvedConnection {
  readonly target: ResolvedTarget;
  /** The direct target for LISTEN, or null when this connection is pooled and none was given. */
  readonly listenTarget: ResolvedTarget | null;
  readonly poolSize: number;
  readonly pooler: PoolerMode;
  readonly schema: string | null;
  readonly operationDeadlineMs: number;
  readonly connectTimeoutSeconds: number;
  readonly maxLifetimeSeconds: number;
  readonly idleTimeoutSeconds: number;
  readonly closeTimeoutSeconds: number;
  /** Startup parameters for each server connection, empty behind a pooler. */
  readonly startupParameters: Readonly<Record<string, string | number>>;
  /** Behind a pooler named prepared statements break, so they are off. */
  readonly prepare: boolean;
}

const SESSION_SETTINGS = [
  ['statementTimeoutMs', 'statement_timeout'],
  ['lockTimeoutMs', 'lock_timeout'],
  ['idleInTransactionTimeoutMs', 'idle_in_transaction_session_timeout'],
] as const;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Validates the options against each other and fills the defaults. Pure: opens nothing. */
export function resolveConnection(options: ConnectionOptions): ResolvedConnection {
  const pooler = options.pooler ?? 'none';
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new ConnectionConfigError(`poolSize must be a positive integer, not ${poolSize}`);
  }
  const target = resolveTarget(options);
  const startupParameters: Record<string, string | number> = {};

  if (options.schema !== undefined) {
    if (!SCHEMA_NAME.test(options.schema)) {
      throw new ConnectionConfigError(`"${options.schema}" is not a usable schema name`);
    }
    if (pooler !== 'none') {
      throw new ConnectionConfigError(
        'schema cannot be a startup parameter behind a pooler (it is applied unreliably). ' +
          'Set it on the role instead: ALTER ROLE <role> SET search_path = <schema>.'
      );
    }
    startupParameters.search_path = options.schema;
  }
  for (const [option, setting] of SESSION_SETTINGS) {
    const value = options[option];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new ConnectionConfigError(`${option} must be a non-negative integer, not ${value}`);
    }
    if (pooler !== 'none') {
      throw new ConnectionConfigError(
        `${option} cannot be a startup parameter behind a pooler: the pooler rejects ${setting}. ` +
          `Set it on the role instead: ALTER ROLE <role> SET ${setting} = ${value}.`
      );
    }
    startupParameters[setting] = value;
  }
  if (options.applicationName)
    startupParameters.application_name = options.applicationName.slice(0, 63);

  if (pooler === 'none' && options.listenUrl !== undefined) {
    throw new ConnectionConfigError(
      'listenUrl is only for a pooled connection: without a pooler, LISTEN uses the same target'
    );
  }
  const listenTarget =
    pooler === 'none'
      ? target
      : options.listenUrl === undefined
        ? null
        : resolveTarget({ url: options.listenUrl, tls: options.tls });

  if (options.fleet) {
    const { maxConnections, ...plan } = options.fleet;
    assertWithinBudget({ ...plan, poolSize, maxConnections, pooler: pooler !== 'none' });
  }

  return {
    target,
    listenTarget,
    poolSize,
    pooler,
    schema: options.schema ?? null,
    operationDeadlineMs: positive('operationDeadlineMs', options.operationDeadlineMs, 10_000),
    connectTimeoutSeconds: positive('connectTimeoutSeconds', options.connectTimeoutSeconds, 10),
    maxLifetimeSeconds: positive('maxLifetimeSeconds', options.maxLifetimeSeconds, 300),
    idleTimeoutSeconds: positive('idleTimeoutSeconds', options.idleTimeoutSeconds, 30),
    closeTimeoutSeconds: positive('closeTimeoutSeconds', options.closeTimeoutSeconds, 5),
    startupParameters,
    prepare: pooler === 'none',
  };
}

function positive(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConnectionConfigError(`${name} must be a positive number, not ${value}`);
  }
  return value;
}
