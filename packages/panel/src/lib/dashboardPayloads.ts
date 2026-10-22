import type { WebhookAttemptFull, WebhookDeliveryFull } from './bq/types';
import type { QueueSummaryFull, WebhookFull, WorkerFull } from './bqTypes';
import { routeFields } from './gatewayPayloads';
import {
  count,
  finiteNumber,
  optionalText,
  payloadData,
  record,
  stringList,
  text,
  timestamp,
} from './payloadChecks';

const MAX_COLLECTION_ROWS = 10_000;
const MAX_QUEUE_REFS = 1_000;
const WEBHOOK_EVENT_SET = new Set([
  'job.pushed',
  'job.started',
  'job.completed',
  'job.failed',
  'job.progress',
  // v2.9.3 keeps this legacy value readable in persisted registries even
  // though new registrations cannot request it and the server never emits it.
  'job.stalled',
]);

/** `/queues/summary` is a bare array in v2.9.3, so validate it explicitly. */
export function parseQueueSummaryPayload(value: unknown): QueueSummaryFull[] {
  // v2.9.3 returns every queue from this endpoint and defines no upper bound.
  // response.json() has already materialized the allocation here, so rejecting
  // a valid 10,001st row only makes the dashboard semantically incorrect.
  if (!Array.isArray(value)) {
    throw new Error('Malformed queue summary response.');
  }
  const names = new Set<string>();
  const summary: QueueSummaryFull[] = [];
  for (const candidate of value) {
    const queue = record(candidate);
    const counts = queue && record(queue.counts);
    if (
      !queue ||
      !text(queue.name, 256) ||
      names.has(queue.name) ||
      typeof queue.paused !== 'boolean' ||
      !counts ||
      !count(counts.waiting) ||
      !count(counts.prioritized) ||
      !count(counts.active) ||
      !count(counts.completed) ||
      !count(counts.failed) ||
      !count(counts.delayed)
    ) {
      throw new Error('Malformed queue summary response.');
    }
    names.add(queue.name);
    summary.push(candidate as QueueSummaryFull);
  }
  return summary;
}

export interface WorkersPayload {
  ok: true;
  data: { workers: WorkerFull[]; quarantinedWorkers: WorkerPayloadIssue[]; stats?: unknown };
}

export interface WorkerPayloadIssue {
  index: number;
  id: string | null;
  reason: string;
}

/** Validate every render-relevant worker field before the table consumes it. */
export function parseWorkersPayload(value: unknown): WorkersPayload {
  const data = payloadData(value, 'workers');
  if (!Array.isArray(data.workers) || data.workers.length > MAX_COLLECTION_ROWS) {
    throw new Error('Malformed workers response.');
  }
  const ids = new Set<string>();
  const workers: WorkerFull[] = [];
  const quarantinedWorkers: WorkerPayloadIssue[] = [];
  for (let index = 0; index < data.workers.length; index++) {
    const candidate = data.workers[index];
    const worker = record(candidate);
    const id = worker && typeof worker.id === 'string' ? worker.id : null;
    const issues: string[] = [];
    if (!worker) issues.push('entry is not an object');
    else {
      if (!text(worker.id, 1_024)) issues.push('id');
      else if (ids.has(worker.id)) issues.push('duplicate id');
      if (!text(worker.name, 512, true)) issues.push('name');
      if (!stringList(worker.queues, MAX_QUEUE_REFS, 256)) issues.push('queues');
      if (!count(worker.concurrency) || worker.concurrency < 1) issues.push('concurrency');
      if (!text(worker.hostname, 512, true)) issues.push('hostname');
      if (!count(worker.pid)) issues.push('pid');
      if (worker.status !== 'active' && worker.status !== 'stale') issues.push('status');
      if (!timestamp(worker.registeredAt)) issues.push('registeredAt');
      if (!timestamp(worker.lastSeen)) issues.push('lastSeen');
      if (!count(worker.activeJobs)) issues.push('activeJobs');
      if (!count(worker.processedJobs)) issues.push('processedJobs');
      if (!count(worker.failedJobs)) issues.push('failedJobs');
      if (!optionalText(worker.currentJob, 1_024)) issues.push('currentJob');
      // registeredAt is supplied by the worker clock, while uptime is derived
      // by the server clock. A valid v2.9.3 worker can therefore be negative.
      if (!finiteNumber(worker.uptime)) issues.push('uptime');
    }
    if (id) ids.add(id);
    if (issues.length > 0) {
      quarantinedWorkers.push({ index, id, reason: issues.join(', ') });
      continue;
    }
    workers.push(candidate as WorkerFull);
  }
  return {
    ok: true,
    data: {
      workers,
      quarantinedWorkers,
      ...(Object.hasOwn(data, 'stats') ? { stats: data.stats } : {}),
    },
  };
}

export interface WebhooksPayload {
  ok: true;
  data: { webhooks: WebhookFull[]; stats?: unknown };
}

