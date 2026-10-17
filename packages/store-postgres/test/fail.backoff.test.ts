import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_BACKOFF_MS,
  NO_JITTER,
  retryDelayMs,
} from '../src/store/backoff';

const fixed = (delay: number, maxDelay?: number) => ({
  type: 'fixed' as const,
  delay,
  ...(maxDelay !== undefined && { maxDelay }),
});
const exponential = (delay: number, maxDelay?: number) => ({
  type: 'exponential' as const,
  delay,
  ...(maxDelay !== undefined && { maxDelay }),
});
const jittered = (random: number) => ({ jitter: true, random: () => random });

describe('fail: retry delay', () => {
  test('fixed waits the base whatever the attempt', () => {
    expect([1, 2, 5, 50].map((attempts) => retryDelayMs(fixed(1500), attempts))).toEqual([
      1500, 1500, 1500, 1500,
    ]);
  });

  test('exponential doubles from twice the base: the first retry sees attempts = 1', () => {
    expect([1, 2, 3, 4].map((attempts) => retryDelayMs(exponential(1000), attempts))).toEqual([
      2000, 4000, 8000, 16000,
    ]);
  });

  test('a base of 0 retries at once, fixed or exponential, at any attempt', () => {
    expect(retryDelayMs(fixed(0), 1)).toBe(0);
    expect(retryDelayMs(exponential(0), 1)).toBe(0);
    expect(retryDelayMs(exponential(0), 5000)).toBe(0);
    expect(retryDelayMs(exponential(0), 5000, jittered(0.7))).toBe(0);
  });

  test('the delay is capped at an hour, or at the job maxDelay', () => {
    expect(retryDelayMs(exponential(1000), 30)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(retryDelayMs(fixed(10_000_000), 1)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(retryDelayMs(exponential(1000, 5000), 10)).toBe(5000);
    expect(retryDelayMs(fixed(9000, 5000), 1)).toBe(5000);
    expect(retryDelayMs(fixed(1000, 5000), 1)).toBe(1000);
  });

  test('a maxDelay of 0 means no wait at all', () => {
    expect(retryDelayMs(exponential(1000, 0), 3)).toBe(0);
    expect(retryDelayMs(fixed(1000, 0), 1)).toBe(0);
  });

  test('a huge attempt count or base stays finite and capped', () => {
    expect(retryDelayMs(exponential(1000), 1_000_000)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(retryDelayMs(exponential(Number.MAX_VALUE), 5)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(retryDelayMs(fixed(Number.POSITIVE_INFINITY), 1)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(retryDelayMs(exponential(Number.POSITIVE_INFINITY), 1)).toBe(DEFAULT_MAX_BACKOFF_MS);
  });

  test('a base that is not a usable number is the default 1000 ms', () => {
    const odd = [Number.NaN, -5, '5', null, undefined, {}] as unknown as number[];
    for (const delay of odd) {
      expect(retryDelayMs(fixed(delay), 1)).toBe(DEFAULT_BACKOFF_BASE_MS);
      expect(retryDelayMs(exponential(delay), 1)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
    }
  });

  test('a cap that is not a usable number is the one hour', () => {
    const odd = [Number.NaN, -1, '5', null, Number.POSITIVE_INFINITY] as unknown as number[];
    for (const maxDelay of odd) {
      expect(retryDelayMs({ type: 'fixed', delay: 10_000_000, maxDelay }, 1)).toBe(
        DEFAULT_MAX_BACKOFF_MS
      );
    }
  });

  test('an attempt count of 0 or below does not shrink an exponential delay', () => {
    expect(retryDelayMs(exponential(1000), 0)).toBe(1000);
    expect(retryDelayMs(exponential(1000), -3)).toBe(1000);
  });

  test('the delay is a whole number of milliseconds, rounded up', () => {
    expect(retryDelayMs(fixed(0.2), 1)).toBe(1);
    expect(retryDelayMs(fixed(333.4), 1, jittered(0.123))).toBe(
      Math.ceil(333.4 * (0.8 + 0.123 * 0.4))
    );
    expect(Number.isInteger(retryDelayMs(exponential(7.7), 3, jittered(0.31)))).toBe(true);
  });

  test('with jitter off nothing random is read', () => {
    const policy = {
      jitter: false,
      random: () => {
        throw new Error('random must not be read');
      },
    };
    expect(retryDelayMs(fixed(1000), 1, policy)).toBe(1000);
    expect(retryDelayMs(exponential(1000), 2, policy)).toBe(4000);
    expect(NO_JITTER.jitter).toBe(false);
  });

  test('fixed jitter spans plus or minus 20%', () => {
    expect(retryDelayMs(fixed(1000), 1, jittered(0))).toBe(800);
    expect(retryDelayMs(fixed(1000), 1, jittered(0.5))).toBe(1000);
    expect(retryDelayMs(fixed(1000), 1, jittered(0.999_999))).toBe(1200);
  });

  test('exponential jitter spans plus or minus 50%', () => {
    expect(retryDelayMs(exponential(1000), 1, jittered(0))).toBe(1000);
    expect(retryDelayMs(exponential(1000), 1, jittered(0.5))).toBe(2000);
    expect(retryDelayMs(exponential(1000), 1, jittered(0.999_999))).toBe(3000);
  });

  test('jitter never takes the delay over the cap', () => {
    expect(retryDelayMs(fixed(5000, 5000), 1, jittered(0.999_999))).toBe(5000);
    expect(retryDelayMs(exponential(1000, 2500), 1, jittered(0.999_999))).toBe(2500);
  });
});
