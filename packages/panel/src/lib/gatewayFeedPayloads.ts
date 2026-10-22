import type {
  DestinationFull,
  WebhookGroupBucketFull,
  WebhookGroupStatFull,
  WebhookGroupStatsFull,
  WebhookIssueFull,
  WebhookIssuesPage,
  WebhookIssueStatus,
} from './bq/gatewayTypes';
import { upstreamWebhookUrl } from './dashboardPayloads';
import { count, optionalText, payloadData, record, text, timestamp } from './payloadChecks';

/**
 * The event gateway's own payloads: issues, the connections list's grouped numbers and saved destinations. Each is
 * checked before a screen draws it, as `gatewayPayloads` does for a route, and a malformed one is refused whole.
 */

const ISSUE_STATUSES = new Set<unknown>(['open', 'acknowledged', 'resolved', 'ignored']);
const MAX_ISSUES = 200;
const MAX_GROUPS = 1_000;
const MAX_BUCKETS = 168;
const MAX_DESTINATIONS = 1_000;

const ratio = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);

function issueOf(value: unknown): value is WebhookIssueFull {
  const issue = record(value);
  return (
    issue !== null &&
    text(issue.id, 1_024) &&
    text(issue.webhookId, 1_024) &&
    optionalText(issue.webhookName, 1_000) &&
    ISSUE_STATUSES.has(issue.status) &&
    issue.kind === 'delivery_failed' &&
    timestamp(issue.openedAt) &&
    timestamp(issue.updatedAt) &&
    optionalText(issue.updatedBy, 1_024) &&
    count(issue.consecutiveFailures) &&
    count(issue.alertLevel) &&
    issue.alertLevel <= 4 &&
    (issue.pausedBy === null || issue.pausedBy === 'operator' || issue.pausedBy === 'failures')
  );
}

/** `GET /webhooks/issues`: one page of one status, and the count of every status. */
export function parseWebhookIssuesPayload(value: unknown): WebhookIssuesPage {
  const data = payloadData(value, 'webhook issues');
  const counts = record(data.counts);
  if (
    !Array.isArray(data.issues) ||
    data.issues.length > MAX_ISSUES ||
    !data.issues.every(issueOf) ||
    new Set(data.issues.map((issue) => issue.id)).size !== data.issues.length ||
    !(data.next === null || text(data.next, 32)) ||
    !counts ||
    !Object.keys(counts).every((key) => ISSUE_STATUSES.has(key)) ||
    !([...ISSUE_STATUSES] as WebhookIssueStatus[]).every((status) => count(counts[status]))
  ) {
    throw new Error('Malformed webhook issues response.');
  }
  return {
    issues: data.issues,
    next: data.next,
    counts: counts as WebhookIssuesPage['counts'],
  };
}

/** The answer to a status change: the issue as it is now. */
export function parseWebhookIssuePayload(value: unknown): WebhookIssueFull {
  const data = payloadData(value, 'webhook issue');
  if (!issueOf(data.issue)) throw new Error('Malformed webhook issue response.');
  return data.issue;
}

function bucketOf(value: unknown): value is WebhookGroupBucketFull {
  const bucket = record(value);
  return (
    bucket !== null &&
    timestamp(bucket.from) &&
    count(bucket.delivered) &&
    count(bucket.failed) &&
    count(bucket.pending)
  );
}

function groupOf(value: unknown): value is WebhookGroupStatFull {
  const group = record(value);
  return (
    group !== null &&
    text(group.webhookId, 1_024) &&
    count(group.delivered) &&
    count(group.failed) &&
    count(group.pending) &&
    ratio(group.failureRatio) &&
    count(group.backlog) &&
    (group.oldestPendingAt === null || timestamp(group.oldestPendingAt)) &&
    Array.isArray(group.buckets) &&
    group.buckets.length <= MAX_BUCKETS &&
    group.buckets.every(bucketOf)
  );
}

/** `GET /webhooks/stats?groupBy=webhook`: one entry per route, counts and a trend. */
export function parseWebhookGroupStatsPayload(value: unknown): WebhookGroupStatsFull {
  const data = payloadData(value, 'webhook group stats');
  if (
    !timestamp(data.since) ||
    !timestamp(data.until) ||
    !count(data.bucketMs) ||
    !Array.isArray(data.groups) ||
    data.groups.length > MAX_GROUPS ||
    !data.groups.every(groupOf) ||
    new Set(data.groups.map((group) => group.webhookId)).size !== data.groups.length
  ) {
    throw new Error('Malformed webhook group stats response.');
  }
  return { since: data.since, until: data.until, bucketMs: data.bucketMs, groups: data.groups };
}

function destinationOf(value: unknown): value is DestinationFull {
  const one = record(value);
  if (
    !one ||
    !text(one.id, 1_024) ||
    !text(one.name, 1_000) ||
    typeof one.urlRedacted !== 'boolean' ||
    !count(one.connections) ||
    !timestamp(one.createdAt) ||
    !timestamp(one.updatedAt)
  ) {
    return false;
  }
  return one.kind === 'queue'
    ? one.url === '' && text(one.target, 256)
    : one.kind === 'http' && one.target === null && upstreamWebhookUrl(one.url);
}

/** `GET /webhooks/destinations`. */
export function parseDestinationsPayload(value: unknown): DestinationFull[] {
  const data = payloadData(value, 'destinations');
  if (
    !Array.isArray(data.destinations) ||
    data.destinations.length > MAX_DESTINATIONS ||
    !data.destinations.every(destinationOf) ||
    new Set(data.destinations.map((one) => one.id)).size !== data.destinations.length
  ) {
    throw new Error('Malformed destinations response.');
  }
  return data.destinations;
}

/** The answer to a save or an edit: the destination as it is now. */
export function parseDestinationPayload(value: unknown): DestinationFull {
  const data = payloadData(value, 'destination');
  if (!destinationOf(data.destination)) throw new Error('Malformed destination response.');
  return data.destination;
}
