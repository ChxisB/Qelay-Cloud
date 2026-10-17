import type { ExecutionState } from './workflowTypes';

/**
 * What a worker announces about a workflow it can run, and what an operator surface may read back
 * without holding the code: the step graph with its settings (never a handler), the definition
 * hash a run is bound to, and when a worker last said it still serves it.
 *
 * `currentNodeIndex` of an execution is an index into `WorkflowDefinitionRecord.graph`.
 */

export interface WorkflowGraphStep {
  readonly name: string;
  readonly retry: number;
  readonly timeout: number;
  /** The step declared a compensate handler. */
  readonly compensates: boolean;
}

export type WorkflowGraphNode =
  | { readonly type: 'step'; readonly step: WorkflowGraphStep }
  | {
      readonly type: 'branch';
      readonly paths: ReadonlyArray<{
        readonly name: string;
        readonly steps: readonly WorkflowGraphStep[];
      }>;
    }
  | { readonly type: 'waitFor'; readonly event: string; readonly timeout: number | null }
  | { readonly type: 'parallel'; readonly steps: readonly WorkflowGraphStep[] }
  | { readonly type: 'subWorkflow'; readonly name: string; readonly timeout: number }
  | {
      readonly type: 'doUntil' | 'doWhile';
      readonly maxIterations: number;
      readonly steps: readonly WorkflowGraphStep[];
    }
  | { readonly type: 'forEach'; readonly maxIterations: number; readonly step: WorkflowGraphStep }
  | { readonly type: 'map'; readonly name: string }
  | { readonly type: 'pivot' };

/** What `recordDefinition` takes. */
export interface WorkflowDefinitionInput {
  readonly name: string;
  /** The hash an execution of this definition carries as `definitionHash`. */
  readonly hash: string;
  readonly revision: string;
  readonly graph: readonly WorkflowGraphNode[];
}

/** One definition a worker announced. Times are the store's clock, epoch ms. */
export interface WorkflowDefinitionRecord extends WorkflowDefinitionInput {
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

/** The largest encoded graph a store accepts. */
export const MAX_DEFINITION_BYTES = 1024 * 1024;

/** How many definitions of one name a store keeps however old they are. */
export const DEFINITIONS_KEPT_PER_NAME = 20;

/** A definition no worker has announced for this long is forgotten (30 days), unless it is among the newest. */
export const DEFINITION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Refuses a definition no store should keep: a malformed field or a graph over `MAX_DEFINITION_BYTES`. */
export function assertDefinition(input: WorkflowDefinitionInput): void {
  for (const field of ['name', 'hash', 'revision'] as const) {
    const value = input[field];
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      (field !== 'revision' && value === '')
    ) {
      throw new TypeError(`Workflow definition ${field} must be a non-empty string without NUL`);
    }
  }
  if (!Array.isArray(input.graph)) {
    throw new TypeError('Workflow definition graph must be an array of nodes');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(input.graph)).byteLength;
  if (bytes > MAX_DEFINITION_BYTES) {
    throw new RangeError(
      `Workflow definition "${input.name}" graph is ${bytes} bytes; the limit is ${MAX_DEFINITION_BYTES}`
    );
  }
}

/** One execution without its blobs: what a list needs, read without decoding any step. */
export interface ExecutionSummary {
  readonly id: string;
  readonly workflowName: string;
  readonly state: ExecutionState;
  readonly definitionHash?: string;
  readonly parentExecutionId?: string;
  readonly currentNodeIndex: number;
  readonly rollbackStatus?: 'completed' | 'not-applicable' | 'stuck';
  readonly failureReason?: string;
  readonly committedAt?: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** While parked at a `waitFor`: the event awaited and the deadline, if there is one. */
  readonly waitEvent?: string;
  readonly waitDeadlineAt?: number;
}

export interface ExecutionSummaryOptions {
  /** Only this run: a primary-key read, for the detail view of one run. */
  readonly id?: string;
  readonly workflowName?: string;
  readonly state?: ExecutionState;
  /** Page size. Default 100, at most 1000. */
  readonly limit?: number;
  readonly offset?: number;
}

/** How many executions a workflow has in one state. */
export interface ExecutionCount {
  readonly workflowName: string;
  readonly state: ExecutionState;
  readonly count: number;
}

/** The order `counts` returns: by workflow, then by state, both by code unit so every store agrees. */
export function compareCounts(a: ExecutionCount, b: ExecutionCount): number {
  return (
    (a.workflowName < b.workflowName ? -1 : a.workflowName > b.workflowName ? 1 : 0) ||
    (a.state < b.state ? -1 : a.state > b.state ? 1 : 0)
  );
}

/**
 * The states in which a run still holds its definition in use: it will run another node, or an
 * operator must decide. `failed` is left out on purpose: its rollback outcome decides, and the
 * engine's own guard (`listActive`) covers that case.
 */
export const LIVE_STATES: readonly ExecutionState[] = [
  'running',
  'waiting',
  'compensating',
  'compensation-stuck',
];

/** How many live runs of a workflow are bound to one definition hash (none for a run saved without one). */
export interface LiveDefinitionCount {
  readonly workflowName: string;
  readonly definitionHash?: string;
  readonly count: number;
}

/** The order `liveDefinitions` returns: by workflow, then hash (runs without one first), by code unit. */
export function compareLive(a: LiveDefinitionCount, b: LiveDefinitionCount): number {
  const left = a.definitionHash ?? '';
  const right = b.definitionHash ?? '';
  return (
    (a.workflowName < b.workflowName ? -1 : a.workflowName > b.workflowName ? 1 : 0) ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
}

export interface DefinitionListOptions {
  readonly name?: string;
}

/**
 * The reads and writes an operator surface needs next to the engine's port: definitions workers
 * announce, and listings that do not decode a run's blobs. A part of `WorkflowStorePort`.
 */
export interface WorkflowInsightPort {
  /**
   * Announces that a worker serves this definition. The first time a hash is seen it is stored; every
   * later call only moves `lastSeenAt` forward. A new hash of a name also forgets that name's
   * definitions last seen over `DEFINITION_RETENTION_MS` ago, except the newest `DEFINITIONS_KEPT_PER_NAME`.
   */
  recordDefinition(input: WorkflowDefinitionInput): Promise<void>;

  /** Every definition announced, by name and then newest announcement first. */
  listDefinitions(options?: DefinitionListOptions): Promise<WorkflowDefinitionRecord[]>;

  /** As `list`, but without the blobs: newest first, in pages. */
  summaries(options?: ExecutionSummaryOptions): Promise<ExecutionSummary[]>;

  /** The number of executions per workflow and state, for the workflows and states that have any. */
  counts(): Promise<ExecutionCount[]>;

  /** The runs in `LIVE_STATES` per workflow and definition hash: what the announced definitions are checked against. */
  liveDefinitions(): Promise<LiveDefinitionCount[]>;
}
