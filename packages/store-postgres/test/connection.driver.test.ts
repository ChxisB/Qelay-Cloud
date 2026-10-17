import { afterAll, beforeAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { describeDb } from '../../../test/support/db';
import type { TcpProxy } from '../../../test/support/tcpProxy';
import type { FaultProxy } from './fault';
import { outcome, startFaultProxy } from './fault';

/**
 * What Bun.SQL 1.4.2 does on its own when the network misbehaves. These tests pin the behaviour
 * that `ResilientPool` and the retry-once rule for idempotent callers are built on: if a Bun
 * upgrade changes one of them, this file says so before production does.
 */
describeDb('connection: raw Bun.SQL under faults', () => {
  let fault: FaultProxy;
  let proxy: TcpProxy;

  beforeAll(async () => {
    fault = await startFaultProxy();
    proxy = fault.proxy;
  });
  afterAll(async () => {
    await fault.stop();
  });
  const pool = (options: SQL.Options = {}) =>
    new SQL(fault.url, { max: 2, connectionTimeout: 3, prepare: false, ...options });
  const ping = (sql: SQL) => sql`SELECT 1 AS n`;

  test('a reset while idle is invisible once the pool has seen the close', async () => {
    const sql = pool();
    try {
      await ping(sql);
      proxy.sever();
      await Bun.sleep(50);
      for (let n = 0; n < 3; n++) expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
    } finally {
      await sql.close({ timeout: 1 });
    }
  });

  test('a query sent in the same instant as a reset fails: idempotent callers retry once', async () => {
    const sql = pool();
    try {
      await ping(sql);
      proxy.sever();
      // No time for the close event to reach the pool: the statement goes to a dead socket.
      const first = await outcome(() => ping(sql), 2_000);
      expect(first).toMatchObject({ result: 'error', code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
      await Bun.sleep(50);
      expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
    } finally {
      await sql.close({ timeout: 1 });
    }
  });

  test('a reset mid-query fails that query with CONNECTION_CLOSED and nothing else', async () => {
    const sql = pool();
    try {
      await ping(sql);
      const running = outcome(() => sql`SELECT pg_sleep(3)`, 5_000);
      await Bun.sleep(300);
      proxy.sever();
      const failed = await running;
      expect(failed).toMatchObject({ result: 'error', code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
      expect(failed.ms).toBeLessThan(1_500);
      // The pool may hold a second, idle connection that the reset also killed: give it the
      // moment it needs to see the close (see the same-instant test above).
      await Bun.sleep(50);
      expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
    } finally {
      await sql.close({ timeout: 1 });
    }
  });

  test('a database that is down fails fast, and the same pool works when it is back', async () => {
    const sql = pool();
    try {
      await ping(sql);
      await proxy.refuse();
      const down = [];
      for (let n = 0; n < 3; n++) down.push(await outcome(() => ping(sql), 2_000));
      for (const attempt of down) {
        expect(attempt.result).toBe('error');
        expect(attempt.code).toMatch(/ERR_POSTGRES_CONNECTION_(REFUSED|CLOSED)/);
        expect(attempt.ms).toBeLessThan(500);
      }
      await proxy.accept();
      expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
    } finally {
      await proxy.accept();
      await sql.close({ timeout: 1 });
    }
  });

  test('a silent connection hangs a raw pool for good: no cancel, no statement_timeout, no recovery', async () => {
    const sql = pool({ max: 1, connection: { statement_timeout: 500 } });
    try {
      await ping(sql);
      proxy.blackhole(true);
      const query = ping(sql);
      const settled = query.then(
        () => 'resolved',
        () => 'rejected'
      );
      expect(await outcome(() => query, 1_200)).toMatchObject({ result: 'hung' });
      (query as unknown as { cancel(): void }).cancel();
      expect(await Promise.race([settled, Bun.sleep(800).then(() => 'pending')])).toBe('pending');
      // The packets are gone, not delayed: lifting the fault does not unstick the connection.
      proxy.blackhole(false);
      expect((await outcome(() => ping(sql), 1_200)).result).toBe('hung');
    } finally {
      proxy.blackhole(false);
      // Without a timeout this never returns.
      const started = performance.now();
      await sql.close({ timeout: 1 });
      expect(performance.now() - started).toBeLessThan(3_000);
    }
  }, 20_000);

  test('maxLifetime is an age-based backstop: it frees a stalled connection without any wrapper', async () => {
    const sql = pool({ max: 1, maxLifetime: 2 });
    try {
      await ping(sql);
      await Bun.sleep(1_200);
      proxy.blackhole(true);
      const stalled = await outcome(() => ping(sql), 5_000);
      proxy.blackhole(false);
      expect(stalled.result).toBe('error');
      expect(stalled.code).toBe('ERR_POSTGRES_LIFETIME_TIMEOUT');
      // The connection was 1.2 s old when the query started: the clock is the connection's age,
      // not the query's, so the stall lasted about 0.8 s and not 2 s.
      expect(stalled.ms).toBeLessThan(1_700);
      expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
    } finally {
      proxy.blackhole(false);
      await sql.close({ timeout: 1 });
    }
  }, 20_000);

  test('idleTimeout reaps an idle connection and the next query opens a new one', async () => {
    const sql = pool({ max: 1, idleTimeout: 1 });
    try {
      await ping(sql);
      const before = proxy.accepted;
      await Bun.sleep(2_000);
      expect((await outcome(() => ping(sql), 2_000)).result).toBe('ok');
      expect(proxy.accepted - before).toBe(1);
    } finally {
      await sql.close({ timeout: 1 });
    }
  }, 10_000);
});
