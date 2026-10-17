/**
 * waitFor node execution: parking a run for a human/external signal, and the durable deadline that
 * bounds the wait.
 *
 * Split out of the executor because parking is the one node type with a genuinely concurrent
 * counterpart: `signal()` mutates the same row from outside the worker, so every transition here is
 * expressed as a claim against the store rather than an in-memory state change.
 *
 * **Changed from upstream:** the timeout was an in-memory `setTimeout` per parked run, re-armed by
 * `recover()` after a restart. Here it is a deadline column on the parked row. `parkForSignal`
 * writes it, the maintenance tick finds overdue rows (`claimDueWaits`) and publishes a `wf:step`
 * job flagged `due`, and the job fails the gate through `expireWait` exactly as upstream's timer
 * callback did. No process has to stay up for a wait to expire, and the deadline is measured on the
 * store's clock, so workers with different clocks agree on when it passes.
 */

import { hasSignal } from '@qelay-cloud/core';
import type { Clock } from './clock';
import { WaitForSignalError } from './compensator';
import type { WorkflowEmitter } from './emitter';
import type { RunStorage } from './storage';
import type { Execution, WorkflowNode } from './types';
import type { Workflow } from './workflow';

export interface WaitForDeps {
  storage: RunStorage;
  emitter: WorkflowEmitter | null;
  clock: Clock;
  advance: (exec: Execution, nextIdx: number, wf: Workflow) => Promise<void>;
  compensate: (exec: Execution, wf: Workflow) => Promise<void>;
  updateFn: (exec: Execution) => Promise<void>;
  assertActive: () => void;
  /** The tick found this wait overdue on the store's clock; the job does not re-measure it. */
  due: boolean;
}

type WaitNode = Extract<WorkflowNode, { type: 'waitFor' }>;

/**
 * Execute a `waitFor` node: advance if the signal is already there, fail if the wait
 * has expired, otherwise park the run and throw the sentinel so processStep
 * short-circuits without treating the pause as an error.
 */
export async function runWaitFor(
  deps: WaitForDeps,
  exec: Execution,
  node: WaitNode,
  idx: number,
  wf: Workflow
): Promise<void> {
  deps.assertActive();
  if (hasSignal(exec.signals, node.event)) {
    await deps.advance(exec, idx + 1, wf);
    return;
  }

  const waitKey = `__waitFor:${node.event}`;
  let deadlineAt: number | undefined;
  if (node.timeout !== undefined) {
    const now = await deps.storage.port.now();
    const existing = exec.steps[waitKey] as { startedAt?: number } | undefined;
    const waitingSince = existing?.startedAt ?? now;
    if (!existing) exec.steps[waitKey] = { status: 'running', startedAt: waitingSince };

    const elapsed = now - waitingSince;
    if (deps.due || !Number.isFinite(elapsed) || elapsed >= node.timeout) {
      // A start that is not a finite number (a corrupted row) leaves the budget
      // unmeasurable: fail the gate through the same claim rather than park it behind
      // a deadline that cannot be computed.
      const reason = Number.isFinite(elapsed)
        ? undefined
        : `Signal "${node.event}" wait has an invalid start time (${String(waitingSince)}); ` +
          `its ${node.timeout}ms budget cannot be measured`;
      await expireGate(deps, exec, wf, { node, idx, waitingSince, reason });
      return;
    }
    await deps.updateFn(exec);
    deadlineAt = Math.ceil(waitingSince + node.timeout);
  }

  // Park transactionally. Between the in-memory check above and this point a signal
  // can land: it would be recorded with no parked run left to claim the resume,
  // hanging the execution forever. parkForSignal() re-reads the persisted signals
  // and only transitions 'running' -> 'waiting' when none has arrived.
  deps.assertActive();
  const park = await deps.storage.port.parkForSignal(exec.id, node.event, deadlineAt);
  deps.assertActive();
  if (park.signalPresent) {
    exec.signals = park.signals;
    await deps.advance(exec, idx + 1, wf);
    return;
  }
  if (!park.parked) {
    // Another job already moved this execution off 'running'; don't advance or emit
    // a second waiting event for the same node.
    throw new WaitForSignalError(node.event);
  }

  exec.state = 'waiting';
  deps.emitter?.emitWorkflow('workflow:waiting', exec.id, exec.workflowName, 'waiting');
  throw new WaitForSignalError(node.event);
}

