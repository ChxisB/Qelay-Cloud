/** WorkflowExecutor: the engine's execution logic, driven by `wf:step` jobs. */

import type { Execution, ExecutionListOptions, WorkflowStorePort } from '@qelay-cloud/core';
import type { Queue } from '../queue';
import { claimKey, decideAdmission } from './admission';
import type { Clock } from './clock';
import type { CompensationEnv } from './compensationEnv';
import { runCompensation, WaitForSignalError } from './compensator';
import { bindExecutionDefinition } from './definitionGuard';
import type { WorkflowEmitter } from './emitter';
import { isWorkflowExecutionClosed, WorkflowExecutionFence } from './executionFence';
import type { FailureEnv } from './executorFailure';
import { cancelRun, failRun } from './executorFailure';
import { signalExecution, startExecution } from './executorLifecycle';
import { executeWorkflowNode } from './executorNodes';
import { operatorJob, recoverJob } from './executorOperatorJob';
import { enqueueWorkflowStep } from './executorQueue';
import { describeError } from './identity';
import { recoverExecutions } from './recovery';
import { checkRegistration } from './registration';
import { abandonParkedCompensation, resumeCompensation } from './rollbackControl';
import { RunStorage } from './storage';
import type { RecoverResult, RunHandle, StepJobData, WorkflowNode } from './types';
import type { WaitForDeps } from './waitFor';
import type { Workflow } from './workflow';

export interface ExecutorOptions {
  clock: Clock;
  /** Heartbeat of a running node, ms; 0 is off. */
  heartbeatMs?: number;
  /** Default idle window of `recover()`, ms. */
  recoverIdleMs: number;
}

export class WorkflowExecutor {
  private readonly workflows = new Map<string, Workflow>();
  private readonly fence = new WorkflowExecutionFence();
  private readonly storage: RunStorage;
  private readonly clock: Clock;
  /**
   * Nodes this process is executing, keyed `<execution>:<nodeIndex>`. The cursor rejects stale jobs
   * but not two overlapping deliveries for the current node; this claim drops that overlap.
   * Queue-level dedup is unsuitable: a retained id can swallow a legitimate recovery publish.
   */
  private readonly nodesInFlight = new Set<string>();
  /** The heartbeat of each running node, so `advance` can stop it before the next node is published. */
  private readonly beats = new Map<string, () => void>();
  private readonly updateFn: (exec: Execution) => Promise<void>;

  constructor(
    port: WorkflowStorePort,
    private readonly queue: Queue<StepJobData>,
    private readonly emitter: WorkflowEmitter | null,
    private readonly options: ExecutorOptions
  ) {
    this.clock = options.clock;
    this.storage = new RunStorage(port, this.fence, this.clock, options.heartbeatMs);
    this.updateFn = (exec) => this.storage.update(exec);
  }

  /** Abort in-flight control flow when `force` is set. A graceful close leaves running nodes alone. */
  close(force = false): void {
    this.fence.close(force);
  }

  async register(workflow: Workflow): Promise<void> {
    this.fence.assertActive();
    await checkRegistration(workflow, this.storage.port, this.workflows);
    this.fence.assertActive();
    this.workflows.set(workflow.name, workflow);
  }

  async start(
    workflowName: string,
    input: unknown,
    parentExecutionId?: string
  ): Promise<RunHandle> {
    return await startExecution(this.lifecycle, workflowName, input, parentExecutionId);
  }

  async signal(executionId: string, event: string, payload: unknown): Promise<void> {
    await signalExecution(this.lifecycle, executionId, event, payload);
  }

  async getExecution(id: string): Promise<Execution | null> {
    return await this.storage.get(id);
  }

  async listExecutions(
    workflowName?: string,
    state?: Execution['state'],
    options?: ExecutionListOptions
  ): Promise<Execution[]> {
    this.fence.assertActive();
    return await this.storage.port.list(workflowName, state, options);
  }

  /** Run the node a `wf:step` job names. Returns null whenever the job should simply end. */
  async processStep(data: StepJobData): Promise<unknown> {
    try {
      this.fence.assertActive();
      if (data.operator !== undefined) return await operatorJob(this.jobDeps, data);
      if (data.recover === true) return await recoverJob(this.jobDeps, data);
      const exec = await this.storage.get(data.executionId);
      // Admission is pure; this method only owns the in-flight claim and dispatch.
      const admission = decideAdmission(exec, data.nodeIndex, this.nodesInFlight);
      if (admission.kind === 'reject' || !exec) return null;
      const claim = claimKey(data.executionId, data.nodeIndex);
      this.nodesInFlight.add(claim);
      try {
        return await this.runNode(data, exec);
      } finally {
        this.nodesInFlight.delete(claim);
      }
    } catch (error) {
      // A closed engine, or a run another engine took over: stop quietly, the new owner carries on.
      if (isWorkflowExecutionClosed(error)) return null;
      throw error;
    }
  }

