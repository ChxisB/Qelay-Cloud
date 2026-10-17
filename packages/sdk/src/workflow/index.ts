/**
 * The workflow engine: sagas, parallel branches, loops, signals and sub-workflows on top of the
 * queue. Runs are rows in the store; every node is a job on the engine queue.
 *
 * @example
 * ```typescript
 * import { Engine, defineWorkflow } from 'qelay-cloud';
 *
 * const onboarding = defineWorkflow('onboarding')
 *   .step('create', async (ctx) => { ... })
 *   .step('notify', async (ctx) => { ... });
 *
 * const engine = new Engine({ databaseUrl, transport });
 * await engine.register(onboarding);
 * const run = await engine.startWorkflow('onboarding', { email: 'user@test.com' });
 * ```
 */

import { Workflow } from './workflow';

export { Workflow } from './workflow';
export { Engine } from './engine';
export { WorkflowEmitter } from './emitter';
export { WorkflowDefinitionMismatchError } from './definitionGuard';
export { WorkflowExecutionClosedError } from './executionFence';
export { realClock } from './clock';
export type { Clock, TimerHandle } from './clock';
export type {
  StepContext,
  StepHandler,
  TypedStepHandler,
  CompensateHandler,
  TypedCompensateHandler,
  StepOptions,
  SchemaLike,
  Execution,
  ExecutionState,
  ExecutionListOptions,
  StepState,
  StepRecord,
  // Reachable from `Execution` and `StepRecord`, so a consumer that reads `exec.rollbackStatus` or
  // `record.compensation` has a name to declare a variable or a function parameter with.
  RollbackStatus,
  CompensationStatus,
  CompensationOutcome,
  BranchCondition,
  WorkflowNode,
  EngineOptions,
  RunHandle,
  StepJobData,
  ParallelDefinition,
  SubWorkflowInputMapper,
  SubWorkflowOptions,
  LoopCondition,
  ForEachItemsExtractor,
  MapTransformFn,
  LoopDefinition,
  ForEachDefinition,
  MapDefinition,
  RecoverResult,
  CleanupOptions,
  WorkflowEventType,
  WorkflowEvent,
  StepEvent,
  WorkflowLifecycleEvent,
  SignalEvent,
  WorkflowEventListener,
} from './types';

/** Start a workflow definition: the same as `new Workflow(name, options)`. */
export function defineWorkflow(
  name: string,
  options: { revision?: string | number } = {}
): Workflow {
  return new Workflow(name, options);
}