/** The gate whose wait budget is spent. */
interface ExpiredGate {
  node: WaitNode;
  idx: number;
  waitingSince: number;
  /** Overrides the timeout reason (a budget that cannot be measured). */
  reason?: string;
}

/**
 * Fail a gate whose budget is spent, unless its signal won the race.
 *
 * The signal check and the failing write are ONE claim (`expireWait`), not a re-read followed by a
 * write. The signaller may be another connection that records the signal while this node runs;
 * between a separate re-read and the write it was accepted with `resumed: true` and its resume job
 * published, and then this run was failed and compensated anyway. Each outcome of the claim:
 *
 * - `expired`: the row is durably `failed`, so any later signal is rejected as
 *   "cannot receive the signal". Only now is the timeout a fact, so only now is
 *   `signal:timeout` emitted.
 * - `signalled`: nothing was written. Advance, exactly like a signal found on entry.
 *   If the signaller claimed the resume it also published a job for this node; that
 *   duplicate is dropped by admission, because this job holds the in-flight claim for the
 *   node until `advance` has already moved the cursor, after which the duplicate is
 *   `stale-cursor`. Standing down instead would be unsafe: a duplicate that arrives while
 *   the claim is held is discarded, and the run would then be advanced by nobody.
 * - `moved`: another driver already advanced or finished this run. Neither fail nor
 *   advance it, the same stand-down as a lost park claim above.
 */
async function expireGate(
  deps: WaitForDeps,
  exec: Execution,
  wf: Workflow,
  gate: ExpiredGate
): Promise<void> {
  const { node, idx, waitingSince } = gate;
  const timeoutReason = gate.reason ?? `Signal "${node.event}" timed out after ${node.timeout}ms`;
  // Applied to a copy: on `signalled` the caller advances from `exec`, and a failure
  // left in it would be persisted by the very write that moves the cursor on.
  const failed: Execution = {
    ...exec,
    state: 'failed',
    failureReason: timeoutReason,
    steps: {
      ...exec.steps,
      [`__waitFor:${node.event}`]: {
        status: 'failed',
        startedAt: waitingSince,
        completedAt: deps.clock.now(),
        error: timeoutReason,
      },
    },
  };
  // Persist failure before starting rollback. If force-close won, the fence throws
  // here, the durable row stays live, and the next sweep re-evaluates the same
  // elapsed deadline through this same claim without the old executor compensating.
  deps.assertActive();
  const expiry = await deps.storage.port.expireWait(failed, node.event, idx);
  deps.assertActive();
  if (expiry.kind === 'moved') throw new WaitForSignalError(node.event);
  if (expiry.kind === 'signalled') {
    exec.signals = expiry.signals;
    await deps.advance(exec, idx + 1, wf);
    return;
  }

  exec.state = failed.state;
  exec.steps = failed.steps;
  exec.failureReason = failed.failureReason;
  // `expireWait` wrote the new version and time into the copy; the run continues from `exec`.
  exec.updatedAt = failed.updatedAt;
  if (failed.version !== undefined) exec.version = failed.version;
  deps.emitter?.emitSignal('signal:timeout', exec.id, exec.workflowName, node.event);
  // Compensate here, then signal completion via the WaitForSignalError sentinel so
  // processStep short-circuits (return null) instead of re-running compensation
  // through its generic catch path.
  await deps.compensate(exec, wf);
  deps.assertActive();
  deps.emitter?.emitWorkflow('workflow:failed', exec.id, exec.workflowName, 'failed');
  throw new WaitForSignalError(node.event);
}
