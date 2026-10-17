/**
 * Persisted workflow execution, step outcome and store coordination types.
 * Ported from `../qelay/src/client/workflow/executionTypes.ts` (see docs/PORTING.md): the engine-only
 * types (`RunHandle`, `StepJobData`, `RecoverResult`, `CleanupOptions`) stay with the engine (task 61).
 */

/** Execution state */
export type ExecutionState =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'compensating'
  /**
   * A compensation failed definitively and the unwind stopped. Deliberately NOT
   * terminal: the run parks until an operator retries or abandons the unwind.
   */
  | 'compensation-stuck';

export const EXECUTION_STATES: readonly ExecutionState[] = [
  'running',
  'waiting',
  'completed',
  'failed',
  'compensating',
  'compensation-stuck',
];

/** What the engine did after a failure, independently of the failure reason. */
export type RollbackStatus =
  /** Every eligible step was compensated successfully. */
  | 'completed'
  /** The unwind ran past the pivot cutoff or had nothing left to do. */
  | 'not-applicable'
  /** A compensation failed definitively; remaining reversals were not attempted. */
  | 'stuck';

/** Step execution state */
export type StepState = 'pending' | 'running' | 'completed' | 'failed';

/** Terminal outcome of one step's rollback. */
export type CompensationStatus = 'compensated' | 'compensation-failed' | 'compensation-skipped';

export interface CompensationOutcome {
  status: CompensationStatus;
  at: number;
  /** Why it failed, or why it was skipped. */
  error?: string;
}

/** Record of a step's execution */
export interface StepRecord {
  status: StepState;
  result?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  attempts?: number;
  /**
   * Whether this step declared a compensate handler when it ran. This survives a
   * deployment that removes or renames the definition.
   */
  compensatable?: boolean;
  /** forEach iteration item, persisted so compensation can restore __item */
  loopItem?: unknown;
  /** forEach iteration index, persisted so compensation can restore __index */
  loopIndex?: number;
  /** Exactly one terminal compensation outcome for every eligible step. */
  compensation?: CompensationOutcome;
  /** Idempotency key of the forward execution, persisted before the body runs. */
  idempotencyKey?: string;
  /** Child execution owned by a sub-workflow record. */
  childExecutionId?: string;
  /** Occurrence of this step name within the run; loops reuse a single name. */
  occurrence?: number;
}

/** Full persisted execution state */
export interface Execution {
  id: string;
  workflowName: string;
  state: ExecutionState;
  input: unknown;
  steps: Record<string, StepRecord>;
  currentNodeIndex: number;
  /** Flattened names selected by resolved branch paths. */
  resolvedSteps?: string[];
  /** Durable results of control-flow decisions, keyed by node/iteration identity. */
  decisions?: Record<string, unknown>;
  /** Structural identity of the sealed workflow definition that started this run. */
  definitionHash?: string;
  /** What happened to the rollback. Independent of `failureReason`. */
  rollbackStatus?: RollbackStatus;
  /** Why the run failed. Independent of `rollbackStatus`. */
  failureReason?: string;
  /**
   * Node index at which `.pivot()` committed. Once set, backward recovery is off for
   * the whole saga and recovery is forward-only.
   */
  committedAt?: number;
  signals: Record<string, unknown>;
  /** Parent execution that owns this sub-workflow child. */
  parentExecutionId?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The row's version, set by the store: 0 when saved, then one more for every write that moves the
   * run (`update`, a wait claimed, parked, restored or expired). `update` writes only if the row is
   * still at the version this copy was read at; absent on an execution that was never saved.
   * Recording a signal into a run that does not move does not change it.
   */
  version?: number;
}

/** Stable, bounded pagination for execution listings. */
export interface ExecutionListOptions {
  /** Page size. Defaults to 100 and is capped at 1000. */
  limit?: number;
  /** Number of rows to skip in the deterministic createdAt/id order. */
  offset?: number;
}

/** Result of `recordSignal` */
export interface SignalOutcome {
  /** Whether the execution row exists */
  found: boolean;
  /** True for the single caller that claimed the resume of a parked run */
  resumed: boolean;
  workflowName: string;
  currentNodeIndex: number;
}

/** Result of `parkForSignal` */
export interface ParkOutcome {
  /** The awaited signal was already recorded: advance instead of parking */
  signalPresent: boolean;
  /** This caller transitioned the run to 'waiting' */
  parked: boolean;
  /** Signals as persisted, for refreshing a stale in-memory snapshot */
  signals: Record<string, unknown>;
}

export type WaitExpiryOutcome =
  /** This caller failed the run and now owns its rollback. */
  | { kind: 'expired' }
  /** The signal won the race; nothing was written, so advance past the gate. */
  | { kind: 'signalled'; signals: Record<string, unknown> }
  /** Another driver moved the run off this gate; neither fail nor advance it. */
  | { kind: 'moved' };

/** A parked run whose wait deadline has passed, handed to one caller for `expireWait`. */
export interface DueWait {
  readonly id: string;
  readonly workflowName: string;
  readonly event: string;
  /** The node the gate sits on: the cursor `expireWait` is fenced on. */
  readonly nodeIndex: number;
  /** The deadline the run was parked with, epoch ms. */
  readonly deadlineAt: number;
}

export interface ClaimWaitsOptions {
  /** At most this many. Default 100, at most 1000. */
  readonly limit?: number;
  /** How long the caller owns what it was handed; another caller can take a wait after that. Default 30,000. */
  readonly leaseMs?: number;
}

export interface RecoverableOptions {
  /**
   * Only executions with no progress for at least this long (ms since `updatedAt`). Default 0: every
   * recoverable execution, whatever its `updatedAt`, as upstream's single-process store returned them. A store shared by
   * several engines passes the longest a step can run, or recovery re-drives a run another engine is
   * working on.
   */
  readonly idleMs?: number;
  /** At most this many, oldest progress first. Default 1000, at most 10,000. */
  readonly limit?: number;
  /**
   * Only runs in these states. Default: every recoverable state. A sweep that has no use for runs
   * parked at a `waitFor` leaves `waiting` out, so that a store full of old approval gates cannot
   * fill its `limit` and hide a stuck `running` run behind them.
   */
  readonly states?: readonly ExecutionState[];
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;
export const DEFAULT_RETENTION_BATCH = 1000;
export const MAX_RETENTION_BATCH = 10_000;
export const DEFAULT_WAIT_BATCH = 100;
export const MAX_WAIT_BATCH = 1000;
export const DEFAULT_WAIT_LEASE_MS = 30_000;
export const DEFAULT_RECOVERABLE_LIMIT = 1000;
export const MAX_RECOVERABLE_LIMIT = 10_000;

/** The states `cleanup` and `archive` take when the caller names none. */
export const DEFAULT_RETENTION_STATES: readonly ExecutionState[] = ['completed', 'failed'];
