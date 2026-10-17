/** Failing a run and rolling it back, and cancelling one from outside. */

import { isLive } from './admission';
import type { CompensationEnv } from './compensationEnv';
import { runCompensation } from './compensator';
import { isWorkflowExecutionClosed } from './executionFence';
import type { Execution } from './types';
import type { Workflow } from './workflow';

export interface FailureEnv extends CompensationEnv {
  isActive: () => boolean;
}

/**
 * Persist a failed run, then roll it back. The failed transition is written FIRST: if the guarded
 * write fails, recovery sees the old running row and re-drives the node, and if it succeeds the
 * row says `failed` before any reversal runs.
 */
export async function failRun(
  env: FailureEnv,
  exec: Execution,
  wf: Workflow,
  reason: string
): Promise<void> {
  env.assertActive();
  exec.state = 'failed';
  // Why the run failed, kept distinct from what the rollback then did.
  exec.failureReason = reason;
  await env.storage.update(exec);
  env.emitter?.emitWorkflow('workflow:failed', exec.id, exec.workflowName, 'failed');
  if (env.isActive()) await runCompensation(exec, wf, env);
}

/**
 * Stop a live run and roll it back. Not in upstream. The write that marks it failed is the claim: a
 * node of the run that is executing on another worker finishes its current handler, then its next
 * write loses against this one and the node stands down.
 */
export async function cancelRun(
  env: FailureEnv,
  executionId: string,
  reason: string
): Promise<void> {
  env.assertActive();
  const exec = await env.storage.get(executionId);
  if (!exec) throw new Error(`Execution "${executionId}" not found`);
  if (!isLive(exec.state)) {
    throw new Error(`Execution "${executionId}" is "${exec.state}" and cannot be cancelled`);
  }
  const wf = env.workflows?.get(exec.workflowName);
  if (!wf) throw new Error(`Workflow "${exec.workflowName}" not registered`);
  try {
    await failRun(env, exec, wf, reason);
  } catch (error) {
    env.assertActive();
    if (isWorkflowExecutionClosed(error)) {
      throw new Error(`Execution "${executionId}" changed while it was being cancelled; try again`);
    }
    throw error;
  }
}
