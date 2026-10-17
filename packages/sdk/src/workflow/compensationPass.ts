/** One checkpointed compensation pass. */

import { unwindChild, type ChildUnwind } from './compensationChild';
import type { CompensationEnv } from './compensationEnv';
import { compensationContext, settle } from './compensationSupport';
import { isWorkflowExecutionClosed } from './executionFence';
import { describeError } from './identity';
import { buildContext, findStepDef, runWithTimeout } from './runner';
import type { Execution, StepRecord } from './types';
import { decideUnwindAction } from './unwindPlan';
import type { Workflow } from './workflow';

export interface UnwindPass {
  exec: Execution;
  wf: Workflow;
  env: CompensationEnv;
  eligible: [string, StepRecord][];
  retryFailed?: boolean;
}

export async function unwind(pass: UnwindPass, runChild: ChildUnwind): Promise<void> {
  const { exec, wf, env, eligible, retryFailed } = pass;
  const { storage, emitter, clock, assertActive } = env;
  const baseCtx = buildContext(exec);
  let haltedAt: string | null = null;
  let writeFailure: unknown;

  assertActive();
  exec.state = 'compensating';
  try {
    await storage.update(exec);
  } catch (error) {
    // A lost compare-and-set (another engine owns the unwind) or a closed engine is not a store
    // fault: nothing here may continue or park the run.
    if (isWorkflowExecutionClosed(error)) throw error;
    // Nothing ran, so park the owed unwind and retain the original store error.
    writeFailure = error;
    haltedAt = '(the compensating transition)';
  }
  if (writeFailure === undefined) {
    emitter?.emitWorkflow('workflow:compensating', exec.id, exec.workflowName, 'compensating');
    assertActive();
  }

  for (const [name, record] of eligible) {
    assertActive();
    if (writeFailure !== undefined) break;

    const action = decideUnwindAction(wf, name, record, haltedAt !== null, retryFailed);
    if (action.kind === 'stop') break;
    if (action.kind === 'skip') continue;
    if (action.kind === 'halt-failed') {
      haltedAt = name;
      continue;
    }
    if (action.kind === 'halt-vanished') {
      haltedAt = name;
      settle(clock, record, 'compensation-failed', action.error);
      emitter?.emitStep('compensation:failed', exec.id, exec.workflowName, name, {
        error: 'step no longer declared',
      });
      assertActive();
      continue;
    }

    emitter?.emitStep('compensation:started', exec.id, exec.workflowName, name);
    assertActive();
    try {
      if (action.kind === 'unwind-child') {
        await unwindChild({ record, env, runChild, retryFailed });
      } else {
        const def = findStepDef(wf, name);
        const controller = new AbortController();
        const context = {
          ...compensationContext(exec, baseCtx, name, record),
          signal: controller.signal,
        };
        await runWithTimeout(clock, def?.compensate?.(context), action.timeoutMs, controller);
      }
      settle(clock, record, 'compensated');
      emitter?.emitStep('compensation:completed', exec.id, exec.workflowName, name);
    } catch (error) {
      if (isWorkflowExecutionClosed(error)) throw error;
      const message = describeError(error);
      settle(clock, record, 'compensation-failed', message);
      emitter?.emitStep('compensation:failed', exec.id, exec.workflowName, name, {
        error: message,
      });
      haltedAt = name;
    }

    try {
      await storage.update(exec);
    } catch (error) {
      if (isWorkflowExecutionClosed(error)) throw error;
      // An unpersisted reversal could run twice on recovery; stop immediately.
      writeFailure = error;
      haltedAt = name;
      break;
    }
  }

  if (haltedAt !== null) {
    exec.state = 'compensation-stuck';
    exec.rollbackStatus = 'stuck';
  } else {
    exec.state = 'failed';
    exec.rollbackStatus = 'completed';
  }
  try {
    await storage.update(exec);
  } catch (error) {
    if (isWorkflowExecutionClosed(error)) throw error;
    if (writeFailure === undefined) throw error;
  }
  if (writeFailure !== undefined) throw writeFailure;
}
