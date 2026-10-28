import type { Json } from './shared';

const NOW = Date.parse('2026-03-14T17:30:00Z');
const MINUTE = 60_000;

const attempt = (
  n: number,
  ago: number,
  statusCode: number | null,
  error: string | null
): Json => ({
  attempt: n,
  at: NOW - ago,
  durationMs: 120 + n * 7,
  statusCode,
  error,
});

/** Three deliveries of the demo's one webhook: one that needed retries, one given up, one waiting. */
const DELIVERIES: readonly Json[] = [
  {
    id: '3',
    webhookId: '',
    event: 'webhook.test',
    requestId: null,
    occurredAt: NOW - MINUTE,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW,
    lastStatusCode: null,
    lastError: null,
    history: [],
    createdAt: NOW - MINUTE,
    finishedAt: null,
  },
  {
    id: '2',
    webhookId: '',
    event: 'request.received',
    requestId: '4821',
    occurredAt: NOW - 90 * MINUTE,
    status: 'failed',
    attempts: 3,
    nextAttemptAt: NOW - 60 * MINUTE,
    lastStatusCode: null,
    lastError: 'connection failed',
    history: [
      attempt(1, 90 * MINUTE, 502, 'receiver answered 502'),
      attempt(2, 89 * MINUTE, null, 'receiver did not answer in time'),
      attempt(3, 87 * MINUTE, null, 'connection failed'),
    ],
    createdAt: NOW - 90 * MINUTE,
    finishedAt: NOW - 87 * MINUTE,
  },
  {
    id: '1',
    webhookId: '',
    event: 'request.received',
    requestId: '4820',
    occurredAt: NOW - 120 * MINUTE,
    status: 'delivered',
    attempts: 3,
    nextAttemptAt: NOW - 118 * MINUTE,
    lastStatusCode: 200,
    lastError: null,
    history: [
      attempt(1, 120 * MINUTE, 500, 'receiver answered 500'),
      attempt(2, 119 * MINUTE, 503, 'receiver answered 503'),
      attempt(3, 117 * MINUTE, 200, null),
    ],
    createdAt: NOW - 120 * MINUTE,
    finishedAt: NOW - 117 * MINUTE,
  },
];

const DEMO_WEBHOOK = '019f252c-f5e3-7000-883c-28cc5dc157a0';

/** `GET /webhooks/deliveries`: the demo's one route, filtered by `status` and `webhook`; one page. */
export function demoAllWebhookDeliveries(search: string): Json {
  const webhook = new URLSearchParams(search).get('webhook');
  return webhook === null || webhook === DEMO_WEBHOOK
    ? demoWebhookDeliveries(DEMO_WEBHOOK, search)
    : { ok: true, data: { deliveries: [], next: null } };
}

/** `GET /webhooks/stats`: a fixed sample shaped to the asked window and bucket count. */
export function demoWebhookStats(search: string): Json {
  const query = new URLSearchParams(search);
  const until = Number(query.get('until')) || NOW;
  const since = Number(query.get('since')) || until - 24 * 60 * MINUTE;
  const count = Number(query.get('buckets')) || 24;
  const bucketMs = Math.ceil((until - since) / count);
  const buckets = Array.from({ length: count }, (_, index) => ({
    from: since + index * bucketMs,
    delivered: index % 3 === 0 ? 2 : 1,
    failed: index % 5 === 0 ? 1 : 0,
    pending: index === count - 1 ? 1 : 0,
    avgLatencyMs: 140 + index * 3,
    p95LatencyMs: 220 + index * 5,
  }));
  const sum = (key: 'delivered' | 'failed' | 'pending') =>
    buckets.reduce((total, bucket) => total + bucket[key], 0);
  const delivered = sum('delivered');
  const failed = sum('failed');
  return {
    ok: true,
    data: {
      stats: {
        since,
        until,
        bucketMs,
        delivered,
        failed,
        pending: sum('pending'),
        failureRatio: failed / (delivered + failed),
        avgAttempts: 1.4,
        backlog: 1,
        oldestPendingAt: until - MINUTE,
        latency: { avgMs: 162, p95Ms: 281, maxMs: 640 },
        buckets,
      },
    },
  };
}

/** `GET /webhooks/:id/deliveries`, filtered by `status`; the demo has one page. */
export function demoWebhookDeliveries(id: string, search: string): Json {
  const status = new URLSearchParams(search).get('status');
  const deliveries = DELIVERIES.filter((row) => status === null || row.status === status).map(
    (row) => ({ ...row, webhookId: id, routedJobId: null })
  );
  return { ok: true, data: { deliveries, next: null } };
}

/** The deliveries a request made, for `GET /requests/:id`: the demo's one route sends over HTTP. */
export const demoRequestDeliveries = (requestId: string): Json[] =>
  DELIVERIES.filter((row) => row.requestId === requestId).map((row) => ({
    ...row,
    webhookId: DEMO_WEBHOOK,
    routedJobId: null,
    via: 'http',
  }));
