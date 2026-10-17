import type { Execution, WorkflowStepJob } from '@qelay-cloud/core';
import { ExecutionStaleError, SignalRejectedError, workflowStepJob } from '@qelay-cloud/core';
import { ApiError } from '../errors';
import type { JobsContext } from './context';
import { fromWire } from './payload';
import { ringAfterCommit } from './ring';
import type { RunFacts } from './workflowRules';
import { allowedActions, isFinished, runFacts } from './workflowRules';
import type { WorkflowActionBody, WorkflowActionName } from './workflowSchemas';
import { DESTRUCTIVE_ACTIONS } from './workflowSchemas';

/**
 * What an operator does to a run. The Control API holds no workflow definition and runs no engine, so
 * an action is a CLAIM and a PUBLISH:
 *
 * - **claim**: a version-checked write of the run (`store.workflows.update`, the same write the tick
 *   uses to take a stuck run). A caller that read an older version, a worker that wrote meanwhile and
 *   a second operator all lose against it with 409 `version_conflict`, and nothing changes.
 * - **publish**: a `wf:step` job on the engine queue. A worker that holds the definition executes it.
 *
 * `cancel` and `recover` claim, then publish. `signal`, `retry-compensation` and `abandon-compensation`
 * are claimed inside the store or the worker (`recordSignal` locks the row; the worker's
 * `resumeCompensation` claims the unwind), so for those the `expectedVersion` is a read check: the
 * run was at that version when the request was looked at, not a lock held through the publish.
 *
 * If the publish fails after a claim the run is left in a state the tick recovers on its own (a
 * `failed` run with no rollback outcome, a quiet `running` one) and the error says so; a signal that
 * resumed a parked run is put back to `waiting` with its signal recorded, which `recover` resumes.
 * Audit rows carry the action name and the run id, never a payload, an event or a reason.
 */

export interface WorkflowActionResult {
  readonly action: WorkflowActionName;
  readonly executionId: string;
  /** A step job went to the engine queue for a worker to execute. */
  readonly published: boolean;
  /** `signal`: this call resumed a parked run (a signal into a run that is not parked is only recorded). */
  readonly resumed?: boolean;
  /** The run's version after this call's claim; null when the store or the worker claims. */
  readonly version: number | null;
}

/** 400 `confirmation_required` unless `confirm` is exactly the run id. */
export function requireWorkflowConfirmation(id: string, body: WorkflowActionBody): void {
  if (!DESTRUCTIVE_ACTIONS.includes(body.action) || body.confirm === id) return;
  throw new ApiError(
    400,
    'confirmation_required',
    `${body.action} cannot be taken back: send "confirm" with the execution id to proceed`,
    { required: 'confirm', equals: 'the execution id' }
  );
}

/** Fields that mean something only to one action are refused on the others, so none is silently dropped. */
function checkBody(body: WorkflowActionBody): void {
  const misplaced = (field: string, action: string) =>
    ApiError.invalid(`"${field}" applies to ${action} only`, { field });
  if (body.action !== 'signal') {
    if (body.event !== undefined) throw misplaced('event', 'signal');
    if (body.payload !== undefined) throw misplaced('payload', 'signal');
  }
  if (body.action !== 'cancel' && body.reason !== undefined) throw misplaced('reason', 'cancel');
  if (body.action === 'signal' && (body.event === undefined || body.event === '__proto__')) {
    throw ApiError.invalid('signal needs "event", the name of the event a waitFor awaits', {
      field: 'event',
    });
  }
}

const versionConflict = (expected: number, actual: number | null) =>
  new ApiError(
    409,
    'version_conflict',
    'the execution changed since it was read, so nothing was changed',
    { expectedVersion: expected, actualVersion: actual }
  );

function refusal(action: WorkflowActionName, facts: RunFacts, idleMs: number, idleForMs: number) {
  if (action === 'recover' && !facts.idle && facts.state !== 'waiting') {
    return new ApiError(
      409,
      'workflow_progressing',
      'the execution showed progress within the idle window, so a worker may still hold it',
      { idleMs, idleForMs }
    );
  }
  return new ApiError(
    409,
    'execution_state',
    `${action} does not apply to an execution in state "${facts.state}"`,
    { state: facts.state, allowed: allowedActions(facts) }
  );
}

/** Takes the run with a version-checked write; `next.version` is the new one afterwards. */
async function claim(ctx: JobsContext, next: Execution): Promise<void> {
  const expected = next.version ?? 0;
  try {
    await ctx.store.workflows.update(next);
  } catch (error) {
    if (error instanceof ExecutionStaleError) throw versionConflict(expected, error.actual);
    throw error;
  }
}

