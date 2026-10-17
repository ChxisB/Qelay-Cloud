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
    queue: 'webhook-test',
    jobId: 'webhook-test',
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
    event: 'job.failed',
    queue: 'emails',
    jobId: 'job-4821',
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
    event: 'job.completed',
    queue: 'emails',
    jobId: 'job-4820',
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

/** `GET /webhooks/:id/deliveries`, filtered by `status`; the demo has one page. */
export function demoWebhookDeliveries(id: string, search: string): Json {
  const status = new URLSearchParams(search).get('status');
  const deliveries = DELIVERIES.filter((row) => status === null || row.status === status).map(
    (row) => ({ ...row, webhookId: id })
  );
  return { ok: true, data: { deliveries, next: null } };
}
