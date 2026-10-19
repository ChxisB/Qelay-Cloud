import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { Telemetry } from './telemetry';

export interface WritePass {
  /** More journal events are waiting: pass again at once. */
  readonly more: boolean;
  /** Delivery rows made. */
  readonly written: number;
  /** The store failed (reported to telemetry): the caller counts it, and does not stop sending for it. */
  readonly failed: boolean;
}

/**
 * One pass of the delivery writer (`store.webhooks.writeDeliveries`): a namespace that has not
 * switched it on makes no rows and costs one lookup. Both the tick's webhook step and `qcloud-tick
 * send` call it, so either alone is enough to get deliveries made. Never throws.
 *
 * `webhooks.writer_gaps` is 1 when the journal's retention outran the writer: events that were
 * pruned before it read them make no deliveries (the operator's cue to run it more often).
 */
export async function writeOnce(
  store: Pick<PostgresStore, 'webhooks'>,
  telemetry: Telemetry
): Promise<WritePass> {
  try {
    const pass = await store.webhooks.writeDeliveries();
    telemetry.gauge('webhooks.written', pass.written);
    if (pass.gap) telemetry.gauge('webhooks.writer_gaps', 1);
    return { more: pass.more, written: pass.written, failed: false };
  } catch (error) {
    telemetry.error('webhook-writer', error);
    return { more: false, written: 0, failed: true };
  }
}
