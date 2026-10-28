import { describe, expect, test } from 'bun:test';
import { isWebhookDestination, routeJobId } from './webhookRoute';

describe('isWebhookDestination', () => {
  test('knows http and queue only', () => {
    expect(isWebhookDestination('http')).toBe(true);
    expect(isWebhookDestination('queue')).toBe(true);
    expect(isWebhookDestination('workflow')).toBe(false);
    expect(isWebhookDestination(undefined)).toBe(false);
  });
});

describe('routeJobId', () => {
  test('is made from the delivery id, so a repeated attempt names the same job', () => {
    expect(routeJobId('17')).toBe('qcloud-route-17');
  });
});
