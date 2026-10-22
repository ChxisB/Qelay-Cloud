import type { WebhookDedupeFull } from './bq/gatewayTypes';
import type { WebhookStatsBucketFull, WebhookStatsFull } from './bq/types';
import type { WebhookFull } from './bqTypes';
import {
  count,
  finiteNumber,
  multilineText,
  optionalText,
  payloadData,
  record,
  stringList,
  text,
  timestamp,
} from './payloadChecks';

type RouteFields = Pick<
  WebhookFull,
  | 'destination'
  | 'target'
  | 'consecutiveFailures'
  | 'alertLevel'
  | 'disabledReason'
  | 'disabledAt'
  | 'filter'
  | 'shape'
  | 'name'
  | 'description'
  | 'delayMs'
  | 'dedupe'
  | 'pausedBy'
  | 'destinationId'
>;

const ruleOrNull = (value: unknown): value is Record<string, unknown> | null =>
  value === null || record(value) !== null;

/** A dedupe as the server holds it, or null for none. */
function dedupeOf(value: unknown): WebhookDedupeFull | null | undefined {
  if (value === null) return null;
  const dedupe = record(value);
  return dedupe &&
    count(dedupe.windowMs) &&
    stringList(dedupe.fields, 5, 16) &&
    dedupe.fields.length > 0
    ? { windowMs: dedupe.windowMs, fields: dedupe.fields }
    : undefined;
}

/**
 * What a route adds to a webhook: where it delivers, its failure streak, its rules and its name. A server that
 * predates a field sends none of it, and that reads as the field's default: an http webhook, nothing to report,
 * no name, no delay. Null when a field that is there is not what the page renders.
 */
export function routeFields(webhook: Record<string, unknown>): RouteFields | null {
  const destination = webhook.destination ?? 'http';
  const target = (webhook.target ?? null) as string | null; // checked below
  const streak = webhook.consecutiveFailures ?? 0;
  const level = webhook.alertLevel ?? 0;
  const reason = webhook.disabledReason ?? null;
  const at = webhook.disabledAt ?? null;
  const filter = webhook.filter ?? null;
  const shape = webhook.shape ?? null;
  const name = webhook.name ?? null;
  const description = webhook.description ?? null;
  const delayMs = webhook.delayMs ?? null;
  const dedupe = dedupeOf(webhook.dedupe ?? null);
  // A server before `pausedBy` paused only for failing: an off route with a reason was that.
  const pausedBy =
    webhook.pausedBy ?? (webhook.enabled === false && reason !== null ? 'failures' : null);
  const destinationId = webhook.destinationId ?? null;
  if (
    (destination !== 'http' && destination !== 'queue') ||
    !(destination === 'queue' ? text(target, 256) : target === null) ||
    !count(streak) ||
    !count(level) ||
    level > 4 ||
    !optionalText(reason, 512) ||
    !(at === null || timestamp(at)) ||
    !ruleOrNull(filter) ||
    !ruleOrNull(shape) ||
    !(name === null || text(name, 1_000)) ||
    !(description === null || multilineText(description, 5_000)) ||
    !(delayMs === null || count(delayMs)) ||
    dedupe === undefined ||
    (pausedBy !== null && pausedBy !== 'operator' && pausedBy !== 'failures') ||
    !(destinationId === null || text(destinationId, 1_024))
  ) {
    return null;
  }
  return {
    destination,
    target,
    consecutiveFailures: streak,
    alertLevel: level,
    disabledReason: reason,
    disabledAt: at,
    filter,
    shape,
    name,
    description,
    delayMs,
    dedupe,
    pausedBy,
    destinationId,
  };
}

const MAX_BUCKETS = 168;
const nullableNumber = (value: unknown): value is number | null =>
  value === null || (finiteNumber(value) && value >= 0);

function bucketOf(value: unknown): value is WebhookStatsBucketFull {
  const bucket = record(value);
  return (
    bucket !== null &&
    timestamp(bucket.from) &&
    count(bucket.delivered) &&
    count(bucket.failed) &&
    count(bucket.pending) &&
    nullableNumber(bucket.avgLatencyMs) &&
    nullableNumber(bucket.p95LatencyMs)
  );
}

export interface WebhookStatsPayload {
  ok: true;
  data: { stats: WebhookStatsFull };
}

/** The Metrics screen's numbers: every figure a card or a chart draws is checked first. */
export function parseWebhookStatsPayload(value: unknown): WebhookStatsPayload {
  const data = payloadData(value, 'webhook stats');
  const stats = record(data.stats);
  const latency = stats && (stats.latency === null ? null : record(stats.latency));
  if (
    !stats ||
    latency === undefined ||
    !timestamp(stats.since) ||
    !timestamp(stats.until) ||
    !count(stats.bucketMs) ||
    !count(stats.delivered) ||
    !count(stats.failed) ||
    !count(stats.pending) ||
    !nullableNumber(stats.failureRatio) ||
    !nullableNumber(stats.avgAttempts) ||
    !count(stats.backlog) ||
    !(stats.oldestPendingAt === null || timestamp(stats.oldestPendingAt)) ||
    (latency !== null &&
      !(
        finiteNumber(latency.avgMs) &&
        finiteNumber(latency.p95Ms) &&
        finiteNumber(latency.maxMs)
      )) ||
    !Array.isArray(stats.buckets) ||
    stats.buckets.length > MAX_BUCKETS ||
    !stats.buckets.every(bucketOf)
  ) {
    throw new Error('Malformed webhook stats response.');
  }
  return { ok: true, data: { stats: stats as unknown as WebhookStatsFull } };
}
