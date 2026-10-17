import type { ExecutionState, WorkflowStepJob } from '@qelay-cloud/core';
import type { QueueOptions } from '../options';
import type { Clock } from './clock';
import type { WorkflowEventListener } from './eventTypes';

/** What `startWorkflow` hands back. */
export interface RunHandle {
  id: string;
  workflowName: string;
}

/** The payload of one `wf:step` job: which node of which run to advance (defined in `core`, shared with the tick and the Control API). */
export type StepJobData = WorkflowStepJob;

/** Result of `engine.recover()` and of the tick's recovery step. */
export interface RecoverResult {
  /** Running executions whose node job was published again. */
  running: number;
  /** Waiting executions resumed (signal present) or expired (deadline passed). */
  waiting: number;
  /** Compensating executions whose rollback was driven again. */
  compensating: number;
  /** Total recovered. */
  total: number;
}

export interface CleanupOptions {
  maxAge: number;
  states?: ExecutionState[];
}

/**
 * What an `Engine` is built from: the store and the doorbell as for a `Queue`, plus the engine's own
 * knobs. Qelay's `connection`, `embedded` and `dataPath` throw (see docs/compat.md).
 */
export interface EngineOptions extends Pick<
  QueueOptions,
  'databaseUrl' | 'database' | 'store' | 'transport' | 'namespace' | 'logger' | 'metrics'
> {
  /** The queue the node jobs travel on. Default `__wf:steps`. The tick must be told the same name. */
  readonly queueName?: string;
  /** Node jobs run at once. Default 5. A sub-workflow node holds its slot while it waits for its child. */
  readonly concurrency?: number;
  /** Called for every workflow event. */
  readonly onEvent?: WorkflowEventListener;
  /** Time and randomness for retries, timestamps and ids. Default: the real ones. */
  readonly clock?: Clock;
  /**
   * How long a run may show no progress before `recover()` takes it over, in ms. Must exceed the
   * longest gap between two writes of a live run; a running node writes every `heartbeatMs`.
   * Default 300,000.
   */
  readonly recoverIdleMs?: number;
  /** How often a node that runs shows its run is alive, in ms; 0 turns it off. Default 10,000. */
  readonly heartbeatMs?: number;
  /**
   * How often the engine tells the store which workflow definitions it serves, in ms; 0 turns it
   * off. The Control API reads this to show a run's graph and to warn about a run whose definition
   * no worker serves. Default 30,000.
   */
  readonly announceMs?: number;
}
