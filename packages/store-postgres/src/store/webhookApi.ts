import type { DeliveryPolicy, WebhookIssueStatus, WebhookPauseMode } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { claimDueDeliveries } from './webhookClaim';
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  updateDestination,
} from './webhookDestinations';
import type {
  DestinationPatch,
  DestinationRecord,
  DestinationSpec,
} from './webhookDestinationTypes';
import { listAllDeliveries, retryFailedDeliveries } from './webhookFeed';
import { webhookGroupStats } from './webhookGroupStats';
import { listDeliveries, retryDelivery } from './webhookHistory';
import { issueCounts, listIssues, setIssueStatus } from './webhookIssues';
import type { IssueCounts, IssuePage, IssueQuery, IssueResult } from './webhookIssueTypes';
import { recordAttempts } from './webhookRecord';
import type { WebhookRetention } from './webhookRetention';
import { pruneWebhookDeliveries } from './webhookRetention';
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  sendWebhookTest,
  setWebhookEnabled,
} from './webhooks';
import { rotateWebhookSecret } from './webhookSecret';
import { webhookStats } from './webhookStats';
import type {
  AllDeliveriesQuery,
  AttemptOutcome,
  ClaimedDelivery,
  ClaimOptions,
  DeliveryPage,
  DeliveryQuery,
  DeliveryRecord,
  GroupStatsQuery,
  RecordSummary,
  RetryFailedOptions,
  RetryResult,
  StatsQuery,
  WebhookGroupStats,
  WebhookIssued,
  WebhookPatch,
  WebhookRecord,
  WebhookSpec,
  WebhookStats,
  WriteOptions,
  WriterState,
  WriteResult,
} from './webhookTypes';
import { updateWebhook } from './webhookUpdate';
import {
  startWebhookWriter,
  stopWebhookWriter,
  webhookWriterState,
  writeWebhookDeliveries,
} from './webhookWriter';

/** Webhooks (`store.webhooks`): the operator's side, and the calls the sender makes. See `webhooks.ts` and `webhookClaim.ts`. */
export interface WebhookApi {
  /**
   * Registers a webhook. `createdBy` is the operator's subject. Throws `WebhookLimitError` at the
   * per-namespace cap and `WebhookKeyError` for a secret when the store has no `webhookKey`. With a
   * key and no secret in the spec, the webhook gets a generated one, returned once in `secret`.
   */
  create(spec: WebhookSpec, createdBy: string): Promise<WebhookIssued>;
  list(): Promise<WebhookRecord[]>;
  get(id: string): Promise<WebhookRecord | null>;
  /**
   * Turns it on or off; off is `ignore` (nothing is collected) unless `mode` is `hold` (events are collected and
   * sent on resume). Null when there is no such webhook.
   */
  setEnabled(id: string, enabled: boolean, mode?: WebhookPauseMode): Promise<WebhookRecord | null>;
  /**
   * Changes the name, description, events and rules the patch names (`WebhookPatch`). Throws
   * `UnsupportedOptionError` for an empty or invalid patch, or a writer-only rule without the writer. Null when
   * there is no such webhook.
   */
  update(id: string, patch: WebhookPatch): Promise<WebhookRecord | null>;
  /**
   * Gives the webhook a new signing secret (the one given, or a generated one returned once). The old
   * one signs beside it for `WEBHOOK_SECRET_GRACE_MS`. Null when there is no such webhook;
   * `WebhookKeyError` without a `webhookKey`.
   */
  rotateSecret(id: string, secret?: string | null): Promise<WebhookIssued | null>;
  /** Deletes the webhook and its deliveries. False when there was none. */
  delete(id: string): Promise<boolean>;
  /** Queues a `webhook.test` delivery. Null for no such webhook; throws `WebhookDisabledError` when it is off. */
  sendTest(id: string): Promise<DeliveryRecord | null>;
  /** Newest first. Null when there is no such webhook. */
  deliveries(id: string, query?: DeliveryQuery): Promise<DeliveryPage | null>;
  /** Puts a failed delivery back with a full budget of attempts. */
  retry(id: string, deliveryId: string): Promise<RetryResult>;
  /** Deliveries of every webhook, newest first; the console's Events screen. */
  deliveriesAll(query?: AllDeliveriesQuery): Promise<DeliveryPage>;
  /**
   * Puts a webhook's failed deliveries back with a full budget of attempts, newest first, at most
   * `MAX_BULK_RETRY`. Null when there is no such webhook, else how many went back.
   */
  retryFailed(
    id: string,
    options?: RetryFailedOptions
  ): Promise<{ readonly retried: number } | null>;
  /** Deliveries by outcome, latency and backlog over a window of at most seven days; the Metrics and Home screens. */
  stats(query: StatsQuery): Promise<WebhookStats>;
  /** The same counts and trend for every webhook at once, with no latency; the connections list. Every webhook is in the answer. */
  statsByWebhook(query: GroupStatsQuery): Promise<WebhookGroupStats>;
  /** Issues of one status (a route whose deliveries are failing), newest first; the Issues screen. */
  issues(query: IssueQuery): Promise<IssuePage>;
  issueCounts(): Promise<IssueCounts>;
  /** An operator sets an issue's status (`by` is their subject); `resolved` for one that already is, `not_found` for none. */
  setIssueStatus(id: string, status: WebhookIssueStatus, by: string): Promise<IssueResult>;
  /**
   * Saved destinations: a named address webhooks can be made from (`create` with `destinationId`). Saving throws
   * `DestinationNameTakenError` and `DestinationLimitError`; an update copies a new address to every webhook made from the
   * destination, and throws `RouteCycleError` or `RouteChainError` when a queue address would loop; removing one that is
   * used throws `DestinationInUseError`. `getDestination` and `updateDestination` give null, `deleteDestination` false, for none.
   */
  destinations(): Promise<DestinationRecord[]>;
  getDestination(id: string): Promise<DestinationRecord | null>;
  createDestination(spec: DestinationSpec, createdBy: string): Promise<DestinationRecord>;
  updateDestination(id: string, patch: DestinationPatch): Promise<DestinationRecord | null>;
  deleteDestination(id: string): Promise<boolean>;
  /** The sender: takes due deliveries and leases them. */
  claimDue(options: ClaimOptions): Promise<ClaimedDelivery[]>;
  /** The sender: takes back what the attempts came to. */
  record(outcomes: readonly AttemptOutcome[], policy: DeliveryPolicy): Promise<RecordSummary>;
  /** The tick's upkeep: expires stale deliveries and deletes old finished ones, at most `limit` of each. */
  prune(limit: number): Promise<WebhookRetention>;
  /**
   * The delivery writer (`webhookWriter.ts`): one pass makes the deliveries of the next page of journal
   * events, for a namespace that has the writer on. `active: false` when it has not, or another
   * writer holds the cursor.
   */
  writeDeliveries(options?: WriteOptions): Promise<WriteResult>;
  writerState(): Promise<WriterState>;
  /** Switches deliveries from the trigger to the writer, from the journal's end. Safe to repeat. */
  startWriter(): Promise<WriterState>;
  /** Switches back to the trigger without losing an event. Throws while a webhook has a filter, shape, delay or dedupe. */
  stopWriter(options?: WriteOptions): Promise<WriterState>;
}

