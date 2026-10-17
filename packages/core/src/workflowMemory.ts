import type { Clock } from './clock';
import { systemClock } from './clock';
import { ExecutionExistsError, ExecutionStaleError, SignalRejectedError } from './errors';
import { MemoryWorkflowInsight } from './workflowMemoryInsight';
import { byCreated, byProgress, copy, keepIdentity } from './workflowMemoryRows';
import {
  ACTIVE_STATES,
  assertNewExecution,
  boundedCount,
  hasSignal,
  isActive,
  isLive,
  pageBounds,
  recoverableStates,
  retentionAge,
  retentionStates,
  setSignal,
  waitDeadline,
} from './workflowRules';
import type { WorkflowStorePort } from './workflowStore';
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
import {
  DEFAULT_RECOVERABLE_LIMIT,
  DEFAULT_RETENTION_BATCH,
  DEFAULT_RETENTION_STATES,
  DEFAULT_WAIT_BATCH,
  DEFAULT_WAIT_LEASE_MS,
  MAX_RECOVERABLE_LIMIT,
  MAX_RETENTION_BATCH,
  MAX_WAIT_BATCH,
} from './workflowTypes';

/**
 * The reference implementation of `WorkflowStorePort`: the same rules in plain objects, so the
 * Postgres store can be compared with it command by command. Not durable and not shared between
 * processes; for tests and for development without a database. Every call is atomic because nothing
 * in it awaits between a read and the write that depends on it.
 */
export class MemoryWorkflowStore extends MemoryWorkflowInsight implements WorkflowStorePort {
  private readonly archived = new Map<string, Execution>();

  constructor(clock: Clock = systemClock) {
    super(clock);
  }

  async now(): Promise<number> {
    return this.clock.now();
  }

  async save(exec: Execution): Promise<void> {
    assertNewExecution(exec);
    if (this.rows.has(exec.id)) throw new ExecutionExistsError(exec.id);
    exec.version = 0;
    this.rows.set(exec.id, { exec: copy(exec), wait: null });
  }

  async get(id: string): Promise<Execution | null> {
    const row = this.rows.get(id);
    return row ? copy(row.exec) : null;
  }

