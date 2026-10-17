import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { OperationDeadlineError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { TcpProxy } from '../../../test/support/tcpProxy';
import type { Database } from '../src/connection/connect';
import { openDatabase } from '../src/connection/connect';
import type { FaultProxy } from './fault';
import { outcome, startFaultProxy } from './fault';

/** The store's own connection (`openDatabase`) against a network that resets and goes silent. */
describeDb('connection: Database under faults', () => {
  let fault: FaultProxy;
  let proxy: TcpProxy;
  const opened: Database[] = [];

  beforeAll(async () => {
    fault = await startFaultProxy();
    proxy = fault.proxy;
  });
  afterEach(async () => {
    proxy.blackhole(false);
    await proxy.accept();
    for (const db of opened.splice(0)) await db.close({ timeout: 1000 }).catch(() => {});
  });
  afterAll(async () => {
    await fault.stop();
  });

  const open = (options: Partial<Parameters<typeof openDatabase>[0]> = {}) => {
    const db = openDatabase({
      url: fault.url,
      poolSize: 1,
      connectTimeoutSeconds: 3,
      operationDeadlineMs: 700,
      applicationName: 'qcloud:test',
      ...options,
    });
    opened.push(db);
    return db;
  };
  const ping = (db: Database, deadlineMs?: number) =>
    db.run('ping', (sql) => sql`SELECT 1 AS n`, deadlineMs);

  test('a healthy connection answers and retires nothing', async () => {
    const db = open();
    expect((await outcome(() => ping(db), 2_000)).result).toBe('ok');
    expect(db.retirements).toBe(0);
  });

  test('a silent network ends in OperationDeadlineError at the deadline, and the next call works', async () => {
    const db = open();
    await ping(db);
    proxy.blackhole(true);
    const stalled = await outcome(() => ping(db), 3_000);
    expect(stalled.code).toBe(new OperationDeadlineError('ping', 700).code);
    expect(stalled.ms).toBeGreaterThanOrEqual(650);
    expect(stalled.ms).toBeLessThan(1_300);
    // The replacement pool cannot connect through a still-silent network: it fails, bounded.
    const stillDown = await outcome(() => ping(db), 3_000);
    expect(stillDown.result).toBe('error');
    expect(stillDown.ms).toBeLessThan(1_300);
    proxy.blackhole(false);
    expect((await outcome(() => ping(db), 5_000)).result).toBe('ok');
    expect(db.retirements).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test('the error names the operation and the deadline', async () => {
    const db = open();
    await ping(db);
    proxy.blackhole(true);
    const error = await ping(db).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationDeadlineError);
    expect(error).toMatchObject({ operation: 'ping', deadlineMs: 700 });
  }, 10_000);

  test('a deadline given to one call overrides the default for that call only', async () => {
    const db = open({ operationDeadlineMs: 5_000 });
    await ping(db);
    proxy.blackhole(true);
    const short = await outcome(() => ping(db, 300), 3_000);
    expect(short.code).toBe('OPERATION_DEADLINE');
    expect(short.ms).toBeLessThan(900);
  }, 10_000);

  test('concurrent operations that all hit the deadline retire the pool once', async () => {
    const db = open({ poolSize: 4, operationDeadlineMs: 600 });
    await ping(db);
    proxy.blackhole(true);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => outcome(() => ping(db), 3_000))
    );
    expect(results.every((result) => result.result === 'error')).toBe(true);
    expect(db.retirements).toBe(1);
  }, 20_000);

  test('a reset is an ordinary driver error, not a deadline: nothing is retired', async () => {
    const db = open({ operationDeadlineMs: 5_000 });
    await ping(db);
    const running = outcome(() => db.run('sleep', (sql) => sql`SELECT pg_sleep(3)`), 6_000);
    await Bun.sleep(300);
    proxy.sever();
    const failed = await running;
    expect(failed).toMatchObject({ result: 'error', code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
    expect(db.retirements).toBe(0);
    await Bun.sleep(50);
    expect((await outcome(() => ping(db), 2_000)).result).toBe('ok');
  }, 20_000);

  test('close returns within its grace even when the connection is silent', async () => {
    const db = open({ operationDeadlineMs: 5_000 });
    await ping(db);
    proxy.blackhole(true);
    void ping(db).catch(() => {});
    await Bun.sleep(200);
    const started = performance.now();
    await db.close({ timeout: 500 });
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 10_000);

  test('a closed database refuses new work with a StoreError, not a hang', async () => {
    const db = open();
    await ping(db);
    await db.close({ timeout: 1000 });
    const closed = await outcome(() => ping(db), 1_000);
    expect(closed).toMatchObject({ result: 'error', code: 'STORE_ERROR' });
  });
});
