import type {
  Execution,
  ExecutionCount,
  ExecutionState,
  ExecutionSummary,
  LiveDefinitionCount,
  WorkflowDefinitionRecord,
  WorkflowGraphNode,
} from '@qelay-cloud/core';
import type { Wire } from './payload';
import { toWire } from './payload';
import type { CompensationWire } from './workflowCompensation';
import { compensationWire } from './workflowCompensation';
import type { RunFacts } from './workflowRules';
import { allowedActions } from './workflowRules';
import type { WorkflowActionName } from './workflowSchemas';
import type { PayloadBudgets, StepIndex, StepsPage } from './workflowSteps';
import { clipText } from './workflowSteps';

/** What the workflow routes put on the wire, shaped from the store's reads. Pure: no I/O. */

const MAX_REASON_CHARS = 1_000;
const MAX_SIGNALS = 50;
const MAX_CHILDREN = 100;

export interface SummaryWire {
  readonly id: string;
  readonly workflowName: string;
  readonly state: ExecutionState;
  readonly definitionHash: string | null;
  readonly parentExecutionId: string | null;
  readonly currentNodeIndex: number;
  readonly rollbackStatus: string | null;
  readonly failureReason: string | null;
  readonly committedAt: number | null;
  /** The number an action's `expectedVersion` is checked against. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** While parked at a `waitFor`: the event awaited and when it times out (null: never). */
  readonly wait: { readonly event: string; readonly deadlineAt: number | null } | null;
}

export function summaryWire(summary: ExecutionSummary): SummaryWire {
  return {
    id: summary.id,
    workflowName: summary.workflowName,
    state: summary.state,
    definitionHash: summary.definitionHash ?? null,
    parentExecutionId: summary.parentExecutionId ?? null,
    currentNodeIndex: summary.currentNodeIndex,
    rollbackStatus: summary.rollbackStatus ?? null,
    failureReason: clipText(summary.failureReason, MAX_REASON_CHARS),
    committedAt: summary.committedAt ?? null,
    version: summary.version,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    wait:
      summary.waitEvent === undefined
        ? null
        : { event: summary.waitEvent, deadlineAt: summary.waitDeadlineAt ?? null },
  };
}

export interface DefinitionWire {
  readonly hash: string;
  readonly revision: string;
  readonly nodes: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  /** A worker announced it within the served window. */
  readonly served: boolean;
  /** Runs in a live state that are bound to this hash. */
  readonly liveRuns: number;
}

export interface WarningWire {
  readonly code: 'unserved_definition';
  readonly workflow: string;
  readonly hash: string;
  readonly runs: number;
  /** Whether any worker ever announced this hash (it may have aged out of the registry). */
  readonly known: boolean;
  readonly lastSeenAt: number | null;
  readonly message: string;
}

export interface WorkflowOverview {
  readonly name: string;
  readonly total: number;
  readonly counts: Partial<Record<ExecutionState, number>>;
  readonly definitions: DefinitionWire[];
  readonly warnings: WarningWire[];
}

export interface OverviewInput {
  readonly counts: readonly ExecutionCount[];
  readonly definitions: readonly WorkflowDefinitionRecord[];
  readonly live: readonly LiveDefinitionCount[];
  readonly now: number;
  readonly servedMs: number;
  readonly name?: string | undefined;
}

/**
 * Per workflow: its run counts by state, the definitions workers announced, and a warning for every
 * hash that live runs are bound to while no worker serves it. Such a run cannot move (its node would
 * be refused as a different definition), so the warning is what an operator needs to see first.
 */
export function overviews(input: OverviewInput): WorkflowOverview[] {
  const names = new Set<string>();
  for (const { workflowName } of input.counts) names.add(workflowName);
  for (const { name } of input.definitions) names.add(name);
  if (input.name !== undefined) {
    names.clear();
    names.add(input.name);
  }
  return [...names].sort().map((name): WorkflowOverview => {
    const counts: Partial<Record<ExecutionState, number>> = {};
    let total = 0;
    for (const row of input.counts) {
      if (row.workflowName !== name) continue;
      counts[row.state] = row.count;
      total += row.count;
    }
    const live = new Map<string, number>();
    for (const row of input.live) {
      if (row.workflowName === name && row.definitionHash !== undefined) {
        live.set(row.definitionHash, row.count);
      }
    }
    const known = new Map(input.definitions.filter((d) => d.name === name).map((d) => [d.hash, d]));
    const served = (d: WorkflowDefinitionRecord): boolean =>
      d.lastSeenAt >= input.now - input.servedMs;
    const definitions = [...known.values()].map((d): DefinitionWire => ({
      hash: d.hash,
      revision: d.revision,
      nodes: d.graph.length,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
      served: served(d),
      liveRuns: live.get(d.hash) ?? 0,
    }));
    const warnings: WarningWire[] = [];
    for (const [hash, runs] of live) {
      const record = known.get(hash);
      if (record !== undefined && served(record)) continue;
      warnings.push({
        code: 'unserved_definition',
        workflow: name,
        hash,
        runs,
        known: record !== undefined,
        lastSeenAt: record?.lastSeenAt ?? null,
        message: `${runs} live run${runs === 1 ? ' is' : 's are'} bound to a definition of "${name}" that no worker serves: deploy a worker that has it, or cancel the runs`,
      });
    }
    return { name, total, counts, definitions, warnings };
  });
}

