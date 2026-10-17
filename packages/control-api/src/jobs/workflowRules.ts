import type { Execution, ExecutionState, RollbackStatus } from '@qelay-cloud/core';
import { hasSignal } from '@qelay-cloud/core';
import type { WorkflowActionName } from './workflowSchemas';

/**
 * What an operator may do to a run. The action route enforces it (409 `execution_state`) and the
 * detail view lists it, so a client draws only the buttons that would be accepted.
 */
export interface RunFacts {
  readonly state: ExecutionState;
  readonly rollbackStatus: RollbackStatus | undefined;
  /** `waiting`: the awaited event is already recorded, so the resume was lost and can be published again. */
  readonly signalled: boolean;
  /** No progress for the idle window (the tick's `QCLOUD_WORKFLOW_IDLE_MS`): no live worker holds it. */
  readonly idle: boolean;
}

export function runFacts(
  exec: Execution,
  waitEvent: string | undefined,
  now: number,
  idleMs: number
): RunFacts {
  return {
    state: exec.state,
    rollbackStatus: exec.rollbackStatus,
    signalled: waitEvent !== undefined && hasSignal(exec.signals, waitEvent),
    idle: now - exec.updatedAt >= idleMs,
  };
}

/** Finished for good: no worker, tick or operator will move it again. */
export const isFinished = (facts: Pick<RunFacts, 'state' | 'rollbackStatus'>): boolean =>
  facts.state === 'completed' || (facts.state === 'failed' && facts.rollbackStatus !== undefined);

/**
 * - `running`: `signal` (a gate records it), `cancel` (stop and roll back), and `recover` once it has
 *   gone quiet (its job or worker was lost).
 * - `waiting`: `signal`, `cancel`, and `recover` only when the awaited event is already recorded.
 * - `compensating`, and `failed` with no rollback outcome yet: the unwind is owed; `recover` drives it
 *   again once it has gone quiet.
 * - `compensation-stuck`: a reversal failed for good. `retry-compensation` or `abandon-compensation`.
 * - `completed`, and `failed` with an outcome: finished. Nothing applies.
 */
export function allowedActions(facts: RunFacts): WorkflowActionName[] {
  switch (facts.state) {
    case 'running':
      return facts.idle ? ['signal', 'cancel', 'recover'] : ['signal', 'cancel'];
    case 'waiting':
      return facts.signalled ? ['signal', 'cancel', 'recover'] : ['signal', 'cancel'];
    case 'compensating':
      return facts.idle ? ['recover'] : [];
    case 'compensation-stuck':
      return ['retry-compensation', 'abandon-compensation'];
    case 'failed':
      return facts.rollbackStatus === undefined && facts.idle ? ['recover'] : [];
    case 'completed':
      return [];
  }
}
