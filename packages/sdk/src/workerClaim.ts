import type { ClaimedJob, ClaimOptions, Delivery } from '@qelay-cloud/core';
import { errorMessage } from './errorText';
import type { Runtime } from './runtime';
import { sleep } from './timing';

/** The pause before the one recheck of a bell that found nothing though a job of its queue is still waiting. */
export const LOCKED_RECHECK_MS = 25;

/** How long a transport keeps a bell the worker had no slot for, or could not claim for. */
export const NO_SLOT_RETRY_MS = 250;
export const CLAIM_ERROR_RETRY_MS = 1000;
/**
 * How long a transport keeps a body that is not a bell before handing it out again. Each hand-out
 * counts against the broker's redrive limit, so a poison body reaches the dead-letter queue in a
 * handful of seconds without the worker spinning on it.
 */
export const MALFORMED_BELL_RETRY_MS = 1000;

export interface BellClaim {
  readonly queue: string;
  readonly owner: string;
  readonly want: number;
  readonly options: ClaimOptions;
  /** True once the worker is closing: nothing more is claimed then. */
  readonly closing: () => boolean;
}

/**
 * The claim a bell starts. A claim never waits for a row another transaction holds, and right after
 * a ring that transaction is `markRung` recording the bell, so a bell delivered at once (a broker
 * can deliver before the publisher has its acknowledgement) can find its job locked. The claim
 * is empty, the bell is spent, and the job would wait for the tick's re-ring.
 *
 * A bell does not own its job: the claim takes the next job of the queue, so another claim may have
 * taken the bell's job while a different one is the locked one. So an empty claim is made once more
 * after a short pause when the queue still has a job waiting, whichever job the bell names, and only
 * once: a job that stays unclaimable (its queue is paused, its group is full, a rate limit holds it)
 * must not turn one bell into a loop. When nothing is waiting (the usual reason for an empty
 * claim: the bell's job is done, taken or gone) it costs one lookup and no second claim.
 */
export async function claimForBell(rt: Runtime, claim: BellClaim): Promise<ClaimedJob[]> {
  const started = performance.now();
  const claimed = await claimWithRecheck(rt, claim);
  rt.observe('qcloud.worker.claim_ms', performance.now() - started);
  rt.count('qcloud.worker.claims', 1, { result: claimed.length === 0 ? 'empty' : 'jobs' });
  if (claimed.length > 0) rt.count('qcloud.worker.claimed', claimed.length);
  return claimed;
}

async function claimWithRecheck(rt: Runtime, claim: BellClaim): Promise<ClaimedJob[]> {
  const { queue, owner, want, options } = claim;
  const first = await rt.store.claim(queue, owner, want, options);
  if (first.length > 0 || claim.closing()) return first;
  if (!(await hasWaiting(rt, queue))) return first;
  await sleep(LOCKED_RECHECK_MS);
  if (claim.closing()) return first;
  rt.count('qcloud.worker.claim_rechecked');
  return rt.store.claim(queue, owner, want, options);
}

/** The probe is best effort: a failed lookup means no recheck, never a failed bell. */
async function hasWaiting(rt: Runtime, queue: string): Promise<boolean> {
  try {
    const page = await rt.store.listJobs({ queue, states: ['waiting', 'prioritized'], limit: 1 });
    return page.items.length > 0;
  } catch {
    return false;
  }
}

/** Acknowledges or returns a bell; a failure is logged, never thrown into the bell handler. */
export async function settleBell(
  rt: Runtime,
  queue: string,
  action: () => Promise<void>
): Promise<void> {
  try {
    await action();
  } catch (error) {
    rt.warn('bell not acknowledged', { queue, error: errorMessage(error) });
  }
}

/**
 * A delivery that is not a bell: a body no producer of ours wrote, or one for another queue. An ack
 * would delete it unseen. Handed back and counted, it goes through the broker's redrive policy to the
 * dead-letter queue, where it is a metric and is never replayed.
 */
export async function returnMalformedBell(
  rt: Runtime,
  queue: string,
  delivery: Delivery
): Promise<void> {
  rt.count('qcloud.worker.malformed_bell');
  await settleBell(rt, queue, () => delivery.nack(MALFORMED_BELL_RETRY_MS));
}