export const webhookApi = (ctx: StoreContext): WebhookApi => ({
  create: (spec, createdBy) => createWebhook(ctx, spec, createdBy),
  list: () => listWebhooks(ctx),
  get: (id) => getWebhook(ctx, id),
  setEnabled: (id, enabled, mode) => setWebhookEnabled(ctx, id, enabled, mode),
  update: (id, patch) => updateWebhook(ctx, id, patch),
  rotateSecret: (id, secret) => rotateWebhookSecret(ctx, id, secret),
  delete: (id) => deleteWebhook(ctx, id),
  sendTest: (id) => sendWebhookTest(ctx, id),
  deliveries: (id, query) => listDeliveries(ctx, id, query),
  retry: (id, deliveryId) => retryDelivery(ctx, id, deliveryId),
  deliveriesAll: (query) => listAllDeliveries(ctx, query),
  retryFailed: (id, options) => retryFailedDeliveries(ctx, id, options),
  stats: (query) => webhookStats(ctx, query),
  statsByWebhook: (query) => webhookGroupStats(ctx, query),
  issues: (query) => listIssues(ctx, query),
  issueCounts: () => issueCounts(ctx),
  setIssueStatus: (id, status, by) => setIssueStatus(ctx, id, status, by),
  destinations: () => listDestinations(ctx),
  getDestination: (id) => getDestination(ctx, id),
  createDestination: (spec, createdBy) => createDestination(ctx, spec, createdBy),
  updateDestination: (id, patch) => updateDestination(ctx, id, patch),
  deleteDestination: (id) => deleteDestination(ctx, id),
  claimDue: (options) => claimDueDeliveries(ctx, options),
  record: (outcomes, policy) => recordAttempts(ctx, outcomes, policy),
  prune: (limit) => pruneWebhookDeliveries(ctx, limit),
  writeDeliveries: (options) => writeWebhookDeliveries(ctx, options),
  writerState: () => webhookWriterState(ctx),
  startWriter: () => startWebhookWriter(ctx),
  stopWriter: (options) => stopWebhookWriter(ctx, options),
});
