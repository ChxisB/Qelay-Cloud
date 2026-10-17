import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ManualClock } from '../../../test/support/clock';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { openDatabase } from '../src/connection/connect';
import { createStoreTime } from '../src/time';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';

test('an injected clock is returned as is, and no statement is run', async () => {
  const clock = new ManualClock(42_000);
  const time = createStoreTime(clock);
  const sql = new Proxy(
    {},
    { get: () => () => Promise.reject(new Error('the database was asked')) }
  );
  expect(time.injected).toBe(true);
  expect(await time.now(sql as never)).toBe(42_000);
  clock.advance(1_500);
  expect(await time.now(sql as never)).toBe(43_500);
});

test('a database opened with a clock exposes it, one without does not', () => {
  const url = 'postgres://u:p@127.0.0.1:1/d';
  expect(openDatabase({ url, clock: new ManualClock() }).time.injected).toBe(true);
  expect(openDatabase({ url }).time.injected).toBe(false);
});

describeDb('store time: the database clock', () => {
  let fresh: FreshSchema;
  beforeAll(async () => {
    fresh = await freshSchema();
  });
  afterAll(async () => {
    await fresh.drop();
  });

  test('the default reads the database clock, in epoch milliseconds', async () => {
    const before = Date.now();
    const now = await fresh.db.time.now(fresh.sql);
    const after = Date.now();
    expect(Number.isInteger(now)).toBe(true);
    // Postgres and this process share a clock on one machine: a loose bound is enough to tell
    // epoch milliseconds from seconds or microseconds.
    expect(now).toBeGreaterThanOrEqual(before - 1_000);
    expect(now).toBeLessThanOrEqual(after + 1_000);
  });

  test('the database clock moves forward between two reads', async () => {
    const first = await fresh.db.time.now(fresh.sql);
    await Bun.sleep(20);
    const second = await fresh.db.time.now(fresh.sql);
    expect(second).toBeGreaterThan(first);
  });

  test('a skewed worker clock has no say: an injected clock is the only thing that can move time', async () => {
    const skewed = new ManualClock(Date.now() - 3_600_000);
    const db = openDatabase({
      url: testDatabaseUrl(),
      schema: fresh.name,
      clock: skewed,
    });
    try {
      expect(await db.time.now(fresh.sql)).toBe(skewed.now());
      // The default database, by contrast, is not at the skewed instant.
      expect(Math.abs((await fresh.db.time.now(fresh.sql)) - skewed.now())).toBeGreaterThan(
        3_000_000
      );
    } finally {
      await db.close({ timeout: 1000 });
    }
  });
});
