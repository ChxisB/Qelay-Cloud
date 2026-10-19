import { StoreError } from '@qelay-cloud/core';
import type { Clock } from '@qelay-cloud/core';
import { SQL } from 'bun';
import { ConnectionConfigError } from '../errors';
import type { StoreTime } from '../time';
import { createStoreTime } from '../time';
import type { ConnectionOptions, ResolvedConnection } from './options';
import { resolveConnection } from './options';
import { ResilientPool } from './resilient';
import { describeTarget, targetToSqlOptions } from './target';

export interface Database {
  readonly config: ResolvedConnection;
  readonly time: StoreTime;
  /** Pools retired because an operation hit its deadline. */
  readonly retirements: number;
  /**
   * Runs one store operation (a statement or a whole transaction) under the deadline, or throws
   * `OperationDeadlineError`, which means the outcome is unknown, or refuses it with
   * `StoreOverloadedError` when the process already has `maxInFlight` operations going.
   */
  run<T>(operation: string, work: (sql: SQL) => Promise<T>, deadlineMs?: number): Promise<T>;
  /**
   * A dedicated connection for `LISTEN`, on the direct target. The caller owns it and closes it.
   * Throws when the connection is pooled and no `listenUrl` was given, because `LISTEN` through a
   * transaction pooler subscribes and never receives.
   */
  openListener(): SQL;
  /** `timeout` is in milliseconds, like the `StateStore.close` it backs. */
  close(options?: { readonly timeout?: number }): Promise<void>;
}

export interface DatabaseOptions extends ConnectionOptions {
  /** Time source for the store. Default: the database's own clock. */
  readonly clock?: Clock;
}

/** Validates the options (nothing connects until the first operation) and builds the pool. */
export function openDatabase(options: DatabaseOptions): Database {
  const config = resolveConnection(options);
  const time = createStoreTime(options.clock);
  const pool = new ResilientPool({
    open: () => new SQL(driverOptions(config, config.poolSize)),
    deadlineMs: config.operationDeadlineMs,
    maxInFlight: config.maxInFlight,
    closeTimeoutSeconds: config.closeTimeoutSeconds,
  });
  return {
    config,
    time,
    get retirements() {
      return pool.retirements;
    },
    run: (operation, work, deadlineMs) => pool.run(operation, work, deadlineMs),
    openListener() {
      if (!config.listenTarget) {
        throw new ConnectionConfigError(
          `LISTEN needs a direct connection, and this one goes through a ${config.pooler} pooler ` +
            `(${describeTarget(config.target)}). Give the connection a listenUrl.`
        );
      }
      return new SQL(driverOptions(config, 1, config.listenTarget));
    },
    close: async (closeOptions) => {
      const timeoutSeconds =
        closeOptions?.timeout === undefined ? undefined : Math.max(0, closeOptions.timeout / 1000);
      try {
        await pool.close(timeoutSeconds);
      } catch (error) {
        throw new StoreError('Closing the database pool failed', { cause: error });
      }
    },
  };
}

function driverOptions(
  config: ResolvedConnection,
  max: number,
  target = config.target
): SQL.Options {
  return {
    ...targetToSqlOptions(target),
    max,
    connectionTimeout: config.connectTimeoutSeconds,
    maxLifetime: config.maxLifetimeSeconds,
    idleTimeout: config.idleTimeoutSeconds,
    // Behind a pooler: no named prepared statements.
    prepare: target === config.target ? config.prepare : false,
    connection: { ...config.startupParameters },
  } as SQL.Options;
}
