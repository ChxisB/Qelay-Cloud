import type { DeliveryTransport, Execution, WorkflowStepJob } from '@qelay-cloud/core';
import {
  DEFAULT_WORKFLOW_QUEUE,
  ExecutionStaleError,
  UnsupportedOptionError,
  WORKFLOW_STEP_JOB,
  workflowStepJob,
} from '@qelay-cloud/core';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import type { RingStepReport } from './ring';
import { ringDue } from './ring';
import type { Telemetry } from './telemetry';

/**
 * The workflow step of a tick pass: the two things a workflow run needs that no worker can do for
 * itself, because the worker that would do them is the one that is gone.
 *
 * - **Waits that ran out.** A run parked at a `waitFor` with a timeout holds a deadline in the store.
 *   This step claims the overdue ones (`claimDueWaits`, on the database's clock) and publishes a
 *   `wf:step` job flagged `due` for each; the worker fails the gate through `expireWait`, which
 *   decides the outcome (a signal that arrived first wins).
 * - **Runs that stopped moving.** A `running` run, or one whose rollback is owed, that has shown no
 *   progress for `idleMs` lost its job or its worker. A running node writes its run every few
 *   seconds, so only a dead one goes quiet. The run is taken with a version-checked write (an engine
 *   or another tick that read it earlier loses) and its node, or its unwind, is published again.
 *
 * Runs parked at a `waitFor` are NOT swept for recovery: a store full of old approval gates would
 * fill the batch and hide a stuck run behind them. A parked run whose resume publication failed is
 * picked up by `engine.recover()`.
 *
 * The step does not know the workflow definitions, only the job format `core` defines
 * (`WorkflowStepJob`, job name `wf:step`), which `packages/sdk` consumes as `StepJobData`.
 * Never throws: a store error is counted in `errors` and reported to telemetry.
 */

export { DEFAULT_WORKFLOW_QUEUE, WORKFLOW_STEP_JOB };
export const DEFAULT_WORKFLOW_BATCH = 100;
export const DEFAULT_WORKFLOW_IDLE_MS = 300_000;
export const DEFAULT_WORKFLOW_WAIT_LEASE_MS = 30_000;

/** What an operator may set. Every field is optional; see the defaults above. */
export interface WorkflowSweepOptions {
  /** The engine queue. Must be the engine's `queueName`. */
  readonly queueName?: string;
  /** Waits and stuck runs one pass handles at most, each. 0 turns the step off. */
  readonly batch?: number;
  /** How long a run may show no progress before it is taken. Must exceed the engine's heartbeat gap. */
  readonly idleMs?: number;
  /** How long a claimed overdue wait is this tick's before another tick may claim it again. */
  readonly waitLeaseMs?: number;
}

export interface WorkflowSweepConfig {
  readonly queueName: string;
  readonly batch: number;
  readonly idleMs: number;
  readonly waitLeaseMs: number;
}

/** Counts only, like the rest of the tick's reports. */
export interface WorkflowStepReport {
  /** Overdue waits published for the worker to expire. */
  readonly due: number;
  /** Stuck runs taken and published again. */
  readonly recovered: number;
  /** The step could not talk to the store (or publish). */
  readonly errors: number;
}

export const NO_WORKFLOWS: WorkflowStepReport = { due: 0, recovered: 0, errors: 0 };

export function addWorkflows(a: WorkflowStepReport, b: WorkflowStepReport): WorkflowStepReport {
  return {
    due: a.due + b.due,
    recovered: a.recovered + b.recovered,
    errors: a.errors + b.errors,
  };
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UnsupportedOptionError(name, 'must be a positive integer');
  }
  return value;
}

/** The step's settings, checked; null when `batch` is 0 and the tick sweeps nothing. */
export function resolveWorkflowConfig(options: WorkflowSweepOptions): WorkflowSweepConfig | null {
  const batch = options.batch ?? DEFAULT_WORKFLOW_BATCH;
  if (batch === 0) return null;
  const queueName = options.queueName ?? DEFAULT_WORKFLOW_QUEUE;
  if (queueName === '' || queueName.includes('\0')) {
    throw new UnsupportedOptionError(
      'workflow queueName',
      'must be a non-empty string without NUL'
    );
  }
  return {
    queueName,
    batch: positive('workflow batch', batch),
    idleMs: positive('workflow idleMs', options.idleMs ?? DEFAULT_WORKFLOW_IDLE_MS),
    waitLeaseMs: positive(
      'workflow waitLeaseMs',
      options.waitLeaseMs ?? DEFAULT_WORKFLOW_WAIT_LEASE_MS
    ),
  };
}

