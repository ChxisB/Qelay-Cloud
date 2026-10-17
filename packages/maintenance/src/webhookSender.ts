import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { Telemetry } from './telemetry';
import type { WebhookSenderConfig } from './webhookConfig';
import type { PostFunction } from './webhookHttp';
import { postOverSocket } from './webhookHttp';
import type { Resolver } from './webhookSend';
import { sendDelivery, systemResolver } from './webhookSend';

/**
 * The webhook step of a tick pass: claim due deliveries, send them, record what came of each.
 * Network I/O belongs here and not in the store, which only hands deliveries out and takes results
 * back (`store.webhooks.claimDue` and `record`).
 *
 * Deliveries are claimed in chunks of `concurrency`, each chunk sent in parallel and recorded in one
 * transaction, until `batch` are done, the budget is spent or nothing is due. Sending is bounded by
 * the claim's lease: a chunk's requests all end within `timeoutMs`, and the lease outlasts that, so
 * a delivery is never in two senders' hands unless one of them died.
 *
 * This is for operator-scale volume (a few hundred deliveries a minute). Fan-out beyond that wants
 * its own delivery queue run by the SDK, not the tick (see docs/webhooks.md).
 */

/** Counts only, like the rest of the tick's reports. */
export interface WebhookStepReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  /** Results the store no longer accepted: the claim lapsed and another attempt owns the delivery. */
  readonly stale: number;
  /** The sender could not talk to the store (claim or record failed). Receivers failing is not an error here. */
  readonly errors: number;
}

export const NO_WEBHOOKS: WebhookStepReport = {
  claimed: 0,
  delivered: 0,
  retrying: 0,
  failed: 0,
  stale: 0,
  errors: 0,
};

export function addWebhooks(a: WebhookStepReport, b: WebhookStepReport): WebhookStepReport {
  return {
    claimed: a.claimed + b.claimed,
    delivered: a.delivered + b.delivered,
    retrying: a.retrying + b.retrying,
    failed: a.failed + b.failed,
    stale: a.stale + b.stale,
    errors: a.errors + b.errors,
  };
}

/** What the tick is given to send webhooks: the settings, and the network seams tests replace. */
export interface WebhookSending {
  readonly config: WebhookSenderConfig;
  readonly resolve?: Resolver;
  readonly post?: PostFunction;
  /** Extra trusted CA (PEM) for https receivers behind a private CA. */
  readonly ca?: string;
  readonly now?: () => number;
}

export interface WebhookStepResult extends WebhookStepReport {
  /** The batch or the budget ended the step with deliveries possibly still due. */
  readonly moreWork: boolean;
}

/** Never throws: a store error is counted in `errors` and reported to telemetry. */
export async function sendDueWebhooks(
  store: Pick<PostgresStore, 'webhooks'>,
  sending: WebhookSending,
  telemetry: Telemetry
): Promise<WebhookStepResult> {
  const { config } = sending;
  const deps = {
    urlPolicy: config.urlPolicy,
    resolve: sending.resolve ?? systemResolver,
    post: sending.post ?? postOverSocket,
    timeoutMs: config.timeoutMs,
    now: sending.now ?? Date.now,
    ...(sending.ca === undefined ? {} : { ca: sending.ca }),
  };
  const started = performance.now();
  let total = NO_WEBHOOKS;
  let remaining = config.batch;
  let moreWork = false;
  try {
    while (remaining > 0) {
      const take = Math.min(config.concurrency, remaining);
      const claimed = await store.webhooks.claimDue({
        limit: take,
        leaseMs: config.leaseMs,
        ratePerMinute: config.ratePerMinute,
      });
      if (claimed.length === 0) break;
      remaining -= claimed.length;
      const outcomes = await Promise.all(claimed.map((delivery) => sendDelivery(delivery, deps)));
      const summary = await store.webhooks.record(outcomes, config.retry);
      total = addWebhooks(total, {
        claimed: claimed.length,
        delivered: summary.delivered,
        retrying: summary.retrying,
        failed: summary.failed,
        stale: summary.stale,
        errors: 0,
      });
      // A short claim took everything that was due (or everything the rate limit allowed).
      if (claimed.length < take) break;
      if (remaining === 0 || performance.now() - started >= config.budgetMs) {
        moreWork = true;
        break;
      }
    }
  } catch (error) {
    telemetry.error('webhooks', error);
    total = addWebhooks(total, { ...NO_WEBHOOKS, errors: 1 });
  }
  telemetry.duration('webhooks', Math.round(performance.now() - started));
  return { ...total, moreWork };
}
