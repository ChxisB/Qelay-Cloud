import { describe, expect, test } from 'bun:test';
import { resolveConnection } from '../src/connection/options';
import { ConnectionBudgetError, ConnectionConfigError } from '../src/errors';

const url = 'postgres://u:p@127.0.0.1:5432/d';
const message = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectionConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a ConnectionConfigError');
};

describe('connection options', () => {
  test('defaults: a pool of 2, direct, prepared statements on, no startup parameters', () => {
    const config = resolveConnection({ url });
    expect(config).toMatchObject({
      poolSize: 2,
      pooler: 'none',
      prepare: true,
      schema: null,
      operationDeadlineMs: 10_000,
      connectTimeoutSeconds: 10,
      maxLifetimeSeconds: 300,
      idleTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      startupParameters: {},
    });
    expect(config.listenTarget).toBe(config.target);
  });

  test('direct: schema and session timeouts become startup parameters', () => {
    const config = resolveConnection({
      url,
      schema: 'qcloud_prod',
      statementTimeoutMs: 8_000,
      lockTimeoutMs: 2_000,
      idleInTransactionTimeoutMs: 15_000,
      applicationName: 'qcloud:worker-1',
    });
    expect(config.startupParameters).toEqual({
      search_path: 'qcloud_prod',
      statement_timeout: 8_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 15_000,
      application_name: 'qcloud:worker-1',
    });
  });

  test('the application name is cut to the 63 bytes Postgres keeps', () => {
    const config = resolveConnection({ url, applicationName: 'x'.repeat(100) });
    expect(String(config.startupParameters.application_name)).toHaveLength(63);
  });

  test('behind a pooler: prepared statements off, and no listen target without a listenUrl', () => {
    const config = resolveConnection({ url, pooler: 'transaction' });
    expect(config).toMatchObject({ pooler: 'transaction', prepare: false, listenTarget: null });
    const listening = resolveConnection({
      url,
      pooler: 'transaction',
      listenUrl: 'postgres://u:p@127.0.0.1:5433/d',
    });
    expect(listening.listenTarget).toMatchObject({ port: 5433 });
    expect(listening.target).toMatchObject({ port: 5432 });
  });

  test('behind a pooler the startup parameters the pooler rejects are refused up front', () => {
    expect(
      message(() => resolveConnection({ url, pooler: 'transaction', statementTimeoutMs: 5000 }))
    ).toMatch(/rejects statement_timeout.*ALTER ROLE <role> SET statement_timeout = 5000/);
    expect(
      message(() => resolveConnection({ url, pooler: 'transaction', lockTimeoutMs: 1 }))
    ).toMatch(/lock_timeout/);
    expect(
      message(() =>
        resolveConnection({ url, pooler: 'transaction', idleInTransactionTimeoutMs: 1 })
      )
    ).toMatch(/idle_in_transaction_session_timeout/);
    expect(
      message(() => resolveConnection({ url, pooler: 'transaction', schema: 'qcloud_x' }))
    ).toMatch(/ALTER ROLE <role> SET search_path/);
  });

  test('listenUrl without a pooler is a mistake', () => {
    expect(message(() => resolveConnection({ url, listenUrl: url }))).toMatch(
      /only for a pooled connection/
    );
  });

  test('schema names are checked, so nothing can be injected through them', () => {
    for (const schema of ['', 'Upper', '1abc', 'a-b', 'a b', 'x;DROP', 'a'.repeat(64)]) {
      expect(message(() => resolveConnection({ url, schema }))).toMatch(/not a usable schema name/);
    }
    expect(resolveConnection({ url, schema: 'qcloud_t_0123abcd' }).schema).toBe(
      'qcloud_t_0123abcd'
    );
  });

  test('numbers must be sensible', () => {
    expect(message(() => resolveConnection({ url, poolSize: 0 }))).toMatch(/poolSize/);
    expect(message(() => resolveConnection({ url, poolSize: 1.5 }))).toMatch(/poolSize/);
    expect(message(() => resolveConnection({ url, statementTimeoutMs: -1 }))).toMatch(
      /statementTimeoutMs/
    );
    expect(message(() => resolveConnection({ url, operationDeadlineMs: 0 }))).toMatch(
      /operationDeadlineMs/
    );
    expect(message(() => resolveConnection({ url, idleTimeoutSeconds: Number.NaN }))).toMatch(
      /idleTimeoutSeconds/
    );
  });

  test('a fleet that needs more connections than the database has is refused before anything connects', () => {
    expect(() => resolveConnection({ url, fleet: { workers: 50, maxConnections: 100 } })).toThrow(
      ConnectionBudgetError
    );
    expect(resolveConnection({ url, fleet: { workers: 50, maxConnections: 112 } }).poolSize).toBe(
      2
    );
    // The same fleet is fine behind a pooler.
    expect(
      resolveConnection({
        url,
        pooler: 'transaction',
        fleet: { workers: 500, maxConnections: 100 },
      }).pooler
    ).toBe('transaction');
  });

  test('the fleet check uses this connection’s pool size', () => {
    expect(() =>
      resolveConnection({ url, poolSize: 10, fleet: { workers: 10, maxConnections: 100 } })
    ).toThrow(/needs 136 database connections/);
  });
});
