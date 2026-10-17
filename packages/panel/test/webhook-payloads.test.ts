import { describe, expect, test } from 'bun:test';
import { parseWebhookDeliveriesPayload, parseWebhooksPayload } from '../src/lib/dashboardPayloads';
import { generateWebhookSecret } from '../src/pages/control/webhooks/model';

const delivery = (over: Record<string, unknown> = {}) => ({
  id: '7',
  webhookId: 'hook-1',
  event: 'job.completed',
  queue: 'emails',
  jobId: 'job-1',
  occurredAt: 1_000,
  status: 'delivered',
  attempts: 1,
  nextAttemptAt: 1_000,
  lastStatusCode: 200,
  lastError: null,
  history: [{ attempt: 1, at: 1_000, durationMs: 4, statusCode: 200, error: null }],
  createdAt: 1_000,
  finishedAt: 1_100,
  ...over,
});

const page = (deliveries: unknown[], next: unknown = null) => ({
  ok: true,
  data: { deliveries, next },
});

describe('webhook registry payload', () => {
  const hook = {
    id: 'h',
    url: 'https://receiver.test/',
    urlRedacted: true,
    events: ['job.failed'],
    queue: null,
    signed: false,
    enabled: true,
    createdAt: 1,
    lastTriggered: null,
    successCount: 0,
    failureCount: 0,
  };

  test('says whether a webhook is signed and whether its address is cut down', () => {
    const [parsed] = parseWebhooksPayload({ ok: true, data: { webhooks: [hook] } }).data.webhooks;
    expect(parsed).toMatchObject({ signed: false, urlRedacted: true });
  });

  test.each(['signed', 'urlRedacted'])('a registry without %s is refused', (field) => {
    const { [field]: _gone, ...rest } = hook as Record<string, unknown>;
    expect(() => parseWebhooksPayload({ ok: true, data: { webhooks: [rest] } })).toThrow(
      /Malformed/
    );
  });
});

describe('webhook deliveries payload', () => {
  test('accepts a page with a cursor, and an empty one', () => {
    expect(parseWebhookDeliveriesPayload(page([delivery()], '6')).data.next).toBe('6');
    expect(parseWebhookDeliveriesPayload(page([])).data.deliveries).toEqual([]);
  });

  test('accepts a delivery that never got an answer', () => {
    const none = delivery({
      status: 'failed',
      lastStatusCode: null,
      lastError: 'connection failed',
      history: [{ attempt: 1, at: 1, durationMs: 0, statusCode: null, error: 'connection failed' }],
    });
    expect(parseWebhookDeliveriesPayload(page([none])).data.deliveries).toHaveLength(1);
  });

  test.each([
    ['an unknown status', { status: 'lost' }],
    ['an id that is not a delivery number', { id: '0' }],
    ['a status code out of range', { lastStatusCode: 99 }],
    ['a non-integer attempt count', { attempts: 1.5 }],
    ['a history that is not a list', { history: 'x' }],
    [
      'a history entry without an attempt number',
      { history: [{ at: 1, durationMs: 1, statusCode: 200, error: null }] },
    ],
    ['an error with a control character', { lastError: 'a\u0000b' }],
    ['a missing finishedAt', { finishedAt: undefined }],
  ])('refuses %s', (_label, over) => {
    expect(() => parseWebhookDeliveriesPayload(page([delivery(over)]))).toThrow(/Malformed/);
  });

  test('refuses a bad cursor, a repeated id and a page that is not the envelope', () => {
    expect(() => parseWebhookDeliveriesPayload(page([], 'abc'))).toThrow(/Malformed/);
    expect(() => parseWebhookDeliveriesPayload(page([delivery(), delivery()]))).toThrow(
      /Malformed/
    );
    expect(() => parseWebhookDeliveriesPayload({ ok: true })).toThrow(/Malformed/);
    expect(() => parseWebhookDeliveriesPayload({ ok: false, data: page([]).data })).toThrow(
      /Malformed/
    );
  });
});

describe('generated signing secret', () => {
  test('is 64 hex characters and different every time', () => {
    const secrets = new Set(Array.from({ length: 20 }, generateWebhookSecret));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) expect(secret).toMatch(/^[0-9a-f]{64}$/u);
  });
});
