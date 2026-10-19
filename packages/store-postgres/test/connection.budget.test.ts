import { describe, expect, test } from 'bun:test';
import {
  assertWithinBudget,
  budget,
  CLOUD_SQL_DEFAULTS,
  DEFAULT_POOL_SIZE,
  rdsMaxConnections,
  RESERVED_CONNECTIONS,
  workerRoleLimit,
  workerRoleLimitSql,
} from '../src/connection/budget';
import { ConnectionBudgetError } from '../src/errors';

describe('connection budget', () => {
  test('10, 50 and 200 workers need 32, 112 and 412 direct connections and 26 pooled', () => {
    const rows = [10, 50, 200].map((workers) => {
      const result = budget({ workers });
      return [workers, result.direct, result.pooled];
    });
    expect(rows).toEqual([
      [10, 32, 26],
      [50, 112, 26],
      [200, 412, 26],
    ]);
  });

  test('a worker costs its pool size, whatever its concurrency', () => {
    expect(DEFAULT_POOL_SIZE).toBe(2);
    const base = budget({ workers: 10 });
    expect(budget({ workers: 11 }).direct - base.direct).toBe(DEFAULT_POOL_SIZE);
    expect(
      budget({ workers: 11, poolSize: 5 }).direct - budget({ workers: 10, poolSize: 5 }).direct
    ).toBe(5);
  });

  test('a listener adds one direct connection, and one behind a pooler too', () => {
    const without = budget({ workers: 10 });
    const withListeners = budget({ workers: 10, listeners: 4 });
    expect(withListeners.direct - without.direct).toBe(4);
    expect(withListeners.pooled - without.pooled).toBe(4);
  });

  test('behind a pooler the worker count does not matter, only the pooler pool', () => {
    expect(budget({ workers: 1 }).pooled).toBe(budget({ workers: 1000 }).pooled);
    expect(budget({ workers: 1, poolerPoolSize: 40 }).pooled).toBe(40 + RESERVED_CONNECTIONS);
  });

  test('a fleet within max_connections passes and returns its budget', () => {
    expect(assertWithinBudget({ workers: 10, maxConnections: 32 }).direct).toBe(32);
  });

  test('a fleet over max_connections is refused with the arithmetic and the way out', () => {
    expect(() => assertWithinBudget({ workers: 10, maxConnections: 31 })).toThrow(
      ConnectionBudgetError
    );
    try {
      assertWithinBudget({ workers: 50, maxConnections: 100 });
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('needs 112 database connections');
      expect(message).toContain('50 worker x 2');
      expect(message).toContain('max_connections is 100');
      expect(message).toContain('transaction pooler');
    }
  });

  test('the same fleet passes behind a pooler, and the pooled message names the pooler', () => {
    expect(assertWithinBudget({ workers: 200, maxConnections: 100, pooler: true }).pooled).toBe(26);
    expect(() =>
      assertWithinBudget({ workers: 200, maxConnections: 20, pooler: true, poolerPoolSize: 20 })
    ).toThrow(/20 pooler connections \+ 0 listeners/);
  });

  test('the managed-database tables hold the figures the write-up quotes', () => {
    expect(CLOUD_SQL_DEFAULTS.find((row) => row.memoryGb.startsWith('3.75'))?.maxConnections).toBe(
      100
    );
    expect(rdsMaxConnections(1)).toBe(112);
    expect(rdsMaxConnections(100_000)).toBe(5000);
  });

  test('the worker role may open what the workers and their listeners can, and not the control share', () => {
    const result = budget({ workers: 10, listeners: 4, controlProcesses: 3 });
    expect(workerRoleLimit(result)).toBe(10 * DEFAULT_POOL_SIZE + 4);
    expect(workerRoleLimit(result) + 3 * DEFAULT_POOL_SIZE + RESERVED_CONNECTIONS).toBe(
      result.direct
    );
  });

  test('behind a pooler the worker role may open the pooler pool and the listeners', () => {
    const result = budget({ workers: 200, listeners: 4, poolerPoolSize: 30 });
    expect(workerRoleLimit(result, true)).toBe(30 + 4);
  });

  test('the statement quotes the role and refuses a limit that is not a whole number from 1', () => {
    expect(workerRoleLimitSql('qcloud_worker', 24)).toBe(
      'ALTER ROLE "qcloud_worker" CONNECTION LIMIT 24'
    );
    expect(workerRoleLimitSql('a"b', 1)).toBe('ALTER ROLE "a""b" CONNECTION LIMIT 1');
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => workerRoleLimitSql('w', limit)).toThrow(RangeError);
    }
  });
});
