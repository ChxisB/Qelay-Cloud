import type { Ring, TickBudget, TickReport } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { pruneCompletions } from './completions';
import type { StoreContext } from './context';
import { claimDueCrons } from './crons';
import { promoteDue } from './delay';
import { purgeExpiredDlq } from './dlq';
import { pruneEventCommits } from './eventCommitPrune';
import { trimEvents } from './eventRetention';
import { expirePending } from './expiry';
import { pruneGroupStates } from './groupRetention';
import { pruneMetricBuckets } from './metricRetention';
import { recoverExpired } from './recovery';
import { dueForRing } from './ringQuery';
import { pruneWebhookDeliveries } from './webhookRetention';
import { expireWorkers } from './workers';

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(name, 'must be a positive integer');
  }
  return value;
}

/**
 * One tick: the work that keeps a queue moving when nothing else happens. In order:
 *
 * 1. recover expired leases (always: a dead worker's job is stuck until this runs);
 * 2. fire the crons that are due;
 * 3. promote delayed jobs that came due;
 * 4. delete pending jobs whose TTL elapsed;
 * 5. delete DLQ entries past their queue's `maxAge`, workers that stopped heartbeating, and webhook
 *    deliveries that are too old (expired if live, deleted if finished);
 * 6. trim the event journal to its window and caps, and delete the commit envelopes nothing uses;
 * 7. delete completion records of jobs that are gone, group state nothing uses, and metric buckets
 *    past their retention;
 * 8. find every job that needs a bell (always: this is what bounds a lost bell, invariant 3).
 *
 * Each step is capped by `maxItems`. When `maxDurationMs` of wall-clock time has gone by after a
 * step, the steps (2 to 7) still to come are skipped and `moreWork` is true. `skipUpkeep` leaves
 * out steps 5 to 7 (the loop's rounds between upkeeps, with no `moreWork`). Steps 1 and 8 are not
 * skipped: they are what the tick is for, and each is bounded by its own cap. The cap on rings per
 * queue is not "more work": a backlog is rung from the oldest, and the next tick rings the next
 * stretch as the first bells age past `reRingAfterMs`.
 *
 * The rings are the ring query's (`dueForRing`, after the other steps, so a job a step just made
 * claimable is in it), capped per queue, plus the rings of the jobs the crons just created: those
 * are inside the creation grace, which exists for an enqueuer's publish in flight, and here the
 * tick is the creator, so nobody else is publishing. A job in both is listed once. The bells
 * `recoverExpired` returns are dropped because the query finds the same jobs and applies the cap
 * and the window the caller named. They are returned for the caller to publish, and then to report
 * to `markRung`. The tick itself rings nothing, so a tick that runs and whose caller dies before
 * publishing costs one interval, not a job. Safe to run from any number of processes at once:
 * every step takes its rows `FOR UPDATE SKIP LOCKED` or only reads.
 */
export async function runTick(ctx: StoreContext, budget: TickBudget): Promise<TickReport> {
  const maxItems = positive('maxItems', budget.maxItems);
  const perQueueCap = positive('maxRingsPerQueue', budget.maxRingsPerQueue);
  if (!Number.isFinite(budget.maxDurationMs) || budget.maxDurationMs < 0) {
    throw new UnsupportedOptionError('maxDurationMs', 'must be a non-negative number');
  }
  const started = performance.now();
  const overBudget = (): boolean => performance.now() - started >= budget.maxDurationMs;
  let moreWork = false;
  // A step's `more` is folded in after it ran: `moreWork ||= await step()` would not run the step
  // at all once an earlier one had reported more work.
  const note = (more: boolean): void => {
    moreWork = moreWork || more;
  };
  const stepMs: Record<string, number> = {};
  const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const began = performance.now();
    try {
      return await run();
    } finally {
      stepMs[step] = Math.round(performance.now() - began);
    }
  };

  const recovery = await timed('recover', () => recoverExpired(ctx, maxItems));
  note(recovery.more);

  let cronFired = 0;
  let cronRings: readonly Ring[] = [];
  if (overBudget()) {
    moreWork = true;
  } else {
    const crons = await timed('crons', () => claimDueCrons(ctx, maxItems));
    cronFired = crons.fired;
    cronRings = crons.rings;
    note(crons.more);
  }

  let promoted = 0;
  let expired = 0;
  if (overBudget()) {
    moreWork = true;
  } else {
    const delayed = await timed('promote', () => promoteDue(ctx, maxItems));
    promoted = delayed.promoted;
    note(delayed.more);
  }
  if (overBudget()) {
    moreWork = true;
  } else {
    const ttl = await timed('expire', () => expirePending(ctx, maxItems));
    expired = ttl.expired;
    note(ttl.more);
  }
  const upkeep: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    [
      'retention',
      async () => {
        note((await purgeExpiredDlq(ctx, maxItems)) >= maxItems);
        note((await expireWorkers(ctx, maxItems)).more);
        note((await pruneWebhookDeliveries(ctx, maxItems)).more);
      },
    ],
    [
      'events',
      async () => {
        note((await trimEvents(ctx, maxItems)).more);
        note((await pruneEventCommits(ctx, maxItems)) >= maxItems);
      },
    ],
    [
      'completions',
      async () => {
        note((await pruneCompletions(ctx, maxItems)).more);
        note((await pruneGroupStates(ctx, maxItems)).more);
        note((await pruneMetricBuckets(ctx, maxItems)).more);
      },
    ],
  ];
  for (const [step, run] of budget.skipUpkeep === true ? [] : upkeep) {
    if (overBudget()) {
      moreWork = true;
    } else {
      await timed(step, run);
    }
  }

  const due = await timed('ringQuery', () =>
    dueForRing(ctx, {
      perQueueCap,
      ...(budget.maxStaleRingsPerQueue === undefined
        ? {}
        : { staleCap: budget.maxStaleRingsPerQueue }),
      reRingAfterMs: budget.reRingAfterMs,
      graceMs: budget.ringGraceMs,
      windowMs: budget.ringWindowMs,
    })
  );
  return {
    recovered: recovery.recovered,
    promoted,
    cronFired,
    expired,
    rings: mergeRings(cronRings, due),
    moreWork,
    stepMs,
  };
}

/** Each job once, the first ring named for it winning. */
function mergeRings(first: readonly Ring[], second: readonly Ring[]): Ring[] {
  const seen = new Set<string | undefined>();
  return [...first, ...second].filter((ring) => {
    if (seen.has(ring.bell.jobId)) return false;
    seen.add(ring.bell.jobId);
    return true;
  });
}