export function upstreamWebhookUrl(value: unknown): value is string {
  if (!text(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reject hostile 2xx webhook registries instead of crashing or lying in UI. */
export function parseWebhooksPayload(value: unknown): WebhooksPayload {
  const data = payloadData(value, 'webhooks');
  if (!Array.isArray(data.webhooks) || data.webhooks.length > MAX_COLLECTION_ROWS) {
    throw new Error('Malformed webhooks response.');
  }
  const ids = new Set<string>();
  const webhooks: WebhookFull[] = [];
  for (const candidate of data.webhooks) {
    const webhook = record(candidate);
    const route = webhook && routeFields(webhook);
    if (
      !webhook ||
      !route ||
      !text(webhook.id, 1_024) ||
      ids.has(webhook.id) ||
      !(route.destination === 'queue' ? webhook.url === '' : upstreamWebhookUrl(webhook.url)) ||
      typeof webhook.urlRedacted !== 'boolean' ||
      typeof webhook.signed !== 'boolean' ||
      !Array.isArray(webhook.events) ||
      !webhook.events.every((event) => WEBHOOK_EVENT_SET.has(event)) ||
      !(webhook.queue === null || typeof webhook.queue === 'string') ||
      !timestamp(webhook.createdAt) ||
      !(webhook.lastTriggered === null || timestamp(webhook.lastTriggered)) ||
      !count(webhook.successCount) ||
      !count(webhook.failureCount) ||
      typeof webhook.enabled !== 'boolean'
    ) {
      throw new Error('Malformed webhooks response.');
    }
    ids.add(webhook.id);
    webhooks.push({ ...(candidate as WebhookFull), ...route });
  }
  return {
    ok: true,
    data: { webhooks, ...(Object.hasOwn(data, 'stats') ? { stats: data.stats } : {}) },
  };
}

const DELIVERY_STATUSES = new Set(['pending', 'sending', 'delivered', 'failed']);
const MAX_DELIVERY_ROWS = 200;
/** The store keeps at most 20 attempts of a delivery; a few more are tolerated, not unbounded. */
const MAX_ATTEMPT_ROWS = 64;
const DELIVERY_NUMBER = /^[1-9]\d{0,15}$/u;

function httpStatus(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
  );
}

function attemptList(value: unknown): value is WebhookAttemptFull[] {
  if (!Array.isArray(value) || value.length > MAX_ATTEMPT_ROWS) return false;
  return value.every((entry) => {
    const attempt = record(entry);
    return (
      attempt !== null &&
      count(attempt.attempt) &&
      timestamp(attempt.at) &&
      count(attempt.durationMs) &&
      httpStatus(attempt.statusCode) &&
      optionalText(attempt.error, 512)
    );
  });
}

function wellFormedDelivery(delivery: Record<string, unknown>): boolean {
  return (
    typeof delivery.id === 'string' &&
    DELIVERY_NUMBER.test(delivery.id) &&
    text(delivery.webhookId, 1_024) &&
    text(delivery.event, 64) &&
    text(delivery.queue, 256) &&
    text(delivery.jobId, 1_024) &&
    (delivery.routedJobId === undefined || optionalText(delivery.routedJobId, 1_024)) &&
    timestamp(delivery.occurredAt) &&
    typeof delivery.status === 'string' &&
    DELIVERY_STATUSES.has(delivery.status) &&
    count(delivery.attempts) &&
    timestamp(delivery.nextAttemptAt) &&
    httpStatus(delivery.lastStatusCode) &&
    optionalText(delivery.lastError, 512) &&
    attemptList(delivery.history) &&
    timestamp(delivery.createdAt) &&
    (delivery.finishedAt === null || timestamp(delivery.finishedAt))
  );
}

export interface WebhookDeliveriesPayload {
  ok: true;
  data: { deliveries: WebhookDeliveryFull[]; next: string | null };
}

/** One page of a webhook's delivery history: every field the table renders is checked first. */
export function parseWebhookDeliveriesPayload(value: unknown): WebhookDeliveriesPayload {
  const data = payloadData(value, 'webhook deliveries');
  if (
    !Array.isArray(data.deliveries) ||
    data.deliveries.length > MAX_DELIVERY_ROWS ||
    !(data.next === null || (typeof data.next === 'string' && DELIVERY_NUMBER.test(data.next)))
  ) {
    throw new Error('Malformed webhook deliveries response.');
  }
  const ids = new Set<string>();
  for (const candidate of data.deliveries) {
    const delivery = record(candidate);
    if (!delivery || !wellFormedDelivery(delivery) || ids.has(delivery.id as string)) {
      throw new Error('Malformed webhook deliveries response.');
    }
    ids.add(delivery.id as string);
  }
  return {
    ok: true,
    data: { deliveries: data.deliveries as WebhookDeliveryFull[], next: data.next },
  };
}
