import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { Telemetry } from './telemetry';
import { sendUnit, unitsOf } from './webhookBatchSend';
import type { WebhookSenderConfig } from './webhookConfig';
import type { Destinations } from './webhookDestinations';
import type { Enqueue } from './webhookEnqueue';
import type { PostFunction } from './webhookHttp';
import { postOverSocket } from './webhookPool';
import type { Resolver, SendDeps } from './webhookSend';
import { systemResolver } from './webhookSend';

/**
 * The webhook step of a tick pass: claim due deliveries, send them, record what came of each.
 * Network I/O belongs here and not in the store, which only hands deliveries out and takes results
 * back (`store.webhooks.claimDue` and `record`).
 *
 * Deliveries are claimed in chunks of `concurrency` requests (a batch route's deliveries are one request, D15), each chunk
 * sent in parallel and recorded in one transaction, until `batch` requests are done, the budget is spent or nothing is due. Sending is bounded by
 * the claim's lease: a chunk's requests all end within `timeoutMs`, and the lease outlasts that, so
 * a delivery is never in two senders' hands unless one of them died.
 *
 * This is the tick's step: a pass of a few hundred deliveries a minute, one connection per delivery.
 * Volume wants the sender as a process of its own (`webhookLoop.ts`, `qcloud-tick send`), which
 * pools connections, caches names and keeps a breaker per destination (see docs/webhooks.md).
 */

/** Counts only, like the rest of the tick's reports. */
export interface WebhookStepReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  /** Results the store no longer accepted: the claim lapsed and another attempt owns the delivery. */
  readonly stale: number;
  /** Webhooks this step paused, their failed deliveries in a row having reached `disableAfter`. */
  readonly paused: number;
  /** The sender could not talk to the store (claim or record failed). Receivers failing is not an error here. */
  readonly errors: number;
}

export const NO_WEBHOOKS: WebhookStepReport = {
  claimed: 0,
  delivered: 0,
  retrying: 0,
  failed: 0,
  stale: 0,
  paused: 0,
  errors: 0,
};

export function addWebhooks(a: WebhookStepReport, b: WebhookStepReport): WebhookStepReport {
  return {
    claimed: a.claimed + b.claimed,
    delivered: a.delivered + b.delivered,
    retrying: a.retrying + b.retrying,
    failed: a.failed + b.failed,
    stale: a.stale + b.stale,
    paused: a.paused + b.paused,
    errors: a.errors + b.errors,
  };
}

/** What the tick is given to send webhooks: the settings, and the network seams tests replace. */
export interface WebhookSending {
  readonly config: WebhookSenderConfig;
  readonly resolve?: Resolver;
  readonly post?: PostFunction;
  /** Per-destination concurrency and breaker (`qcloud-tick send` only). */
  readonly destinations?: Destinations;
  /** Extra trusted CA (PEM) for https receivers behind a private CA. */
  readonly ca?: string;
  readonly now?: () => number;
}

export interface WebhookStepResult extends WebhookStepReport {
  /** The batch or the budget ended the step with deliveries possibly still due. */
  readonly moreWork: boolean;
}

/** What `sendDelivery` is given: the settings, with the seams filled in, and the store's `enqueue` for queue routes. */
export function sendDepsOf(sending: WebhookSending, enqueue?: Enqueue): SendDeps {
  const { config } = sending;
  return {
    urlPolicy: config.urlPolicy,
    resolve: sending.resolve ?? systemResolver,
    post: sending.post ?? postOverSocket,
    timeoutMs: config.timeoutMs,
    captureBytes: config.responseBytes,
    userAgent: config.userAgent,
    now: sending.now ?? Date.now,
    ...(sending.destinations === undefined ? {} : { destinations: sending.destinations }),
    ...(sending.ca === undefined ? {} : { ca: sending.ca }),
    ...(enqueue === undefined ? {} : { enqueue }),
  };
}

/** Never throws: a store error is counted in `errors` and reported to telemetry. */
export async function sendDueWebhooks(
  store: Pick<PostgresStore, 'webhooks' | 'enqueue'>,
  sending: WebhookSending,
  telemetry: Telemetry
): Promise<WebhookStepResult> {
  const { config } = sending;
  const deps = sendDepsOf(sending, (jobs) => store.enqueue(jobs));
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
      const units = unitsOf(claimed);
      remaining -= units.length;
      const outcomes = (await Promise.all(units.map((unit) => sendUnit(unit, deps)))).flat();
      const summary = await store.webhooks.record(outcomes, config.retry);
      total = addWebhooks(total, {
        claimed: claimed.length,
        delivered: summary.delivered,
        retrying: summary.retrying,
        failed: summary.failed,
        stale: summary.stale,
        paused: summary.paused,
        errors: 0,
      });
      // A short claim took everything that was due (or everything the rate limit allowed).
      if (units.length < take) break;
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
