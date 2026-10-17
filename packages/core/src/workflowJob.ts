import type { NewJob } from './jobs';
import { validateJobOptions } from './options';

/**
 * The job a workflow node is. One definition for everyone who publishes one: the SDK engine (a node, a
 * resume), the maintenance tick (a wait that ran out, a run that stopped moving) and the Control API
 * (an operator action). The engine consumes it; the others publish it without knowing any workflow
 * definition.
 */

/** The job name every engine node job carries. */
export const WORKFLOW_STEP_JOB = 'wf:step';

/** The engine queue unless `QCLOUD_WORKFLOW_QUEUE` or the engine's `queueName` says otherwise. */
export const DEFAULT_WORKFLOW_QUEUE = '__wf:steps';

/** What an operator may ask a worker to do to a parked run. */
export type WorkflowOperatorAction = 'retry-compensation' | 'abandon-compensation';

/** The payload of one `wf:step` job: which node of which run to advance. */
export interface WorkflowStepJob {
  readonly executionId: string;
  readonly workflowName: string;
  readonly nodeIndex: number;
  /**
   * Set by the tick for a wait whose durable deadline has passed. The store clock decided it, so
   * the worker treats the deadline as reached instead of measuring it against its own clock.
   */
  readonly due?: true;
  /**
   * Set by the tick, and by an operator, for a run whose rollback was owed when its engine died
   * (`compensating`, or `failed` with no outcome yet). The job drives the unwind again instead of
   * running a node.
   */
  readonly recover?: true;
  /**
   * Set by the Control API for a parked unwind (`compensation-stuck`): the worker holds the workflow
   * definition, so it retries the failed reversal or records the rest as skipped.
   */
  readonly operator?: WorkflowOperatorAction;
}

/** The job to publish for `step` on the engine queue `queue`. */
export function workflowStepJob(queue: string, step: WorkflowStepJob): NewJob {
  return {
    queue,
    name: WORKFLOW_STEP_JOB,
    data: step,
    options: validateJobOptions({ removeOnComplete: true }),
  };
}
