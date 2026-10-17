/**
 * The engine's handle on the workflow store: every read and write of an execution goes through here.
 *
 * Upstream wrote to a single-process SQLite file with a blind `UPDATE`. The store here is shared by
 * every engine of a namespace, and its `update` is a compare-and-set on the row's `version`
 * (`WorkflowStorePort.update`). Two consequences are handled in this file, so no runner has to know:
 *
 * - **One writer per run.** A `parallel` node runs several steps at once, and they share one
 *   in-memory `Execution`. Two concurrent `update(exec)` calls would both carry version v and the
 *   second would lose against the first, a "stale" write against the engine's own other write. Writes
 *   of one execution id are therefore chained: each starts when the previous has finished, and it
 *   reads the shared object only then, so it persists the latest state of every step.
 * - **A stale write means another engine owns the run.** The CAS lost against a different engine
 *   (recovery took the run over, or an operator moved it). The write throws
 *   `WorkflowExecutionClosedError` with the stale error as its cause, which every runner already
 *   treats as "stop, do not fail the run, do not compensate": the same exit as a force-closed engine.
 */

import type { Execution, WorkflowStorePort } from '@qelay-cloud/core';
import { ExecutionStaleError } from '@qelay-cloud/core';
import type { Clock } from './clock';
import type { WorkflowExecutionFence } from './executionFence';
import { isWorkflowExecutionClosed, WorkflowExecutionClosedError } from './executionFence';

/** How often a node that is running writes its execution to show it is alive, by default. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

export class RunStorage {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    readonly port: WorkflowStorePort,
    private readonly fence: WorkflowExecutionFence,
    private readonly clock: Clock,
    private readonly heartbeatMs: number = DEFAULT_HEARTBEAT_MS
  ) {}

  async get(id: string): Promise<Execution | null> {
    this.fence.assertActive();
    const exec = await this.port.get(id);
    this.fence.assertActive();
    return exec;
  }

  /**
   * Persist `exec` after the writes of the same execution that were asked for before. Resolves when
   * this write is durable. Throws `WorkflowExecutionClosedError` when another engine got there first.
   */
  async update(exec: Execution): Promise<void> {
    this.fence.assertActive();
    const previous = this.tails.get(exec.id) ?? Promise.resolve();
    const written = previous.then(() => this.write(exec));
    // The next writer waits for this one whatever its outcome; the caller still sees the error.
    const tail = written.catch(() => undefined);
    this.tails.set(exec.id, tail);
    try {
      await written;
    } finally {
      if (this.tails.get(exec.id) === tail) this.tails.delete(exec.id);
    }
  }

  private async write(exec: Execution): Promise<void> {
    this.fence.assertActive();
    try {
      await this.port.update(exec);
    } catch (error) {
      if (error instanceof ExecutionStaleError) {
        throw new WorkflowExecutionClosedError(
          `Workflow execution "${exec.id}" was taken over by another engine`,
          error
        );
      }
      throw error;
    }
    this.fence.assertActive();
  }

  /**
   * Keep `exec.updatedAt` fresh while a node runs for longer than a recovery sweep's idle window, so
   * recovery does not mistake a slow step for a dead engine. Returns the function that stops it.
   * A beat that fails is dropped: the node's own writes surface a store that is really down, and a
   * stale beat means the run was taken over, which the node's next write reports.
   */
  keepAlive(exec: Execution): () => void {
    if (this.heartbeatMs <= 0) return () => undefined;
    let stopped = false;
    let timer: ReturnType<Clock['setTimeout']> | undefined;
    const arm = (): void => {
      timer = this.clock.setTimeout(() => {
        if (stopped) return;
        this.update(exec).then(arm, (error: unknown) => {
          // A run that was taken over (or an engine that was closed) is not kept alive.
          if (!stopped && !isWorkflowExecutionClosed(error)) arm();
        });
      }, this.heartbeatMs);
      timer.unref?.();
    };
    arm();
    return () => {
      stopped = true;
      if (timer !== undefined) this.clock.clearTimeout(timer);
    };
  }
}
