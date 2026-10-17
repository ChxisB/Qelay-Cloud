import { describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import {
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_WORST_LATENESS_MS,
  MAX_RING_WINDOW_MS,
  resolveTickConfig,
  transportWindowMs,
} from '../src/config';

const FAR = { capabilities: { maxDeliverDelayMs: Number.POSITIVE_INFINITY } } as never;
const NO_DELAY = { capabilities: { maxDeliverDelayMs: 0 } } as never;
const FIVE_MIN = { capabilities: { maxDeliverDelayMs: 300_000 } } as never;

describe('resolveTickConfig', () => {
  test('defaults: a five second interval, a re-ring age equal to it, a window of interval plus lateness', () => {
    const config = resolveTickConfig(FAR);
    expect(config.intervalMs).toBe(DEFAULT_TICK_INTERVAL_MS);
    expect(config.budget.reRingAfterMs).toBe(DEFAULT_TICK_INTERVAL_MS);
    expect(config.windowMs).toBe(DEFAULT_TICK_INTERVAL_MS + DEFAULT_WORST_LATENESS_MS);
    expect(config.budget.ringWindowMs).toBe(config.windowMs);
    expect(config.delayPrecisionMs).toBe(0);
  });

  test('a re-ring age above the tick interval is rejected, and the message says why and what to give', () => {
    const attempt = () => resolveTickConfig(FAR, { intervalMs: 1_000, reRingAfterMs: 1_001 });
    expect(attempt).toThrow(UnsupportedOptionError);
    expect(attempt).toThrow(/reRingAfterMs.*1001.*interval is 1000.*at most 1000/);
  });

  test('a re-ring age equal to or below the interval is accepted, 0 included', () => {
    expect(
      resolveTickConfig(FAR, { intervalMs: 1_000, reRingAfterMs: 1_000 }).budget.reRingAfterMs
    ).toBe(1_000);
    expect(
      resolveTickConfig(FAR, { intervalMs: 1_000, reRingAfterMs: 0 }).budget.reRingAfterMs
    ).toBe(0);
  });

  test('the check follows the interval the scheduler really has', () => {
    expect(() =>
      resolveTickConfig(FAR, { intervalMs: 60_000, reRingAfterMs: 5_000 })
    ).not.toThrow();
    expect(() => resolveTickConfig(FAR, { reRingAfterMs: 60_000 })).toThrow(/at most 5000/);
  });

  test('a window below the interval plus the worst lateness is refused unless it is 0', () => {
    expect(() => resolveTickConfig(FAR, { intervalMs: 1_000, ringWindowMs: 1_500 })).toThrow(
      /ringWindowMs.*below the interval plus the worst lateness \(2000\)/
    );
    expect(resolveTickConfig(FAR, { intervalMs: 1_000, ringWindowMs: 2_000 }).windowMs).toBe(2_000);
    expect(resolveTickConfig(FAR, { intervalMs: 1_000, ringWindowMs: 0 }).windowMs).toBe(0);
  });

  test('the window is clamped to the transport and to the store, and said so in the precision', () => {
    const clamped = resolveTickConfig(FIVE_MIN, { intervalMs: 1_000, ringWindowMs: 3_600_000 });
    expect(clamped.windowMs).toBe(300_000);
    expect(clamped.budget.ringWindowMs).toBe(300_000);
    expect(resolveTickConfig(FAR, { intervalMs: 1_000 }, { ringWindowMs: 1_500 }).windowMs).toBe(
      1_500
    );
    expect(resolveTickConfig(FAR, { intervalMs: 1_000 }, { ringWindowMs: 0 }).windowMs).toBe(0);
  });

  test('a transport that cannot delay rings delayed jobs only once due: precision is the interval plus its lateness', () => {
    const config = resolveTickConfig(NO_DELAY, { intervalMs: 5_000 });
    expect(config.windowMs).toBe(0);
    expect(config.delayPrecisionMs).toBe(6_000);
    expect(
      resolveTickConfig(NO_DELAY, { intervalMs: 5_000, worstLatenessMs: 0 }).delayPrecisionMs
    ).toBe(5_000);
  });

  test('a transport with no limit is held to the year the stores take', () => {
    expect(transportWindowMs(FAR)).toBe(MAX_RING_WINDOW_MS);
    expect(transportWindowMs(NO_DELAY)).toBe(0);
  });

  test.each([
    ['intervalMs', { intervalMs: 0 }],
    ['intervalMs', { intervalMs: 1.5 }],
    ['intervalMs', { intervalMs: Number.NaN }],
    ['reRingAfterMs', { reRingAfterMs: -1 }],
    ['ringGraceMs', { ringGraceMs: -1 }],
    ['worstLatenessMs', { worstLatenessMs: -5 }],
    ['maxRingsPerQueue', { maxRingsPerQueue: 0 }],
    ['maxItems', { maxItems: 0 }],
    ['maxPassMs', { maxPassMs: -1 }],
    ['maxRunMs', { maxRunMs: Number.POSITIVE_INFINITY }],
  ])('%s rejects %j', (name, options) => {
    expect(() => resolveTickConfig(FAR, options)).toThrow(UnsupportedOptionError);
    expect(() => resolveTickConfig(FAR, options)).toThrow(new RegExp(name));
  });

  test('the budget carries every value the store reads', () => {
    expect(
      resolveTickConfig(FAR, {
        intervalMs: 2_000,
        ringGraceMs: 500,
        maxRingsPerQueue: 7,
        maxItems: 9,
        maxPassMs: 1_234,
        maxRunMs: 4_321,
      })
    ).toMatchObject({
      intervalMs: 2_000,
      maxRunMs: 4_321,
      budget: {
        maxDurationMs: 1_234,
        maxRingsPerQueue: 7,
        maxItems: 9,
        reRingAfterMs: 2_000,
        ringGraceMs: 500,
        ringWindowMs: 3_000,
      },
    });
  });
});