  private async runNode(data: StepJobData, exec: Execution): Promise<unknown> {
    const wf = this.workflows.get(exec.workflowName);
    if (!wf) throw new Error(`Workflow "${exec.workflowName}" not registered`);
    await bindExecutionDefinition(exec, wf, this.updateFn);

    // If waiting, set back to running for the timeout re-check.
    if (exec.state === 'waiting') exec.state = 'running';

    const stop = this.storage.keepAlive(exec);
    this.beats.set(exec.id, stop);
    try {
      const node = wf.nodes[data.nodeIndex] as WorkflowNode | undefined;
      if (!node) {
        exec.state = 'completed';
        await this.updateFn(exec);
        this.emitter?.emitWorkflow('workflow:completed', exec.id, exec.workflowName, 'completed');
        return null;
      }
      try {
        await executeWorkflowNode(this.nodeDeps(data.due === true), exec, node, data.nodeIndex, wf);
      } catch (err) {
        if (!this.fence.isActive() || isWorkflowExecutionClosed(err)) return null;
        if (err instanceof WaitForSignalError) return null;
        await this.fail(exec, wf, describeError(err));
        throw err;
      }
      return null;
    } finally {
      stop();
      if (this.beats.get(exec.id) === stop) this.beats.delete(exec.id);
    }
  }

  private async fail(exec: Execution, wf: Workflow, reason: string): Promise<void> {
    await failRun(this.failureEnv, exec, wf, reason);
  }

  /** Stop a live run and roll it back (not in upstream; see `cancelRun`). */
  async cancel(executionId: string, reason = 'cancelled'): Promise<void> {
    await cancelRun(this.failureEnv, executionId, reason);
  }

  /** Retry the compensation that parked the run, then finish the unwind. */
  async resumeCompensation(executionId: string): Promise<void> {
    await resumeCompensation(this.rollbackDeps, executionId);
  }

  /** Give up on a parked unwind, recording the outstanding steps as skipped. */
  async abandonCompensation(executionId: string): Promise<void> {
    await abandonParkedCompensation(this.rollbackDeps, executionId);
  }

  /** Take over runs that have shown no progress for `idleMs` (default: the engine's `recoverIdleMs`). */
  async recover(options: { idleMs?: number; limit?: number } = {}): Promise<RecoverResult> {
    this.fence.assertActive();
    return await recoverExecutions({
      storage: this.storage,
      queue: this.queue,
      env: this.env,
      workflows: this.workflows,
      nodesInFlight: this.nodesInFlight,
      assertActive: this.fence.assertActive,
      idleMs: options.idleMs ?? this.options.recoverIdleMs,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  async cleanup(maxAgeMs: number, states?: Execution['state'][], limit?: number): Promise<number> {
    this.fence.assertActive();
    return await this.storage.port.cleanup(maxAgeMs, states, limit);
  }

  async archive(maxAgeMs: number, states?: Execution['state'][], limit?: number): Promise<number> {
    this.fence.assertActive();
    return await this.storage.port.archive(maxAgeMs, states, limit);
  }

  async getArchivedCount(): Promise<number> {
    this.fence.assertActive();
    return await this.storage.port.getArchivedCount();
  }

  private get lifecycle() {
    return {
      storage: this.storage,
      queue: this.queue,
      workflows: this.workflows,
      emitter: this.emitter,
      clock: this.clock,
      enqueue: (exec: Execution) => this.enqueue(exec),
      assertActive: this.fence.assertActive,
    };
  }

  private get env(): CompensationEnv {
    return {
      storage: this.storage,
      emitter: this.emitter,
      clock: this.clock,
      workflows: this.workflows,
      assertActive: this.fence.assertActive,
    };
  }

  private get failureEnv(): FailureEnv {
    return { ...this.env, isActive: () => this.fence.isActive() };
  }

  private get jobDeps() {
    return {
      storage: this.storage,
      env: this.env,
      workflows: this.workflows,
      assertActive: this.fence.assertActive,
    };
  }

  private get rollbackDeps() {
    return { ...this.env, workflows: this.workflows };
  }

  private nodeDeps(due: boolean) {
    return {
      storage: this.storage,
      emitter: this.emitter,
      clock: this.clock,
      updateFn: this.updateFn,
      advance: (exec: Execution, nextIdx: number, wf: Workflow) => this.advance(exec, nextIdx, wf),
      start: (name: string, input: unknown, parentId: string) => this.start(name, input, parentId),
      enqueue: (exec: Execution) => this.enqueue(exec),
      waitFor: this.waitForDeps(due),
      assertActive: this.fence.assertActive,
    };
  }

  private waitForDeps(due: boolean): WaitForDeps {
    return {
      storage: this.storage,
      emitter: this.emitter,
      clock: this.clock,
      advance: (exec, next, wf) => this.advance(exec, next, wf),
      compensate: (exec, wf) => this.compensate(exec, wf),
      updateFn: this.updateFn,
      assertActive: this.fence.assertActive,
      due,
    };
  }

  private async advance(exec: Execution, nextIdx: number, wf: Workflow): Promise<void> {
    this.fence.assertActive();
    // The node is done. A beat that fired after the next node's job was published could win the
    // version from that node's first write and make it stand down.
    this.beats.get(exec.id)?.();
    exec.currentNodeIndex = nextIdx;
    const done = nextIdx >= wf.nodes.length;
    if (done) exec.state = 'completed';
    await this.updateFn(exec);
    if (done) {
      this.emitter?.emitWorkflow('workflow:completed', exec.id, exec.workflowName, 'completed');
    } else {
      await this.enqueue(exec);
    }
  }

  private async enqueue(exec: Execution): Promise<void> {
    await enqueueWorkflowStep(this.queue, exec, this.fence.assertActive);
  }

  private async compensate(exec: Execution, wf: Workflow): Promise<void> {
    this.fence.assertActive();
    await runCompensation(exec, wf, this.env);
  }
}
