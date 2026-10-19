import type { DeliveryPolicy } from '@qelay-cloud/core';
import type { StoreContext } from './context';
import { claimDueDeliveries } from './webhookClaim';
import { listDeliveries, retryDelivery } from './webhookHistory';
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
import type {
  AttemptOutcome,
  ClaimedDelivery,
  ClaimOptions,
  DeliveryPage,
  DeliveryQuery,
  DeliveryRecord,
  RecordSummary,
  RetryResult,
  WebhookIssued,
  WebhookRecord,
  WebhookSpec,
  WriteOptions,
  WriterState,
  WriteResult,
} from './webhookTypes';
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
  /** Null when there is no such webhook. */
  setEnabled(id: string, enabled: boolean): Promise<WebhookRecord | null>;
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
  /** Switches back to the trigger without losing an event. Throws while a webhook has a filter or shape. */
  stopWriter(options?: WriteOptions): Promise<WriterState>;
}

export const webhookApi = (ctx: StoreContext): WebhookApi => ({
  create: (spec, createdBy) => createWebhook(ctx, spec, createdBy),
  list: () => listWebhooks(ctx),
  get: (id) => getWebhook(ctx, id),
  setEnabled: (id, enabled) => setWebhookEnabled(ctx, id, enabled),
  rotateSecret: (id, secret) => rotateWebhookSecret(ctx, id, secret),
  delete: (id) => deleteWebhook(ctx, id),
  sendTest: (id) => sendWebhookTest(ctx, id),
  deliveries: (id, query) => listDeliveries(ctx, id, query),
  retry: (id, deliveryId) => retryDelivery(ctx, id, deliveryId),
  claimDue: (options) => claimDueDeliveries(ctx, options),
  record: (outcomes, policy) => recordAttempts(ctx, outcomes, policy),
  prune: (limit) => pruneWebhookDeliveries(ctx, limit),
  writeDeliveries: (options) => writeWebhookDeliveries(ctx, options),
  writerState: () => webhookWriterState(ctx),
  startWriter: () => startWebhookWriter(ctx),
  stopWriter: (options) => stopWebhookWriter(ctx, options),
});
