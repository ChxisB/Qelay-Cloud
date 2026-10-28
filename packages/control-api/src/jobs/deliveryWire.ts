import { routeJobId } from '@qelay-cloud/core';
import type { AttemptRecord, WebhookDestination } from '@qelay-cloud/core';
import type { DeliveryRecord } from '@qelay-cloud/store-postgres';

/** A delivery as the Control API shows it (`GET /webhooks/:id/deliveries`, a source's request, a retry). */

export interface DeliveryWire {
  readonly id: string;
  readonly webhookId: string;
  readonly event: string;
  /** The inbound request it carries (D14); null for a test delivery. */
  readonly requestId: string | null;
  /** The job a delivered `queue` route made in its target queue; null for `http` and until it is delivered. */
  readonly routedJobId: string | null;
  readonly occurredAt: number;
  readonly status: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly history: readonly AttemptRecord[];
  readonly createdAt: number;
  readonly finishedAt: number | null;
  /** The batch the latest attempt went out in (D15); null when it was sent alone. */
  readonly batchId: string | null;
}

/**
 * A delivery names no URL and no secret; its errors are the fixed sentences the sender writes. `via` is
 * its route's destination: the store keeps no answer on a success, so a queue route's job is named
 * from the delivery id (core's `routeJobId`).
 */
export function toDeliveryWire(
  delivery: DeliveryRecord,
  via: WebhookDestination = 'http'
): DeliveryWire {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
    requestId: delivery.requestId,
    routedJobId:
      via === 'queue' && delivery.status === 'delivered' ? routeJobId(delivery.id) : null,
    occurredAt: delivery.occurredAt,
    status: delivery.status,
    attempts: delivery.attempts,
    nextAttemptAt: delivery.nextAttemptAt,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    history: delivery.history,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
    batchId: delivery.batchId,
  };
}
