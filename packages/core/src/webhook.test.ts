import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DELIVERY_POLICY,
  deliveryBody,
  resolveDeliveryPolicy,
  webhookAlertLevel,
  webhookRetryDelayMs,
} from './webhook';

describe('webhook retry schedule', () => {
  test('doubles from the base and stops growing at the cap', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
      (failed) => webhookRetryDelayMs(failed, DEFAULT_DELIVERY_POLICY) / 60_000
    );
    expect(minutes).toEqual([0.5, 1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  test('a huge failure count does not overflow the shift', () => {
    expect(webhookRetryDelayMs(10_000, DEFAULT_DELIVERY_POLICY)).toBe(3_600_000);
    expect(webhookRetryDelayMs(0, DEFAULT_DELIVERY_POLICY)).toBe(30_000);
  });

  test('with random, a wait is spread by 20% either way and never passes the cap', () => {
    const policy = { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 4_000 };
    expect(webhookRetryDelayMs(2, policy, () => 0)).toBe(1_600);
    expect(webhookRetryDelayMs(2, policy, () => 0.5)).toBe(2_000);
    expect(webhookRetryDelayMs(2, policy, () => 0.999999)).toBe(2_400);
    expect(webhookRetryDelayMs(9, policy, () => 0)).toBe(3_200);
    expect(webhookRetryDelayMs(9, policy, () => 0.999999)).toBe(4_000);
  });

  test('the default budget is eight attempts over 63.5 minutes of waiting', () => {
    let total = 0;
    for (let failed = 1; failed < DEFAULT_DELIVERY_POLICY.maxAttempts; failed += 1) {
      total += webhookRetryDelayMs(failed, DEFAULT_DELIVERY_POLICY);
    }
    expect(total / 60_000).toBe(63.5);
  });

  test('a policy is validated', () => {
    expect(resolveDeliveryPolicy({ maxAttempts: 3 }).maxAttempts).toBe(3);
    expect(() => resolveDeliveryPolicy({ maxAttempts: 0 })).toThrow('maxAttempts');
    expect(() => resolveDeliveryPolicy({ baseDelayMs: 2.5 })).toThrow('baseDelayMs');
    expect(() => resolveDeliveryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow('maxDelayMs');
    expect(resolveDeliveryPolicy().disableAfter).toBe(20);
    expect(resolveDeliveryPolicy({ disableAfter: 0 }).disableAfter).toBe(0);
    expect(() => resolveDeliveryPolicy({ disableAfter: -1 })).toThrow('disableAfter');
    expect(() => resolveDeliveryPolicy({ disableAfter: 1.5 })).toThrow('disableAfter');
  });
});

describe('delivery body', () => {
  test('a test event carries its id, name and time, as stable text the signature can cover', () => {
    const input = { id: '17', event: 'webhook.test', occurredAt: 1_700_000_000_000 } as const;
    expect(deliveryBody(input)).toBe(
      '{"id":"17","event":"webhook.test","timestamp":1700000000000}'
    );
    expect(deliveryBody(input)).toBe(deliveryBody(input));
  });
});

describe('webhook alert level', () => {
  test('steps at 50, 70, 90 and 100 percent of the limit, and is 0 when the limit is off', () => {
    const levels = [0, 9, 10, 13, 14, 17, 18, 19, 20, 25].map((n) => webhookAlertLevel(n, 20));
    expect(levels).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(webhookAlertLevel(500, 0)).toBe(0);
  });
});
