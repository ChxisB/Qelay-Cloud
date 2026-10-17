/**
 * Engine: the public facade of the workflow engine.
 *
 * It owns one SDK `Queue` and one `Worker` on the engine queue, and the workflow side of the store
 * both share. Every node is a `wf:step` job; the store, not this process, holds the run.
 */

import type { Execution, ExecutionState, ExecutionListOptions } from '@qelay-cloud/core';
import { DEFAULT_WORKFLOW_QUEUE, UnsupportedOptionError } from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { checkQueueName, rejectLegacyOptions, ringWindowMs } from '../options';
import { Queue } from '../queue';
import { openStore } from '../runtime';
import { Worker } from '../worker';
import { DefinitionAnnouncer, DEFAULT_ANNOUNCE_MS } from './announcer';
import { realClock } from './clock';
import { WorkflowEmitter } from './emitter';
import { WorkflowExecutor } from './executor';
import type {
  EngineOptions,
  RecoverResult,
  RunHandle,
  StepJobData,
  WorkflowEventListener,
  WorkflowEventType,
} from './types';
import type { Workflow } from './workflow';

export const DEFAULT_QUEUE_NAME = DEFAULT_WORKFLOW_QUEUE;
const DEFAULT_RECOVER_IDLE_MS = 300_000;

export class Engine {
  private readonly queue: Queue<StepJobData>;
  private readonly worker: Worker<StepJobData>;
  private readonly executor: WorkflowExecutor;
  private readonly emitter: WorkflowEmitter;
  private readonly announcer: DefinitionAnnouncer;
  private readonly ownedStore: PostgresStore | null;

  constructor(opts: EngineOptions) {
    rejectLegacyOptions(opts);
    const queueName = checkQueueName(opts.queueName ?? DEFAULT_QUEUE_NAME);
    const { transport, logger, metrics } = opts;
    if (transport === undefined || transport === null) {
      throw new UnsupportedOptionError('transport', 'is required: pass a DeliveryTransport');
    }
    const clock = opts.clock ?? realClock;
    const { store, owned } = openStore(opts, ringWindowMs(transport));
    this.ownedStore = owned ? store : null;
    try {
      this.queue = new Queue<StepJobData>(queueName, {
        store,
        transport,
        logger,
        metrics,
        defaultJobOptions: { removeOnComplete: true },
      });
      this.emitter = new WorkflowEmitter(clock);
      if (opts.onEvent) this.emitter.onAny(opts.onEvent);
      this.executor = new WorkflowExecutor(store.workflows, this.queue, this.emitter, {
        clock,
        recoverIdleMs: opts.recoverIdleMs ?? DEFAULT_RECOVER_IDLE_MS,
        ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }),
      });
      this.announcer = new DefinitionAnnouncer(
        store.workflows,
        opts.announceMs ?? DEFAULT_ANNOUNCE_MS,
        (error) =>
          logger?.warn('workflow definition could not be announced', {
            error: error instanceof Error ? error.message : String(error),
          })
      );
      this.worker = new Worker<StepJobData>(
        queueName,
        async (job) => await this.executor.processStep(job.data),
        { store, transport, logger, metrics, concurrency: opts.concurrency ?? 5 }
      );
    } catch (error) {
      // Nothing else holds the pool this engine opened.
      if (owned) void store.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Register a workflow definition. Async, unlike upstream: it checks the store for live runs of an
   * older definition under the same name and refuses (`WorkflowDefinitionMismatchError`).
   */
  async register(workflow: Workflow): Promise<this> {
    await this.executor.register(workflow);
    await this.announcer.add(workflow);
    return this;
  }

  /** Start a new workflow execution */
  async start(workflowName: string, input?: unknown): Promise<RunHandle> {
    return await this.executor.start(workflowName, input);
  }

  /** Same as `start`, under the name the SDK documents. */
  async startWorkflow(workflowName: string, input?: unknown): Promise<RunHandle> {
    return await this.executor.start(workflowName, input);
  }

  /** Get execution state by ID */
  async getExecution(id: string): Promise<Execution | null> {
    return await this.executor.getExecution(id);
  }

  /** List executions with optional filters, newest first */
  async listExecutions(
    workflowName?: string,
    state?: ExecutionState,
    options?: ExecutionListOptions
  ): Promise<Execution[]> {
    return await this.executor.listExecutions(workflowName, state, options);
  }

  /** Send a signal to a waiting execution */
  async signal(executionId: string, event: string, payload?: unknown): Promise<void> {
    await this.executor.signal(executionId, event, payload);
  }

  /** Stop a live execution and roll it back. Not in upstream. */
  async cancel(executionId: string, reason?: string): Promise<void> {
    await this.executor.cancel(executionId, reason);
  }

  /**
   * Retry the compensation that parked a `compensation-stuck` run and continue the unwind. Use once
   * the cause of the failed reversal has been fixed.
   */
  async resumeCompensation(executionId: string): Promise<void> {
    await this.executor.resumeCompensation(executionId);
  }

  /**
   * Abandon a parked unwind: the steps still un-compensated are recorded as skipped and the run
   * becomes terminal. Partial, but explicitly so.
   */
  async abandonCompensation(executionId: string): Promise<void> {
    await this.executor.abandonCompensation(executionId);
  }

  /**
   * Take over runs that have shown no progress for `idleMs` (default: `recoverIdleMs`), which the
   * maintenance tick also does on its own for `running` and `compensating` runs:
   * - 'running' executions: published again at their current step
   * - 'waiting' executions: resumed if the signal arrived, expired if the deadline has passed
   * - 'compensating' executions: compensation run again (handlers must be idempotent)
   */
  async recover(options?: { idleMs?: number; limit?: number }): Promise<RecoverResult> {
    return await this.executor.recover(options);
  }

  // ============ Observability ============

  on(type: WorkflowEventType, listener: WorkflowEventListener): this {
    this.emitter.on(type, listener);
    return this;
  }

  onAny(listener: WorkflowEventListener): this {
    this.emitter.onAny(listener);
    return this;
  }

  off(type: WorkflowEventType, listener: WorkflowEventListener): this {
    this.emitter.off(type, listener);
    return this;
  }

  offAny(listener: WorkflowEventListener): this {
    this.emitter.offAny(listener);
    return this;
  }

  /** Subscribe to all events for a specific execution */
  subscribe(executionId: string, callback: WorkflowEventListener): () => void {
    const filter: WorkflowEventListener = (event) => {
      if (event.executionId === executionId) callback(event);
    };
    this.emitter.onAny(filter);
    return () => this.emitter.offAny(filter);
  }

  // ============ Cleanup ============

  /** Remove up to `limit` (default 1000) old completed/failed executions; call again while it returns `limit`. */
  async cleanup(maxAgeMs: number, states?: ExecutionState[], limit?: number): Promise<number> {
    return await this.executor.cleanup(maxAgeMs, states, limit);
  }

  /** Move old executions to the archive, in batches as `cleanup` */
  async archive(maxAgeMs: number, states?: ExecutionState[], limit?: number): Promise<number> {
    return await this.executor.archive(maxAgeMs, states, limit);
  }

  async getArchivedCount(): Promise<number> {
    return await this.executor.getArchivedCount();
  }

  /** Shut down the engine. The transport, and a store passed in, stay open. */
  async close(force = false): Promise<void> {
    this.executor.close(force);
    await this.announcer.close();
    await this.worker.close(force);
    await this.queue.close();
    if (this.ownedStore) await this.ownedStore.close();
    this.emitter.removeAllListeners();
  }
}
