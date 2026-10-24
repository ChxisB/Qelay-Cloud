import type { EnqueuedJob, NewJob } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import { applyPlan } from './apply';
import type { StoreContext } from './context';
import { lockAdmissionKeys, lockGroupCapacity, lockQueuesShared } from './locks';
import type { ExistingRow } from './lookup';
import { countPendingByGroup, findById, findLiveByKey } from './lookup';
import type { Admitted, Plan } from './plan';
import { planAdmission } from './plan';
import type { PreparedJob } from './prepare';
import { prepareJobs } from './prepare';
import { applyPolicies, registerQueues } from './queuePolicy';
import { coverRings } from './ringCover';
import { ringFor } from './state';

/**
 * Admits a batch in one transaction. Ported from Qelay's `admission.ts` and `batchAdmission.ts`
 * (see docs/PORTING.md), restructured as set-based steps: lock, read what exists once, decide in
 * memory (`planAdmission`), then write each kind of change in one statement.
 */
export async function enqueueJobs(
  ctx: StoreContext,
  jobs: readonly NewJob[]
): Promise<EnqueuedJob[]> {
  if (jobs.length === 0) return [];
  // Everything that can fail on its own input fails here, before a connection is taken.
  const prepared = prepareJobs(jobs, ctx.codec, ctx.limits);
  return ctx.db.run('enqueue', (sql) => sql.begin((tx) => admitJobs(ctx, tx, prepared)));
}

/**
 * The transaction-level half of `enqueueJobs`: admits `prepared` inside the caller's transaction
 * (the cron firing admits its jobs in the transaction that advances the cron). The caller prepares
 * the jobs first, so nothing here fails on its own input; a `GroupFullError` is the one admission
 * rule that can, and it rolls the caller's transaction back.
 */
export async function admitJobs(
  ctx: StoreContext,
  tx: TransactionSQL,
  prepared: readonly PreparedJob[]
): Promise<EnqueuedJob[]> {
  await lockAdmission(ctx, tx, prepared);
  const now = await ctx.db.time.now(tx);
  const existingById = await findById(tx, ctx.namespace, customIds(prepared));
  const plan = await planAndWrite(ctx, tx, prepared, now, existingById);
  await ctx.recorder.record(tx, plan.events, now);
  const jobs = plan.admitted.map((admitted) => result(ctx, admitted, now));
  // A queue outside its run window would spend the bell on an empty claim (DESIGN.md D17): the tick rings the job when it opens.
  const rung = plan.closed.size === 0 ? jobs : jobs.map((job) => unringIfClosed(job, plan.closed));
  return coverRings(ctx, tx, rung, now);
}

/** The custom ids of `prepared`, which admission looks up (and locks) as rows. */
export const customIds = (prepared: readonly PreparedJob[]): string[] =>
  prepared.flatMap((job) => (job.customId === null ? [] : [job.customId]));

/** The groups of `prepared` that have a `maxSize` to check. */
const cappedGroups = (prepared: readonly PreparedJob[]) =>
  prepared.flatMap((job) =>
    job.groupId !== null && job.groupMaxSize !== null
      ? [{ queue: job.queue, groupId: job.groupId }]
      : []
  );

/**
 * Takes the locks an admission needs, in the fixed order (lifecycle, group capacity, admission keys)
 * so concurrent calls cannot deadlock. A flow takes them for all its jobs at once.
 */
export async function lockAdmission(
  ctx: StoreContext,
  tx: TransactionSQL,
  prepared: readonly PreparedJob[]
): Promise<void> {
  const { namespace } = ctx;
  const capped = cappedGroups(prepared);
  await lockQueuesShared(
    tx,
    namespace,
    prepared.map((job) => job.queue)
  );
  await lockGroupCapacity(tx, namespace, capped);
  await lockAdmissionKeys(
    tx,
    namespace,
    prepared.flatMap((job) => [
      ...(job.customId === null ? [] : [`id:${job.customId}`]),
      ...(job.dedupKey === null ? [] : [`dedup:${job.queue}:${job.dedupKey}`]),
    ])
  );
}

/**
 * Plans `prepared` against what exists (`existingById`, read under the locks of `lockAdmission`) and
 * writes the plan. The queues are registered first, in the one statement that also reads their
 * policies, which fill the settings a job left out (DESIGN.md D17) before it is planned. The caller
 * journals `plan.events`, so a flow can fix the state of the parents' `pushed` events first.
 */
export async function planAndWrite(
  ctx: StoreContext,
  tx: TransactionSQL,
  submitted: readonly PreparedJob[],
  now: number,
  existingById: ReadonlyMap<string, ExistingRow>
): Promise<Plan & { readonly closed: ReadonlySet<string> }> {
  const { namespace } = ctx;
  const { policies, closed } = await registerQueues(
    tx,
    namespace,
    submitted.map((job) => job.queue),
    now
  );
  const prepared = applyPolicies(submitted, policies, ctx.codec, ctx.limits.maxPayloadBytes);
  const capped = cappedGroups(prepared);
  const keyed = prepared.flatMap((job) =>
    job.dedupKey === null ? [] : [{ queue: job.queue, key: job.dedupKey }]
  );
  const plan = planAdmission({
    now,
    jobs: prepared,
    existingById,
    existingByKey: await findLiveByKey(tx, namespace, keyed),
    pendingByGroup: await countPendingByGroup(tx, namespace, capped),
    nextId: () => ctx.nextId(now),
  });
  await applyPlan(tx, namespace, plan, now);
  return { ...plan, closed };
}

const unringIfClosed = (job: EnqueuedJob, closed: ReadonlySet<string>): EnqueuedJob =>
  job.ring !== null && closed.has(job.ring.bell.queue) ? { ...job, ring: null } : job;

function result(ctx: StoreContext, admitted: Admitted, now: number): EnqueuedJob {
  if (admitted.kind === 'duplicate') {
    return { id: admitted.id, created: false, state: admitted.state, ring: null };
  }
  const { insert } = admitted;
  return {
    id: insert.id,
    created: true,
    state: insert.state,
    // A job a later job of the same call replaced is gone: there is nothing to ring.
    ring: insert.cancelled
      ? null
      : ringFor(ctx.namespace, insert.job.queue, insert.id, insert.runAt, now, ctx.ringWindowMs),
  };
}
