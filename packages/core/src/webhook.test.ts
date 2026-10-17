import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DELIVERY_POLICY,
  deliveryBody,
  isWebhookEvent,
  JOURNAL_TO_WEBHOOK,
  resolveDeliveryPolicy,
  WEBHOOK_EVENTS,
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
  });
});

describe('webhook events', () => {
  test('every journal event with a webhook name maps to a subscribable event', () => {
    for (const name of Object.values(JOURNAL_TO_WEBHOOK)) expect(isWebhookEvent(name)).toBe(true);
    expect(Object.keys(JOURNAL_TO_WEBHOOK).sort()).toEqual([
      'completed',
      'failed',
      'progress',
      'pulled',
      'pushed',
    ]);
    expect(WEBHOOK_EVENTS).toHaveLength(5);
    expect(isWebhookEvent('webhook.test')).toBe(false);
    expect(isWebhookEvent(42)).toBe(false);
  });
});

describe('delivery body', () => {
  test('carries where and what, and leaves out what is not known', () => {
    const body = deliveryBody({
      id: '17',
      event: 'job.failed',
      occurredAt: 1_700_000_000_000,
      queue: 'emails',
      jobId: 'j1',
      state: 'failed',
      error: 'SMTP 550',
    });
    expect(JSON.parse(body)).toEqual({
      id: '17',
      event: 'job.failed',
      timestamp: 1_700_000_000_000,
      queue: 'emails',
      jobId: 'j1',
      state: 'failed',
      error: 'SMTP 550',
    });
    const bare = JSON.parse(
      deliveryBody({ id: '1', event: 'job.pushed', occurredAt: 1, queue: 'q', jobId: 'j' })
    );
    expect(Object.keys(bare)).toEqual(['id', 'event', 'timestamp', 'queue', 'jobId']);
  });

  test('is stable text: the same input signs to the same bytes', () => {
    const input = { id: '1', event: 'job.pushed', occurredAt: 5, queue: 'q', jobId: 'j' } as const;
    expect(deliveryBody(input)).toBe(deliveryBody(input));
    expect(deliveryBody(input)).toBe(
      '{"id":"1","event":"job.pushed","timestamp":5,"queue":"q","jobId":"j"}'
    );
  });
});
