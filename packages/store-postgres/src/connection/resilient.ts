import { OperationDeadlineError, StoreError, StoreOverloadedError } from '@qelay-cloud/core';
import type { SQL } from 'bun';

/**
 * Bun.SQL 1.4.2 puts no bound on a connection that goes silent: a query on it never settles,
 * `query.cancel()` does not settle it, and `close()` without a timeout never returns. Packets
 * dropped by a failing-over database or a dead NAT mapping look exactly like that. The statement
 * timeout (server side) cannot help, because the server never sees the statement.
 *
 * `ResilientPool` is the smallest thing that bounds it: every operation runs under a deadline, and
 * a deadline that fires retires the pool (a fresh one serves the next operation) instead of
 * waiting for a connection that will not answer.
 *
 * Callers must treat `OperationDeadlineError` as "outcome unknown", like a lost response. That is
 * safe for the store's writes, which are lease- or version-guarded.
 */
export interface ResilientPoolOptions {
  /** Opens a fresh pool. Called once up front and once per retirement. */
  readonly open: () => SQL;
  /** Upper bound on one operation (one statement, or one whole transaction). */
  readonly deadlineMs: number;
  /**
   * Operations that may be in flight at once (running or waiting for a connection). One more is
   * refused with `StoreOverloadedError`, untouched. Default: no limit.
   */
  readonly maxInFlight?: number;
  /** Grace for `close()` of a retired pool, in seconds. Default 1. */
  readonly closeTimeoutSeconds?: number;
}

export class ResilientPool {
  readonly #options: ResilientPoolOptions;
  #sql: SQL;
  #closed = false;
  #inFlight = 0;
  /** Pools retired because an operation hit its deadline. */
  retirements = 0;
  /** Closes of retired pools still in flight; settles when each has returned. */
  readonly #retiring = new Set<Promise<void>>();

  constructor(options: ResilientPoolOptions) {
    this.#options = options;
    this.#sql = options.open();
  }

  /**
   * Runs `work` against the current pool, or throws `OperationDeadlineError` (outcome unknown) or
   * `StoreOverloadedError` (nothing sent). `operation` names the call in the error.
   */
  async run<T>(
    operation: string,
    work: (sql: SQL) => Promise<T>,
    deadlineMs = this.#options.deadlineMs
  ): Promise<T> {
    if (this.#closed) throw new StoreError(`${operation}: the connection pool is closed`);
    const limit = this.#options.maxInFlight ?? Infinity;
    if (this.#inFlight >= limit) throw new StoreOverloadedError(operation, limit);
    const pool = this.#sql;
    this.#inFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = work(pool);
    // If the deadline wins, the stuck operation may reject later, when its pool is closed.
    running.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new OperationDeadlineError(operation, deadlineMs)),
        deadlineMs
      );
    });
    try {
      return await Promise.race([running, deadline]);
    } catch (error) {
      if (error instanceof OperationDeadlineError) this.#retire(pool);
      throw error;
    } finally {
      this.#inFlight--;
      clearTimeout(timer);
    }
  }

  /** Resolves when every retired pool's close has returned. For tests and shutdown. */
  async settleRetired(): Promise<void> {
    await Promise.all([...this.#retiring]);
  }

  /** `timeoutSeconds` bounds how long the live pool may take to close. Default: the option's grace. */
  async close(timeoutSeconds = this.#options.closeTimeoutSeconds ?? 1): Promise<void> {
    this.#closed = true;
    await this.settleRetired();
    await this.#sql.close({ timeout: timeoutSeconds });
  }

  #retire(stuck: SQL): void {
    // Many operations can hit the deadline together; only the first retires the pool.
    if (this.#sql !== stuck || this.#closed) return;
    this.retirements++;
    this.#sql = this.#options.open();
    const closing = stuck
      .close({ timeout: this.#options.closeTimeoutSeconds ?? 1 })
      .catch(() => {})
      .finally(() => this.#retiring.delete(closing));
    this.#retiring.add(closing);
  }
}
