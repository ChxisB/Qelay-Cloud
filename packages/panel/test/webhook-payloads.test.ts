import { describe, expect, test } from 'bun:test';
import { parseWebhookDeliveriesPayload, parseWebhooksPayload } from '../src/lib/dashboardPayloads';
import { parseWebhookStatsPayload } from '../src/lib/gatewayPayloads';
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

describe('route fields of the webhook registry', () => {
  const hook = {
    id: 'h',
    url: 'https://receiver.test/',
    urlRedacted: false,
    events: ['job.completed'],
    queue: 'orders',
    signed: false,
    enabled: true,
    createdAt: 1,
    lastTriggered: null,
    successCount: 0,
    failureCount: 0,
  };
  const parse = (over: Record<string, unknown>) =>
    parseWebhooksPayload({ ok: true, data: { webhooks: [{ ...hook, ...over }] } });

  test('a webhook from a server that predates routes is an http route with nothing to report', () => {
    expect(parse({}).data.webhooks[0]).toMatchObject({
      destination: 'http',
      target: null,
      consecutiveFailures: 0,
      alertLevel: 0,
      disabledReason: null,
    });
  });

  test('a queue route carries its target, and a paused one says why', () => {
    expect(
      parse({ destination: 'queue', url: '', target: 'refunds' }).data.webhooks[0]
    ).toMatchObject({
      destination: 'queue',
      target: 'refunds',
    });
    expect(
      parse({
        enabled: false,
        consecutiveFailures: 10,
        alertLevel: 4,
        disabledReason: 'x',
        disabledAt: 5,
      }).data.webhooks[0]
    ).toMatchObject({ alertLevel: 4, disabledReason: 'x', disabledAt: 5 });
  });

  test.each([
    ['an unknown destination', { destination: 'ftp' }],
    ['a queue route without a target', { destination: 'queue', url: '' }],
    ['an http route with a target', { destination: 'http', target: 'refunds' }],
    ['an alert level over 4', { alertLevel: 5 }],
    ['a negative failure streak', { consecutiveFailures: -1 }],
    ['a disabledAt that is not a time', { disabledAt: 'soon' }],
  ])('refuses %s', (_label, over) => {
    expect(() => parse(over)).toThrow(/Malformed/);
  });
});

describe('webhook stats payload', () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    since: 0,
    until: 3_600_000,
    bucketMs: 3_600_000,
    delivered: 3,
    failed: 1,
    pending: 0,
    failureRatio: 0.25,
    avgAttempts: 1.25,
    backlog: 0,
    oldestPendingAt: null,
    latency: { avgMs: 10, p95Ms: 20, maxMs: 30 },
    buckets: [{ from: 0, delivered: 3, failed: 1, pending: 0, avgLatencyMs: 10, p95LatencyMs: 20 }],
    ...over,
  });
  const parse = (over: Record<string, unknown> = {}) =>
    parseWebhookStatsPayload({ ok: true, data: { stats: stats(over) } });

  test('accepts a full answer, and an empty window of nulls', () => {
    expect(parse().data.stats.delivered).toBe(3);
    const empty = parse({
      delivered: 0,
      failed: 0,
      failureRatio: null,
      avgAttempts: null,
      latency: null,
      buckets: [
        { from: 0, delivered: 0, failed: 0, pending: 0, avgLatencyMs: null, p95LatencyMs: null },
      ],
    });
    expect(empty.data.stats.latency).toBeNull();
  });

  test.each([
    ['a count that is not a whole number', { delivered: 1.5 }],
    ['a negative backlog', { backlog: -1 }],
    ['a failure ratio that is not a number', { failureRatio: 'high' }],
    ['a latency with a missing figure', { latency: { avgMs: 1, p95Ms: 2 } }],
    ['a window that is not a time', { since: 'then' }],
    ['a bucket without its time', { buckets: [{ delivered: 1, failed: 0, pending: 0 }] }],
    [
      'more than 168 buckets',
      {
        buckets: Array.from({ length: 169 }, (_, n) => ({
          from: n,
          delivered: 0,
          failed: 0,
          pending: 0,
          avgLatencyMs: null,
          p95LatencyMs: null,
        })),
      },
    ],
  ])('refuses %s', (_label, over) => {
    expect(() => parse(over)).toThrow('Malformed webhook stats response.');
  });

  test('refuses an answer that is not the envelope', () => {
    expect(() => parseWebhookStatsPayload({ ok: true })).toThrow(/Malformed/);
    expect(() => parseWebhookStatsPayload({ ok: false, data: { stats: stats() } })).toThrow(
      /Malformed/
    );
  });
});

describe('webhook deliveries payload', () => {
  test('accepts a page with a cursor, and an empty one', () => {
    expect(parseWebhookDeliveriesPayload(page([delivery()], '6')).data.next).toBe('6');
    expect(parseWebhookDeliveriesPayload(page([])).data.deliveries).toEqual([]);
  });

  test('keeps the job a queue route made, and refuses one that is not text', () => {
    const [made] = parseWebhookDeliveriesPayload(
      page([delivery({ routedJobId: 'qcloud-route-7' })])
    ).data.deliveries;
    expect(made!.routedJobId).toBe('qcloud-route-7');
    expect(() => parseWebhookDeliveriesPayload(page([delivery({ routedJobId: 7 })]))).toThrow(
      /Malformed/
    );
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
