/**
 * In-process recovery of orphaned executions: `engine.recover()`.
 *
 * Handles the states `listRecoverable` returns:
 * - 'running': publish the node at `currentNodeIndex` again
 * - 'waiting': resume if the signal is already there, publish the expiry if the deadline has passed
 * - 'compensating' (and 'failed' with no rollback outcome): run the unwind again (must be idempotent)
 *
 * **Changed from upstream:** upstream recovered after a restart of its one process, so every
 * non-terminal row was an orphan. The store here is shared by every engine, so `listRecoverable`
 * only hands back runs that have shown no progress for `idleMs`, and every run is TAKEN before it is
 * driven: a compare-and-set write moves its version, and an engine that read the row before that
 * write loses it and skips the run. A waiting run's timer is not re-armed; its deadline is a column
 * and the maintenance tick expires it, so only a deadline that has already passed is published here.
 */

import { hasSignal } from '@qelay-cloud/core';
import type { Queue } from '../queue';
import { decideAdmission } from './admission';
import type { CompensationEnv } from './compensationEnv';
import { runCompensation } from './compensator';
import { bindExecutionDefinition } from './definitionGuard';
import { isWorkflowExecutionClosed } from './executionFence';
import { enqueueWorkflowStep, STEP_JOB } from './executorQueue';
import type { RunStorage } from './storage';
import type { Execution, RecoverResult, StepJobData, WorkflowNode } from './types';
import type { Workflow } from './workflow';

export interface RecoverDeps {
  storage: RunStorage;
  queue: Queue<StepJobData>;
  env: CompensationEnv;
  workflows: ReadonlyMap<string, Workflow>;
  /**
   * Nodes this engine is executing right now. Publishing one that is already in flight makes a job
   * admission will reject, and counting it would report work that did not happen.
   */
  nodesInFlight: ReadonlySet<string>;
  assertActive: () => void;
  idleMs: number;
  limit?: number;
}

/** True for a run whose rollback is still owed. */
export function owesRollback(exec: Execution): boolean {
  return (
    exec.state === 'compensating' || (exec.state === 'failed' && exec.rollbackStatus === undefined)
  );
}

export async function recoverExecutions(deps: RecoverDeps): Promise<RecoverResult> {
  const { storage, workflows } = deps;
  deps.assertActive();
  const snapshots = await storage.port.listRecoverable({
    idleMs: deps.idleMs,
    ...(deps.limit === undefined ? {} : { limit: deps.limit }),
  });
  deps.assertActive();
  const result: RecoverResult = { running: 0, waiting: 0, compensating: 0, total: 0 };

  for (const snapshot of snapshots) {
    deps.assertActive();
    const wf = workflows.get(snapshot.workflowName);
    if (!wf) continue;

    // Re-read before driving it. The list is a snapshot taken before the loop, and each iteration
    // awaits: driving a parent runs its sub-workflow's unwind and settles the CHILD's records in the
    // store, but this loop still holds the child's pre-unwind copy. Using that copy, every
    // `if (record.compensation)` guard reads an unsettled snapshot and dispatches the same handlers
    // a second time, a duplicate refund with no trace.
    const exec = await storage.get(snapshot.id);
    if (!exec) continue;
    await bindExecutionDefinition(exec, wf, (value) => storage.update(value));

    if (exec.state === 'running') {
      const admission = decideAdmission(exec, exec.currentNodeIndex, deps.nodesInFlight);
      // Only `already-in-flight` is reachable here: the state is `running` by the branch and the
      // index is the execution's own cursor.
      if (admission.kind === 'run' && (await take(exec, deps))) {
        await enqueueWorkflowStep(deps.queue, exec, deps.assertActive);
        deps.assertActive();
        result.running++;
      }
    } else if (exec.state === 'waiting') {
      if (await recoverWaiting(exec, wf, deps)) result.waiting++;
    } else if (owesRollback(exec) && (await recoverCompensation(exec.id, wf, deps))) {
      // `runNode` persists the failure before it starts the unwind. A hard kill in between leaves a
      // terminal-looking row with rollback still owed. A lost claim means another driver owns this
      // unwind, so nothing happened here and counting it would overstate what recover() did.
      result.compensating++;
    }
  }

  result.total = result.running + result.waiting + result.compensating;
  return result;
}