async function publish(ctx: JobsContext, step: WorkflowStepJob, claimed: boolean): Promise<void> {
  try {
    const admitted = await ctx.store.enqueue([workflowStepJob(ctx.config.workflowQueue, step)]);
    await ringAfterCommit(
      ctx.store,
      ctx.transport,
      ctx.logger,
      admitted.flatMap((job) => (job.ring === null ? [] : [job.ring]))
    );
  } catch (error) {
    ctx.logger.warn('workflow step job could not be published', {
      executionId: step.executionId,
      error,
    });
    throw new ApiError(
      503,
      'publish_failed',
      claimed
        ? 'the execution was updated but its job could not be published: the maintenance tick publishes it again once it has been quiet for the idle window'
        : 'the job could not be published: nothing was changed, try again',
      { claimed }
    );
  }
}

const nodeJob = (exec: Execution): WorkflowStepJob => ({
  executionId: exec.id,
  workflowName: exec.workflowName,
  nodeIndex: exec.currentNodeIndex,
});

async function signal(ctx: JobsContext, id: string, body: WorkflowActionBody) {
  const event = body.event!;
  const { workflows } = ctx.store;
  let outcome;
  try {
    outcome = await workflows.recordSignal(id, event, fromWire(body.payload));
  } catch (error) {
    if (!(error instanceof SignalRejectedError)) throw error;
    throw new ApiError(
      409,
      'signal_rejected',
      error.reason === 'duplicate'
        ? 'the execution already received this event: a signal is kept once and cannot be replaced'
        : `an execution in state "${error.state}" cannot receive a signal`,
      { reason: error.reason, ...(error.state === undefined ? {} : { state: error.state }) }
    );
  }
  if (!outcome.found) throw new ApiError(404, 'execution_not_found', 'no execution has this id');
  if (!outcome.resumed) return { published: false, resumed: false, version: null };
  try {
    await publish(
      ctx,
      { executionId: id, workflowName: outcome.workflowName, nodeIndex: outcome.currentNodeIndex },
      true
    );
  } catch (error) {
    // The signal stays recorded; the run goes back to waiting so `recover` resumes it.
    await workflows.restoreSignalWait(id, event, outcome.currentNodeIndex).catch(() => false);
    throw error;
  }
  return { published: true, resumed: true, version: null };
}

export async function performWorkflowAction(
  ctx: JobsContext,
  id: string,
  body: WorkflowActionBody
): Promise<WorkflowActionResult> {
  checkBody(body);
  requireWorkflowConfirmation(id, body);
  const { workflows } = ctx.store;
  const exec = await workflows.get(id);
  if (exec === null) throw new ApiError(404, 'execution_not_found', 'no execution has this id');
  const [summary] = await workflows.summaries({ id, limit: 1 });
  const now = await workflows.now();
  const { workflowIdleMs } = ctx.config;
  const facts = runFacts(exec, summary?.waitEvent, now, workflowIdleMs);
  if (isFinished(facts)) {
    throw new ApiError(
      409,
      'execution_terminal',
      'the execution has finished, so nothing applies',
      {
        state: facts.state,
        ...(facts.rollbackStatus === undefined ? {} : { rollbackStatus: facts.rollbackStatus }),
      }
    );
  }
  if ((exec.version ?? 0) !== body.expectedVersion) {
    throw versionConflict(body.expectedVersion, exec.version ?? 0);
  }
  if (!allowedActions(facts).includes(body.action)) {
    throw refusal(body.action, facts, workflowIdleMs, now - exec.updatedAt);
  }
  const done = { action: body.action, executionId: id };

  switch (body.action) {
    case 'signal':
      return { ...done, ...(await signal(ctx, id, body)) };
    case 'cancel': {
      const next: Execution = {
        ...exec,
        state: 'failed',
        failureReason:
          body.reason === undefined
            ? 'Cancelled by an operator'
            : `Cancelled by an operator: ${body.reason}`,
      };
      await claim(ctx, next);
      await publish(ctx, { ...nodeJob(next), recover: true }, true);
      return { ...done, published: true, version: next.version ?? null };
    }
    case 'recover': {
      // A parked run whose signal is recorded goes back to running first, as `engine.recover()` does.
      const next: Execution = exec.state === 'waiting' ? { ...exec, state: 'running' } : exec;
      await claim(ctx, next);
      const owed = next.state === 'compensating' || next.state === 'failed';
      await publish(ctx, { ...nodeJob(next), ...(owed ? { recover: true as const } : {}) }, true);
      return { ...done, published: true, version: next.version ?? null };
    }
    case 'retry-compensation':
    case 'abandon-compensation':
      await publish(ctx, { ...nodeJob(exec), operator: body.action }, false);
      return { ...done, published: true, version: null };
  }
}
