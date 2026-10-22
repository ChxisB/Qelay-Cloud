import { deliveryBody, QcloudError, routeJobId, WEBHOOK_ERROR_CHARS } from '@qelay-cloud/core';
import type { NewJob } from '@qelay-cloud/core';
import type { AttemptOutcome, ClaimedDelivery } from '@qelay-cloud/store-postgres';

/**
 * A `queue` route's attempt (D11): the delivery becomes a job in the same database, with no network
 * and none of the URL checks, which have nothing to check. The job goes through the store's own
 * `enqueue`, so pause, rate limit, queue limits and group caps apply as they do to any producer.
 *
 * The job's id is `routeJobId` of the delivery id, so an attempt that is repeated (the claim lapsed after
 * the job was added and before the result was recorded) finds that job and adds no second one. The
 * job gets no bell here: the tick's ring pass rings a ready job nobody rang, as it does for a cron's.
 * shortcut: a job removed on completion before a repeated attempt would be made again, which needs
 * the claim's lease to lapse after the job ran to its end; give it a dedup window if that shows up.
 */

export type Enqueue = (jobs: readonly NewJob[]) => Promise<ReadonlyArray<{ readonly id: string }>>;

/** Never rejects: a store refusal is a failed attempt, retried on the route's schedule like a 5xx. */
export async function enqueueDelivery(
  delivery: ClaimedDelivery,
  enqueue: Enqueue | undefined,
  outcome: (ok: boolean, error: string | null) => AttemptOutcome
): Promise<AttemptOutcome> {
  if (enqueue === undefined) return outcome(false, 'this sender cannot add jobs');
  if (delivery.target === null) return outcome(false, 'queue route has no target queue');
  // The delivery writer shapes a body once and stores it; the empty string means it was too large to make.
  if (delivery.body === '') return outcome(false, 'shaped body was too large to make');
  try {
    const body =
      delivery.body ??
      deliveryBody({
        id: delivery.deliveryId,
        event: delivery.event,
        occurredAt: delivery.occurredAt,
        queue: delivery.queue,
        jobId: delivery.jobId,
        state: delivery.state,
        error: delivery.error,
        progress: delivery.progress,
      });
    await enqueue([
      {
        queue: delivery.target,
        name: delivery.event,
        data: JSON.parse(body),
        options: { jobId: routeJobId(delivery.deliveryId) },
      },
    ]);
    return outcome(true, null);
  } catch (error) {
    // Only the store's own refusals (a limit, a full group) are quoted; a driver error could carry data.
    const reason = error instanceof QcloudError ? error.message : 'the store failed';
    return outcome(false, `job was not added: ${reason}`.slice(0, WEBHOOK_ERROR_CHARS));
  }
}