/**
 * Take a run before publishing it: the write moves its version, so an engine that read the row
 * earlier (a second `recover()`, the run's own worker) loses against it. False when it lost.
 */
async function take(exec: Execution, deps: RecoverDeps): Promise<boolean> {
  deps.assertActive();
  try {
    await deps.storage.update(exec);
    return true;
  } catch (error) {
    // The engine closing is not a lost race. Anything else closed is the stale write.
    deps.assertActive();
    if (isWorkflowExecutionClosed(error)) return false;
    throw error;
  }
}

/** Drive an owed unwind again. True when this call ran it. */
export async function recoverCompensation(
  executionId: string,
  wf: Workflow,
  deps: Pick<RecoverDeps, 'storage' | 'env' | 'assertActive'>
): Promise<boolean> {
  while (true) {
    deps.assertActive();
    const exec = await deps.storage.get(executionId);
    if (!exec || !owesRollback(exec)) return false;
    await bindExecutionDefinition(exec, wf, (value) => deps.storage.update(value));

    let outcome;
    try {
      outcome = await runCompensation(exec, wf, deps.env);
    } catch (error) {
      deps.assertActive();
      // Another engine took the unwind: its write moved the version under this one.
      if (isWorkflowExecutionClosed(error)) return false;
      throw error;
    }
    deps.assertActive();
    if (outcome === 'ran') return true;

    // A live unwind owned by this engine is not orphaned. Waiting here would deadlock callers that
    // deliberately hold the handler open until recover() returns.
    if (outcome.sameOwner) return false;

    // Another engine in this process left a handler alive after a forced close. Wait for it, then
    // re-read the durable row: it may have finished, or this engine must resume the owed unwind.
    await outcome.settled;
    deps.assertActive();
  }
}

async function recoverWaiting(exec: Execution, wf: Workflow, deps: RecoverDeps): Promise<boolean> {
  const node = wf.nodes[exec.currentNodeIndex] as WorkflowNode | undefined;
  if (node?.type !== 'waitFor') {
    if (!(await take(exec, deps))) return false;
    await enqueueWorkflowStep(deps.queue, exec, deps.assertActive);
    deps.assertActive();
    return true;
  }

  // The signal may have been persisted before the crash, or accepted after this engine was
  // recreated but before recover() reached the row. Key presence, not value: a payload-less signal
  // records the key with an `undefined` value.
  if (hasSignal(exec.signals, node.event)) {
    exec.state = 'running';
    if (!(await take(exec, deps))) return false;
    await enqueueWorkflowStep(deps.queue, exec, deps.assertActive);
    deps.assertActive();
    return true;
  }

  if (node.timeout === undefined) return false;
  const waitRecord = exec.steps[`__waitFor:${node.event}`] as { startedAt?: number } | undefined;
  const waitingSince = waitRecord?.startedAt ?? exec.updatedAt;
  const elapsed = (await deps.storage.port.now()) - waitingSince;
  deps.assertActive();
  // A budget that is not a finite number (a corrupted start time) cannot be measured: the node runs
  // now and `runWaitFor` fails the gate cleanly. One that has not passed is left to the tick.
  if (Number.isFinite(elapsed) && elapsed < node.timeout) return false;
  await deps.queue.add(STEP_JOB, {
    executionId: exec.id,
    workflowName: exec.workflowName,
    nodeIndex: exec.currentNodeIndex,
    due: true,
  } satisfies StepJobData);
  deps.assertActive();
  return true;
}
