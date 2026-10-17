import type { WorkflowInsightPort } from './workflowGraph';
import type {
  ClaimWaitsOptions,
  DueWait,
  Execution,
  ExecutionListOptions,
  ExecutionState,
  ParkOutcome,
  RecoverableOptions,
  SignalOutcome,
  WaitExpiryOutcome,
} from './workflowTypes';

/**
 * Durable workflow executions. The engine depends on this port and never on a concrete store
 * (`MemoryWorkflowStore` for tests and development, `PostgresStore.workflows` for production).
 * Extracted from upstream's `WorkflowStore` (`../qelay/src/client/workflow/store.ts`); async because
 * the database is, and with the one behaviour change that Postgres needs (see `update`).
 *
 * Who writes which column is part of the contract, because a worker holds one in-memory `Execution`
 * for the whole of a node and any full-row write from that copy would revert what happened meanwhile:
 *
 * - `update` and `expireWait` write the step-level columns and the state (never `signals`);
 * - `recordSignal`, `parkForSignal` and `restoreSignalWait` own `signals` and the waiting transitions.
 */
export interface WorkflowStorePort extends WorkflowInsightPort {
  /**
   * Inserts a new execution and sets its `version` to 0. Throws `ExecutionExistsError` when the id is
   * taken, and refuses one that already carries signals (they would overwrite delivered ones).
   */
  save(exec: Execution): Promise<void>;

  /**
   * The store's clock in epoch milliseconds: the time that `claimDueWaits`, `listRecoverable` and
   * every stored `updatedAt` are measured against. An engine reads wait deadlines from it rather than
   * from its own clock, so a host with a skewed clock cannot park a run for too long or too short.
   */
  now(): Promise<number>;

  get(id: string): Promise<Execution | null>;

  /** The child of `parentExecutionId` that runs `workflowName`, if one was saved. */
  findChild(parentExecutionId: string, workflowName: string): Promise<Execution | null>;

  /** Removes an execution whose initial queue publication failed. False when there was none. */
  remove(id: string): Promise<boolean>;

  /**
   * Writes the step-level columns of `exec` and its state, if the row is still at `exec.version`.
   * On success `exec.version` and `exec.updatedAt` are the new ones. Otherwise throws
   * `ExecutionStaleError` and writes nothing: another engine owns the run now, and the caller stops.
   * Does not write `signals`.
   *
   * Upstream's `update` was a blind write. Two engines sharing one database can both read a run and
   * both advance it, so it is a compare-and-set here.
   */
  update(exec: Execution): Promise<void>;

  /**
   * Records a signal and, when the run is parked at a `waitFor`, claims its single resume for this
   * caller. Throws `SignalRejectedError` when the run is not live or the event was already received.
   * A signal recorded into a run that is not parked does not change its version.
   */
  recordSignal(id: string, event: string, payload: unknown): Promise<SignalOutcome>;

  /**
   * Puts a claimed wait back when publishing its resume job failed. The signal stays recorded, so
   * recovery sees the waiting row plus the signal and resumes it. Fenced on the cursor. The row shows
   * the event it awaited again (`summaries().waitEvent`, with no deadline: the claim ended it), which is
   * how an operator tells such a row from a parked run still waiting for its signal.
   */
  restoreSignalWait(id: string, event: string, nodeIndex: number): Promise<boolean>;

  /**
   * Parks a running execution at a `waitFor`, unless the awaited signal has already been recorded
   * (then the caller advances). Idempotent from `waiting`. `deadlineAt` (epoch ms) is when the wait
   * times out, for `claimDueWaits`; omit it for a wait with no timeout.
   */
  parkForSignal(id: string, event: string, deadlineAt?: number): Promise<ParkOutcome>;

  /**
   * Fails a timed-out `waitFor` only while its signal is still absent, in one claim that
   * `recordSignal` cannot interleave with. `failed` is the caller's copy with the failure applied.
   */
  expireWait(failed: Execution, event: string, nodeIndex: number): Promise<WaitExpiryOutcome>;

  /**
   * Hands out parked runs whose deadline has passed, each to one caller at a time for `leaseMs`
   * (concurrent callers skip what another holds). The caller then runs `expireWait` for each; that
   * claim, not this lease, decides the outcome. Runs parked without a deadline are never returned.
   */
  claimDueWaits(options?: ClaimWaitsOptions): Promise<DueWait[]>;

  /** Newest first, in pages. `limit` 1 to 1000 (default 100), `offset` from 0. */
  list(
    workflowName?: string,
    state?: ExecutionState,
    options?: ExecutionListOptions
  ): Promise<Execution[]>;

  /** Runs whose registered definition must remain available and structurally stable. */
  listActive(workflowName: string): Promise<Execution[]>;

  /**
   * Executions in a recoverable state that recovery may drive on its own, oldest progress first. A
   * sub-workflow child is left to its parent unless the parent row is gone, and a failed run whose
   * rollback has an outcome is finished.
   */
  listRecoverable(options?: RecoverableOptions): Promise<Execution[]>;

  /**
   * Deletes up to `limit` (default 1000) executions in `states` (default completed and failed) whose
   * `updatedAt` is at least `maxAgeMs` old, oldest first. The cutoff is inclusive, so `cleanup(0)`
   * flushes what is terminal right now. Returns how many; call again until it returns fewer than `limit`.
   */
  cleanup(maxAgeMs: number, states?: readonly ExecutionState[], limit?: number): Promise<number>;

  /** As `cleanup`, but moves them to the archive instead of deleting them. */
  archive(maxAgeMs: number, states?: readonly ExecutionState[], limit?: number): Promise<number>;

  getArchivedCount(): Promise<number>;
}