  async findChild(parentExecutionId: string, workflowName: string): Promise<Execution | null> {
    const children = [...this.rows.values()]
      .map((row) => row.exec)
      .filter((e) => e.parentExecutionId === parentExecutionId && e.workflowName === workflowName)
      .sort((a, b) => byCreated(b, a));
    return children[0] ? copy(children[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async update(exec: Execution): Promise<void> {
    if (exec.version === undefined) {
      throw new TypeError('update() needs an execution that was read from the store (no version)');
    }
    const row = this.rows.get(exec.id);
    if (!row || row.exec.version !== exec.version) {
      throw new ExecutionStaleError(exec.id, exec.version, row?.exec.version ?? null);
    }
    const next = copy(exec);
    keepIdentity(next, row.exec);
    next.updatedAt = this.clock.now();
    next.version = exec.version + 1;
    row.exec = next;
    if (next.state !== 'waiting') row.wait = null;
    exec.updatedAt = next.updatedAt;
    exec.version = next.version;
  }

  async recordSignal(id: string, event: string, payload: unknown): Promise<SignalOutcome> {
    const row = this.rows.get(id);
    if (!row) return { found: false, resumed: false, workflowName: '', currentNodeIndex: 0 };
    const { exec } = row;
    if (!isLive(exec.state)) throw new SignalRejectedError(id, event, 'state', exec.state);
    if (hasSignal(exec.signals, event)) throw new SignalRejectedError(id, event, 'duplicate');
    setSignal(exec.signals, event, payload);
    exec.updatedAt = this.clock.now();
    const resumed = exec.state === 'waiting';
    if (resumed) {
      exec.state = 'running';
      exec.version = (exec.version ?? 0) + 1;
      row.wait = null;
    }
    return {
      found: true,
      resumed,
      workflowName: exec.workflowName,
      currentNodeIndex: exec.currentNodeIndex,
    };
  }

  async restoreSignalWait(id: string, event: string, nodeIndex: number): Promise<boolean> {
    const exec = this.rows.get(id)?.exec;
    if (!exec || exec.currentNodeIndex !== nodeIndex || exec.state !== 'running') return false;
    if (!hasSignal(exec.signals, event)) return false;
    exec.state = 'waiting';
    exec.updatedAt = this.clock.now();
    exec.version = (exec.version ?? 0) + 1;
    const row = this.rows.get(id)!;
    row.wait = { event, deadlineAt: null, leaseUntil: null };
    return true;
  }

  async parkForSignal(id: string, event: string, deadlineAt?: number): Promise<ParkOutcome> {
    const deadline = waitDeadline(deadlineAt);
    const row = this.rows.get(id);
    if (!row) return { signalPresent: false, parked: false, signals: {} };
    const { exec } = row;
    const signals = structuredClone(exec.signals);
    if (hasSignal(exec.signals, event)) return { signalPresent: true, parked: false, signals };
    if (!isLive(exec.state)) return { signalPresent: false, parked: false, signals };
    if (exec.state === 'running') exec.version = (exec.version ?? 0) + 1;
    exec.state = 'waiting';
    exec.updatedAt = this.clock.now();
    row.wait = { event, deadlineAt: deadline, leaseUntil: null };
    return { signalPresent: false, parked: true, signals };
  }

  async expireWait(
    failed: Execution,
    event: string,
    nodeIndex: number
  ): Promise<WaitExpiryOutcome> {
    const row = this.rows.get(failed.id);
    if (!row || row.exec.currentNodeIndex !== nodeIndex || !isLive(row.exec.state)) {
      return { kind: 'moved' };
    }
    if (hasSignal(row.exec.signals, event)) {
      return { kind: 'signalled', signals: structuredClone(row.exec.signals) };
    }
    const next = copy(failed);
    next.state = 'failed';
    next.currentNodeIndex = row.exec.currentNodeIndex;
    keepIdentity(next, row.exec);
    next.updatedAt = this.clock.now();
    next.version = (row.exec.version ?? 0) + 1;
    row.exec = next;
    row.wait = null;
    failed.updatedAt = next.updatedAt;
    failed.version = next.version;
    return { kind: 'expired' };
  }

  async claimDueWaits(options: ClaimWaitsOptions = {}): Promise<DueWait[]> {
    const limit = boundedCount(
      'Wait claim limit',
      options.limit,
      DEFAULT_WAIT_BATCH,
      MAX_WAIT_BATCH
    );
    const leaseMs = boundedCount('Wait lease', options.leaseMs, DEFAULT_WAIT_LEASE_MS, 3_600_000);
    const now = this.clock.now();
    const due = [...this.rows.values()]
      .filter(({ exec, wait }) => {
        if (exec.state !== 'waiting' || !wait || wait.deadlineAt === null) return false;
        return wait.deadlineAt <= now && (wait.leaseUntil === null || wait.leaseUntil <= now);
      })
      .sort((a, b) => a.wait!.deadlineAt! - b.wait!.deadlineAt! || (a.exec.id < b.exec.id ? -1 : 1))
      .slice(0, limit);
    return due.map(({ exec, wait }) => {
      wait!.leaseUntil = now + leaseMs;
      return {
        id: exec.id,
        workflowName: exec.workflowName,
        event: wait!.event,
        nodeIndex: exec.currentNodeIndex,
        deadlineAt: wait!.deadlineAt!,
      };
    });
  }

  async list(
    workflowName?: string,
    state?: ExecutionState,
    options: ExecutionListOptions = {}
  ): Promise<Execution[]> {
    const { limit, offset } = pageBounds(options);
    return [...this.rows.values()]
      .map((row) => row.exec)
      .filter(
        (e) =>
          (workflowName === undefined || e.workflowName === workflowName) &&
          (state === undefined || e.state === state)
      )
      .sort(byCreated)
      .slice(offset, offset + limit)
      .map(copy);
  }

  async listActive(workflowName: string): Promise<Execution[]> {
    return [...this.rows.values()]
      .map((row) => row.exec)
      .filter(
        (e) => e.workflowName === workflowName && ACTIVE_STATES.includes(e.state) && isActive(e)
      )
      .sort(byProgress)
      .map(copy);
  }

  async listRecoverable(options: RecoverableOptions = {}): Promise<Execution[]> {
    const limit = boundedCount(
      'Recoverable limit',
      options.limit,
      DEFAULT_RECOVERABLE_LIMIT,
      MAX_RECOVERABLE_LIMIT
    );
    const idle = retentionAge(options.idleMs ?? 0);
    const states = recoverableStates(options.states);
    const cutoff = idle === 0 ? Number.POSITIVE_INFINITY : this.clock.now() - idle;
    return [...this.rows.values()]
      .map((row) => row.exec)
      .filter((e) => states.includes(e.state) && isActive(e) && e.updatedAt <= cutoff)
      .filter((e) => !e.parentExecutionId || !this.rows.has(e.parentExecutionId))
      .sort(byProgress)
      .slice(0, limit)
      .map(copy);
  }

  async cleanup(
    maxAgeMs: number,
    states: readonly ExecutionState[] = DEFAULT_RETENTION_STATES,
    limit?: number
  ): Promise<number> {
    return this.retire(maxAgeMs, states, limit, false);
  }

  async archive(
    maxAgeMs: number,
    states: readonly ExecutionState[] = DEFAULT_RETENTION_STATES,
    limit?: number
  ): Promise<number> {
    return this.retire(maxAgeMs, states, limit, true);
  }

  async getArchivedCount(): Promise<number> {
    return this.archived.size;
  }

  private retire(
    maxAgeMs: number,
    states: readonly string[],
    limit: number | undefined,
    keep: boolean
  ): number {
    const batch = boundedCount(
      'Retention batch',
      limit,
      DEFAULT_RETENTION_BATCH,
      MAX_RETENTION_BATCH
    );
    const named = retentionStates(states);
    const cutoff = this.clock.now() - retentionAge(maxAgeMs);
    const old = [...this.rows.values()]
      .map((row) => row.exec)
      .filter((e) => named.includes(e.state) && e.updatedAt <= cutoff)
      .sort(byProgress)
      .slice(0, batch);
    for (const exec of old) {
      this.rows.delete(exec.id);
      if (keep) this.archived.set(exec.id, copy(exec));
    }
    return old.length;
  }
}
