/**
 * Issues (DESIGN.md D13): one record of a route whose deliveries are failing, opened by the first delivery that
 * runs out of attempts and resolved by the next that gets a 2xx. An operator can acknowledge it (seen, being
 * worked on), ignore it (no more attention until it recovers) or resolve it by hand (a new failure opens a new one).
 */

export const WEBHOOK_ISSUE_STATUSES = ['open', 'acknowledged', 'resolved', 'ignored'] as const;
export type WebhookIssueStatus = (typeof WEBHOOK_ISSUE_STATUSES)[number];

/** The statuses of an issue that is still live: a route has at most one, and a recovery resolves it. */
export const LIVE_ISSUE_STATUSES = ['open', 'acknowledged', 'ignored'] as const;

export const WEBHOOK_ISSUE_KINDS = ['delivery_failed'] as const;
export type WebhookIssueKind = (typeof WEBHOOK_ISSUE_KINDS)[number];

export const isWebhookIssueStatus = (value: unknown): value is WebhookIssueStatus =>
  typeof value === 'string' && (WEBHOOK_ISSUE_STATUSES as readonly string[]).includes(value);