export interface DetailInput {
  readonly exec: Execution;
  readonly summary: ExecutionSummary | undefined;
  readonly definition: WorkflowDefinitionRecord | undefined;
  readonly index: StepIndex;
  readonly steps: StepsPage;
  readonly facts: RunFacts;
  readonly now: number;
  readonly servedMs: number;
  readonly budgets: PayloadBudgets;
}

export interface ExecutionDetail {
  readonly execution: SummaryWire & {
    readonly input: Wire;
    readonly inputTruncated?: true;
    readonly signals: {
      readonly total: number;
      readonly items: Array<{ event: string; payload: Wire; truncated?: true }>;
    };
    /** The result of the step that finished last, the closest the engine has to an output. */
    readonly output: {
      readonly step: string;
      readonly result: Wire;
      readonly truncated?: true;
    } | null;
    readonly actions: WorkflowActionName[];
  };
  readonly definition: {
    readonly hash: string;
    readonly revision: string;
    readonly graph: readonly WorkflowGraphNode[];
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
    readonly served: boolean;
  } | null;
  readonly steps: StepsPage;
  readonly children: {
    readonly total: number;
    readonly items: Array<{ step: string; executionId: string }>;
  };
  readonly compensation: CompensationWire;
}

function outputOf(index: StepIndex, maxBytes: number): ExecutionDetail['execution']['output'] {
  let last: (typeof index.top)[number] | undefined;
  for (const entry of index.top) {
    const { status, result, completedAt } = entry[1];
    if (status !== 'completed' || result === undefined) continue;
    if (last === undefined || (completedAt ?? 0) >= (last[1].completedAt ?? 0)) last = entry;
  }
  if (last === undefined) return null;
  const wire = toWire(last[1].result, { maxBytes });
  return {
    step: last[0],
    result: wire.value,
    ...(wire.truncated ? { truncated: true as const } : {}),
  };
}

export function executionDetail(input: DetailInput): ExecutionDetail {
  const { exec, summary, definition, index, budgets } = input;
  const base: ExecutionSummary = {
    id: exec.id,
    workflowName: exec.workflowName,
    state: exec.state,
    ...(exec.definitionHash === undefined ? {} : { definitionHash: exec.definitionHash }),
    ...(exec.parentExecutionId === undefined ? {} : { parentExecutionId: exec.parentExecutionId }),
    currentNodeIndex: exec.currentNodeIndex,
    ...(exec.rollbackStatus === undefined ? {} : { rollbackStatus: exec.rollbackStatus }),
    ...(exec.failureReason === undefined ? {} : { failureReason: exec.failureReason }),
    ...(exec.committedAt === undefined ? {} : { committedAt: exec.committedAt }),
    version: exec.version ?? 0,
    createdAt: exec.createdAt,
    updatedAt: exec.updatedAt,
    ...(summary?.waitEvent === undefined ? {} : { waitEvent: summary.waitEvent }),
    ...(summary?.waitDeadlineAt === undefined ? {} : { waitDeadlineAt: summary.waitDeadlineAt }),
  };
  const inputWire = toWire(exec.input, { maxBytes: budgets.detailBytes });
  const signals = Object.entries(exec.signals ?? {});
  const children = new Map<string, string>();
  for (const [step, record] of index.all) {
    if (record.childExecutionId !== undefined) children.set(record.childExecutionId, step);
  }
  return {
    execution: {
      ...summaryWire(base),
      input: inputWire.value,
      ...(inputWire.truncated ? { inputTruncated: true as const } : {}),
      signals: {
        total: signals.length,
        items: signals.slice(0, MAX_SIGNALS).map(([event, payload]) => {
          const wire = toWire(payload, { maxBytes: budgets.listBytes });
          return {
            event,
            payload: wire.value,
            ...(wire.truncated ? { truncated: true as const } : {}),
          };
        }),
      },
      output: outputOf(index, budgets.detailBytes),
      actions: allowedActions(input.facts),
    },
    definition:
      definition === undefined
        ? null
        : {
            hash: definition.hash,
            revision: definition.revision,
            graph: definition.graph,
            firstSeenAt: definition.firstSeenAt,
            lastSeenAt: definition.lastSeenAt,
            served: definition.lastSeenAt >= input.now - input.servedMs,
          },
    steps: input.steps,
    children: {
      total: children.size,
      items: [...children]
        .slice(0, MAX_CHILDREN)
        .map(([executionId, step]) => ({ step, executionId })),
    },
    compensation: compensationWire(exec, index),
  };
}
