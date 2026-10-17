import { describe, expect, test } from 'bun:test';
import {
  claimLeaseUntil,
  leaseDeadline,
  NEVER_EXPIRES_MS,
  processingDeadline,
  requestedLeaseMs,
} from '../src/store/leaseRules';

const NOW = 1_800_000_000_000;
const NONE = { timeout: null, stallTimeout: undefined };

describe('lease: rules', () => {
  describe('leaseDeadline', () => {
    test('adds the duration and rounds up to a whole millisecond', () => {
      expect(leaseDeadline(NOW, 30_000)).toBe(NOW + 30_000);
      expect(leaseDeadline(NOW, 0.2)).toBe(NOW + 1);
    });

    test('stays inside [0, never expires]', () => {
      expect(leaseDeadline(NOW, Number.POSITIVE_INFINITY)).toBe(NEVER_EXPIRES_MS);
      expect(leaseDeadline(NOW, 2 * NEVER_EXPIRES_MS)).toBe(NEVER_EXPIRES_MS);
      expect(leaseDeadline(NOW, -2 * NOW)).toBe(0);
      expect(leaseDeadline(NOW, Number.NaN)).toBe(0);
    });
  });

  describe('requestedLeaseMs', () => {
    test('uses the request, rounded up', () => {
      expect(requestedLeaseMs(5_000, 30_000)).toBe(5_000);
      expect(requestedLeaseMs(1_500.2, 30_000)).toBe(1_501);
    });

    test('anything that is not a number takes the fallback', () => {
      for (const value of [undefined, null, '5000', {}, Number.NaN]) {
        expect(requestedLeaseMs(value, 30_000)).toBe(30_000);
      }
    });

    test('is at least 1 ms, and Infinity never expires', () => {
      expect(requestedLeaseMs(0, 30_000)).toBe(1);
      expect(requestedLeaseMs(-5, 30_000)).toBe(1);
      expect(requestedLeaseMs(Number.POSITIVE_INFINITY, 30_000)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe('processingDeadline', () => {
    test('no timeout means none', () => {
      expect(processingDeadline(null, NOW)).toBeNull();
      expect(processingDeadline(0, NOW)).toBeNull();
    });

    test('is started_at + timeout', () => {
      expect(processingDeadline(2_000, NOW)).toBe(NOW + 2_000);
      expect(processingDeadline(-5, NOW)).toBe(NOW - 5);
    });

    test('a huge timeout reads as never', () => {
      expect(processingDeadline(Number.MAX_VALUE, NOW)).toBe(NEVER_EXPIRES_MS);
    });
  });

  describe('claimLeaseUntil', () => {
    test('with no caps it is now + leaseMs', () => {
      expect(claimLeaseUntil(NOW, 30_000, NONE)).toBe(NOW + 30_000);
    });

    test('a shorter stall timeout shortens it, a longer one does not', () => {
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, stallTimeout: 3_000 })).toBe(NOW + 3_000);
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, stallTimeout: 90_000 })).toBe(NOW + 30_000);
    });

    test('the processing deadline caps it', () => {
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, timeout: 2_000 })).toBe(NOW + 2_000);
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, timeout: 60_000 })).toBe(NOW + 30_000);
    });

    test('the shortest of the three wins', () => {
      expect(claimLeaseUntil(NOW, 30_000, { timeout: 8_000, stallTimeout: 5_000 })).toBe(
        NOW + 5_000
      );
      expect(claimLeaseUntil(NOW, 30_000, { timeout: 4_000, stallTimeout: 5_000 })).toBe(
        NOW + 4_000
      );
    });

    test('a timeout that is already due still yields a lease of at least 1 ms', () => {
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, timeout: -5 })).toBe(NOW + 1);
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, stallTimeout: 0 })).toBe(NOW + 1);
      expect(claimLeaseUntil(NOW, 0.5, NONE)).toBe(NOW + 1);
    });

    test('an infinite lease never expires, a stall timeout still shortens it', () => {
      const forever = Number.POSITIVE_INFINITY;
      expect(claimLeaseUntil(NOW, forever, NONE)).toBe(NEVER_EXPIRES_MS);
      expect(claimLeaseUntil(NOW, forever, { ...NONE, stallTimeout: 1_000 })).toBe(NOW + 1_000);
    });

    test('a NaN stall timeout is ignored', () => {
      expect(claimLeaseUntil(NOW, 30_000, { ...NONE, stallTimeout: Number.NaN })).toBe(
        NOW + 30_000
      );
    });

    test('always a whole number of milliseconds', () => {
      expect(Number.isInteger(claimLeaseUntil(NOW, 1_234.5, { ...NONE, timeout: 999.4 }))).toBe(
        true
      );
    });
  });
});
