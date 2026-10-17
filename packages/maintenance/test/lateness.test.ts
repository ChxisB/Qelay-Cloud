import { afterAll, beforeAll, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { measureLateness } from './lateness';

const INTERVAL = 500;

/**
 * The delay precision the contract quotes, measured on the real loop: a delayed job is late by
 * about half an interval when the tick rings it only once due, close to nothing when the tick
 * rings it ahead, and never early either way. `scripts/measure-tick-lateness.ts` runs the longer
 * version, over two intervals, whose numbers go in the task's Result and in docs/limits.md.
 */
describeDb('tick lateness on the real loop (database clock, real timers)', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ clock: null, ringWindowMs: 0, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });

  test('window 0: late by about U(0, interval), never early', async () => {
    const result = await measureLateness({
      t,
      intervalMs: INTERVAL,
      windowMs: 0,
      jobs: 30,
      queue: 'zero',
    });
    console.log(`[lateness] interval ${INTERVAL} ms, window 0: ${JSON.stringify(result)}`);
    expect(result.n).toBe(30);
    expect(result.min).toBeGreaterThanOrEqual(0);
    expect(result.earlyBells).toBe(0);
    // Nearly every job: the interval, plus what a timer, a database round trip and a busy machine add.
    expect(result.p95).toBeLessThanOrEqual(INTERVAL + 400);
    // The worst a job may be: the contract's bound for one bell that is lost or finds its job locked
    // (the tick finds it within an interval, re-rings it a re-ring age later, at the beat after).
    expect(result.max).toBeLessThanOrEqual(3 * INTERVAL);
    expect(result.mean).toBeGreaterThan(INTERVAL * 0.2);
    expect(result.mean).toBeLessThan(INTERVAL * 0.8);
  }, 60_000);

  test('a window: the tick rings ahead, so the lateness is the broker`s and not the tick`s', async () => {
    const result = await measureLateness({
      t,
      intervalMs: INTERVAL,
      windowMs: INTERVAL + 1_000,
      jobs: 30,
      queue: 'windowed',
    });
    console.log(
      `[lateness] interval ${INTERVAL} ms, window ${INTERVAL + 1_000}: ${JSON.stringify(result)}`
    );
    expect(result.n).toBe(30);
    expect(result.min).toBeGreaterThanOrEqual(0);
    expect(result.earlyBells).toBe(0);
    expect(result.p95).toBeLessThan(INTERVAL / 4);
    expect(result.max).toBeLessThan(INTERVAL);
    expect(result.mean).toBeLessThan(INTERVAL / 10);
  }, 60_000);
});
