import type { FlowActionResult, FlowChange, Ring } from '@qelay-cloud/core';
import type { TransactionSQL } from 'bun';
import type { StoreContext } from './context';
import type { StoreEvent } from './events';
import { fence, lockFlowRows } from './flowActionSupport';
import { lockParents } from './flowResolve';
import { initialState, ringFor } from './state';

/**
 * `retry-failed`: puts failed children that hold a waiting parent back on the queue, each as a fresh
 * job (no attempts used, no error, no DLQ entry), so the parent is released once they complete. This is
 * the one retry the control API has: retrying any failed job stays closed in v1 (`job-retry` and
 * `dlq-retry` answer 501), because here the failed job is a link in a flow the parent is waiting on.
 *
 * A job is retryable when all of these hold, and the whole request is refused (`not_retryable`) when one
 * job is not, so no part of a retry is applied alone:
 * - it is `failed` and its parent still waits for it (`waiting-children`), through an edge with no
 *   failure policy: the failure is what holds the parent back. A child whose policy let go of it
 *   (`continue`, `ignore`, `remove`) is not holding anything, and a parent that was released already
 *   will not wait again.
 * - it is not a parent that never ran. A parent that failed because one of its children failed under
 *   `fail` has had its edges dropped, so running it again would run its processor with no children done;
 *   an operator lets go of it with `promote` on its own parent, or removes the flow.
 *
 * Locks: the targets, then their parents, which is the order a finishing child takes. A parent
 * another transaction released in the meantime is no longer waiting once its lock is granted, so the
 * retry refuses rather than queueing a job whose parent has moved on.
 */
export async function retryFailed(
  ctx: StoreContext,
  tx: TransactionSQL,
  root: string,
  versions: ReadonlyMap<string, number>
): Promise<FlowActionResult> {
  const { namespace } = ctx;
  const targets = await lockFlowRows(tx, namespace, root, [...versions.keys()].sort());
  // Only the jobs the request names are locked, so this is `foreign` or a version that moved, never `unseen`.
  const refusal = fence(targets, versions);
  if (refusal) return { applied: false, refusal };

  const facts = await tx<Facts[]>`
    SELECT job.id, job.parent_id, job.priority, job.queue,
      EXISTS (
        SELECT 1 FROM qcloud_dependencies AS edge
        WHERE edge.namespace = job.namespace AND edge.job_id = job.parent_id
          AND edge.dependency_id = job.id AND edge.on_failure IS NULL
      ) AS holds,
      (job.started_at IS NULL AND EXISTS (
        SELECT 1 FROM qcloud_jobs AS child
        WHERE child.namespace = job.namespace AND child.parent_id = job.id
      )) AS never_ran
    FROM qcloud_jobs AS job
    WHERE job.namespace = ${namespace} AND job.id = ANY(${tx.array([...targets.keys()], 'TEXT')})`;
  const waiting = await lockParents(
    tx,
    namespace,
    facts.flatMap((fact) => (fact.parent_id === null ? [] : [fact.parent_id]))
  );
  const retryable = new Map(
    facts
      .filter((fact) => {
        const row = targets.get(fact.id)!;
        return (
          row.state === 'failed' &&
          fact.holds &&
          !fact.never_ran &&
          fact.parent_id !== null &&
          waiting.has(fact.parent_id)
        );
      })
      .map((fact) => [fact.id, fact])
  );
  const refused = [...targets.keys()].filter((id) => !retryable.has(id)).sort();
  if (refused.length > 0)
    return { applied: false, refusal: { kind: 'not_retryable', ids: refused } };

  const now = await ctx.db.time.now(tx);
  const changes: FlowChange[] = [];
  const events: StoreEvent[] = [];
  const rings: Ring[] = [];
  for (const id of [...retryable.keys()].sort()) {
    const fact = retryable.get(id)!;
    const state = initialState(now, now, fact.priority);
    await tx`
      UPDATE qcloud_jobs
      SET state = ${state}, run_at = ${now}, rung_at = NULL, attempts = 0, started_at = NULL,
          completed_at = NULL, error = NULL, failure_reason = NULL, dlq_entry = NULL,
          dlq_retry_state = NULL, version = version + 1
      WHERE namespace = ${namespace} AND id = ${id}`;
    events.push({ type: 'retried', queue: fact.queue, jobId: id, state });
    changes.push({ id, queue: fact.queue, from: 'failed', to: state });
    const ring = ringFor(namespace, fact.queue, id, now, now, ctx.ringWindowMs);
    if (ring) rings.push(ring);
  }
  await ctx.recorder.record(tx, events, now);
  return { applied: true, changes, rings };
}

interface Facts {
  readonly id: string;
  readonly parent_id: string | null;
  readonly priority: number;
  readonly queue: string;
  /** The parent holds an edge to this job with no failure policy. */
  readonly holds: boolean;
  /** A parent that was never claimed: it failed because a child failed. */
  readonly never_ran: boolean;
}
