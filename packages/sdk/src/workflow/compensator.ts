/**
 * Public saga-compensation entry points.
 *
 * A pass is checkpointed per step, halts on an uncertain reversal, and is protected
 * from overlapping drivers. The execution mechanics live in compensationPass.ts; record
 * selection lives in compensationSupport.ts.
 */

import { AbandonedCompensationError } from './compensationChild';
import { acquireCompensationClaim } from './compensationClaim';
import type { LostCompensationClaim } from './compensationClaim';
import type { CompensationEnv } from './compensationEnv';
import { unwind } from './compensationPass';
import { settle, unwindSet } from './compensationSupport';
import type { Execution } from './types';
import { owesOutcome } from './unwindPlan';
import type { Workflow } from './workflow';

export { AbandonedCompensationError, CommittedChildError } from './compensationChild';

/** Sentinel thrown when an execution deliberately parks for a signal. */
export class WaitForSignalError extends Error {
  constructor(readonly event: string) {
    super(`Waiting for signal: ${event}`);
  }
}

/**
 * What `runCompensation` reports. `ran` means this call drove the unwind to its end; a lost claim
 * means another driver in this process owns it (see compensationClaim.ts). A driver in another
 * process shows up as `WorkflowExecutionClosedError` instead, thrown by the first write it loses.
 */
export type UnwindOutcome = 'ran' | LostCompensationClaim;

/** Run compensation handlers in reverse start order for every eligible step. */
export async function runCompensation(
  exec: Execution,
  wf: Workflow,
  env: CompensationEnv,
  opts: { retryFailed?: boolean } = {}
): Promise<UnwindOutcome> {
  const { storage, assertActive } = env;
  assertActive();
  // `failed` + `stuck` is the durable terminal form written by an explicit
  // abandon. No caller, including an ancestor retry, may reopen that decision.
  if (exec.state === 'failed' && exec.rollbackStatus === 'stuck') {
    throw new AbandonedCompensationError(exec.workflowName, exec.id);
  }

  const eligible = unwindSet(exec, wf);

  if (eligible.length === 0) {
    assertActive();
    exec.rollbackStatus = 'not-applicable';
    if (exec.state !== 'failed' && exec.state !== 'completed') exec.state = 'failed';
    await storage.update(exec);
    return 'ran';
  }

  assertActive();
  const claim = acquireCompensationClaim(exec.id, storage);
  if (claim.kind === 'claim-lost') return claim;
  // A reversal can take longer than a recovery sweep's idle window; beating keeps the run from
  // being taken over while a live handler is still running.
  const stopBeating = storage.keepAlive(exec);
  try {
    await unwind({ exec, wf, env, eligible, ...opts }, ({ exec, workflow, env, retryFailed }) =>
      runCompensation(exec, workflow, env, { retryFailed })
    );
  } finally {
    stopBeating();
    claim.release();
  }
  return 'ran';
}

/**
 * Give up on a parked unwind and record an explicit skipped outcome for every
 * remaining eligible step.
 */
export async function abandonCompensation(
  exec: Execution,
  wf: Workflow,
  env: CompensationEnv
): Promise<void> {
  const { storage, emitter, clock, assertActive } = env;
  for (const [name, record] of unwindSet(exec, wf)) {
    assertActive();
    if (record.compensation) continue;
    if (!owesOutcome(wf, name, record)) continue;
    const reason = 'unwind abandoned by operator';
    settle(clock, record, 'compensation-skipped', reason);
    emitter?.emitStep('compensation:skipped', exec.id, exec.workflowName, name, { error: reason });
    assertActive();
  }
  assertActive();
  exec.state = 'failed';
  exec.rollbackStatus = 'stuck';
  await storage.update(exec);
}