type Env = Readonly<Record<string, string | undefined>>;

const NUMBERS: ReadonlyArray<readonly [string, 'batch' | 'idleMs' | 'waitLeaseMs']> = [
  ['QCLOUD_WORKFLOW_BATCH', 'batch'],
  ['QCLOUD_WORKFLOW_IDLE_MS', 'idleMs'],
  ['QCLOUD_WORKFLOW_WAIT_LEASE_MS', 'waitLeaseMs'],
];

/** The step's options from the environment. Throws `UnsupportedOptionError` naming the variable. */
export function workflowOptionsFromEnv(env: Env): WorkflowSweepOptions {
  const options: { -readonly [K in keyof WorkflowSweepOptions]: WorkflowSweepOptions[K] } = {};
  for (const [name, key] of NUMBERS) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
      throw new UnsupportedOptionError(name, `must be a non-negative integer, not "${raw}"`);
    }
    options[key] = value;
  }
  const queueName = env.QCLOUD_WORKFLOW_QUEUE;
  if (queueName !== undefined && queueName !== '') options.queueName = queueName;
  return options;
}

export interface WorkflowSweepDeps {
  readonly store: PostgresStore;
  readonly transport: Pick<DeliveryTransport, 'ring' | 'capabilities'>;
  readonly telemetry: Telemetry;
}

export interface WorkflowStepResult extends WorkflowStepReport {
  /** Rings of the jobs this step published, to be added to the pass's ring report. */
  readonly ring: RingStepReport;
  /** A batch was full: another pass would find more. */
  readonly moreWork: boolean;
}

const NO_RING: RingStepReport = {
  due: 0,
  rung: 0,
  deferred: 0,
  rejected: 0,
  unreachable: 0,
  unmarked: 0,
  skipped: 0,
};

export async function sweepWorkflows(
  deps: WorkflowSweepDeps,
  config: WorkflowSweepConfig
): Promise<WorkflowStepResult> {
  const { store, telemetry } = deps;
  const started = performance.now();
  const jobs: WorkflowStepJob[] = [];
  let due = 0;
  let recovered = 0;
  let errors = 0;
  let moreWork = false;
  try {
    const waits = await store.workflows.claimDueWaits({
      limit: config.batch,
      leaseMs: config.waitLeaseMs,
    });
    for (const wait of waits) {
      jobs.push({
        executionId: wait.id,
        workflowName: wait.workflowName,
        nodeIndex: wait.nodeIndex,
        due: true,
      });
    }
    due = waits.length;
    moreWork = waits.length >= config.batch;

    const stuck = await store.workflows.listRecoverable({
      idleMs: config.idleMs,
      limit: config.batch,
      states: ['running', 'compensating', 'failed'],
    });
    for (const exec of stuck) {
      if (!(await take(store, exec))) continue;
      jobs.push({
        executionId: exec.id,
        workflowName: exec.workflowName,
        nodeIndex: exec.currentNodeIndex,
        ...(exec.state === 'running' ? {} : { recover: true as const }),
      });
      recovered += 1;
    }
    moreWork ||= stuck.length >= config.batch;
  } catch (error) {
    telemetry.error('workflows', error);
    errors += 1;
  }

  // What was claimed is published even when a later query failed: a claimed wait is otherwise
  // invisible for its lease.
  let ring = NO_RING;
  if (jobs.length > 0) {
    try {
      const admitted = await store.enqueue(
        jobs.map((step) => workflowStepJob(config.queueName, step))
      );
      ring = await ringDue(
        { store, transport: deps.transport, telemetry },
        admitted.flatMap((job) => (job.ring === null ? [] : [job.ring]))
      );
    } catch (error) {
      telemetry.error('workflows', error);
      errors += 1;
    }
  }
  telemetry.duration('workflows', Math.round(performance.now() - started));
  return { due, recovered, errors, ring, moreWork };
}

/**
 * Take a run before publishing it. The write moves the row's version, so a second tick or an engine
 * that read the run earlier loses against it and the run is published once. False when it lost.
 */
async function take(store: PostgresStore, exec: Execution): Promise<boolean> {
  try {
    await store.workflows.update(exec);
    return true;
  } catch (error) {
    if (error instanceof ExecutionStaleError) return false;
    throw error;
  }
}
