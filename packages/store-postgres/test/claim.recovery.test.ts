import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

/**
 * A SIMULATION, not a measurement of the product. It drives the real claim with a virtual clock and
 * a test-side stand-in for the tick's re-ring, because the tick is task 15. The stand-in follows the
 * design rule (DESIGN.md, "The tick"): ring claimable jobs whose last bell is at least `reRingAfterMs`
 * old, at most `cap` per tick, then deliver each bell as one claim of one job (bells are fungible).
 *
 * What it shows: while a queue is rate-limited, a bell that arrives with the window used up claims
 * nothing and is spent, and the only thing that rings the jobs again is the next tick. The tick does
 * not know when the window reopens (`rate_window_started_at + rate_duration_ms`), so recovery runs
 * at the speed of the tick, not of the limit. Task 15 can close that gap by ringing at the window's end.
 */
const TICK_MS = 10_000;
const REPEAT_AFTER_MS = TICK_MS;

describeDb('claim: rate-limited recovery (simulation, virtual clock)', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state`;
    rewind(t);
  });

  /** One tick: ring due jobs, then answer each bell with a claim of one job. Returns the jobs claimed. */
  async function tick(cap: number): Promise<number> {
    const now = t.clock.now();
    const rung = await t.fresh.sql<{ id: string }[]>`
      UPDATE qcloud_jobs SET rung_at = ${now}
      WHERE id IN (
        SELECT id FROM qcloud_jobs
        WHERE state IN ('waiting', 'prioritized') AND run_at <= ${now}
          AND (rung_at IS NULL OR rung_at <= ${now - REPEAT_AFTER_MS})
        ORDER BY run_at, id LIMIT ${cap})
      RETURNING id`;
    let claimed = 0;
    for (let bell = 0; bell < rung.length; bell++) {
      claimed += (await t.store.claim('q', 'worker', 1)).length;
    }
    return claimed;
  }

  /** Virtual milliseconds from the first tick to the one that claimed the last job. */
  async function drainTime(jobs: number, cap: number): Promise<number> {
    const start = t.clock.now();
    let left = jobs;
    for (let ticks = 0; left > 0; ticks++) {
      expect(ticks).toBeLessThan(500);
      left -= await tick(cap);
      if (left > 0) t.clock.advance(TICK_MS);
    }
    return t.clock.now() - start;
  }

  const cases = [
    {
      label:
        'a window much shorter than the tick: the tick sets the pace, 10 per tick instead of 10 per second',
      limit: { max: 10, durationMs: 1_000 },
      cap: 100,
      expected: 50_000,
      ideal: 5_000,
    },
    {
      label: 'a window longer than the tick: the limit sets the pace',
      limit: { max: 10, durationMs: 30_000 },
      cap: 100,
      expected: 150_000,
      ideal: 150_000,
    },
    {
      label: 'a per-tick ring cap below the rate: the cap sets the pace',
      limit: { max: 10, durationMs: 1_000 },
      cap: 3,
      expected: 190_000,
      ideal: 5_000,
    },
  ];

  test.each(cases)('60 jobs: $label', async ({ limit, cap, expected, ideal }) => {
    await enqueueN(t.store, 60);
    await t.store.setRateLimit('q', limit);
    const elapsed = await drainTime(60, cap);
    console.info(
      `[simulation] 60 jobs, ${limit.max} per ${limit.durationMs} ms, tick ${TICK_MS} ms, cap ${cap}: ` +
        `drained in ${elapsed} virtual ms (limit alone: ${ideal})`
    );
    expect(elapsed).toBe(expected);
    expect(elapsed).toBeGreaterThanOrEqual(ideal);
  });

  test('without a rate limit the first tick claims everything it rings', async () => {
    await enqueueN(t.store, 60);
    expect(await drainTime(60, 100)).toBe(0);
  });
});
