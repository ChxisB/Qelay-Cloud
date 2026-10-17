import type { Clock } from './clock';
import type {
  DefinitionListOptions,
  ExecutionCount,
  ExecutionSummary,
  ExecutionSummaryOptions,
  LiveDefinitionCount,
  WorkflowDefinitionInput,
  WorkflowDefinitionRecord,
  WorkflowInsightPort,
} from './workflowGraph';
import {
  assertDefinition,
  compareCounts,
  compareLive,
  DEFINITION_RETENTION_MS,
  DEFINITIONS_KEPT_PER_NAME,
  LIVE_STATES,
} from './workflowGraph';
import type { Row } from './workflowMemoryRows';
import { byCreated } from './workflowMemoryRows';
import { pageBounds } from './workflowRules';

/** The definitions registry and the blob-free reads of `MemoryWorkflowStore`, which extends it to share its rows. */
export class MemoryWorkflowInsight implements WorkflowInsightPort {
  protected readonly rows = new Map<string, Row>();
  private readonly definitions = new Map<string, WorkflowDefinitionRecord>();

  constructor(protected readonly clock: Clock) {}

  async recordDefinition(input: WorkflowDefinitionInput): Promise<void> {
    assertDefinition(input);
    const now = this.clock.now();
    const key = `${input.name}\0${input.hash}`;
    const known = this.definitions.get(key);
    if (known) {
      this.definitions.set(key, { ...known, lastSeenAt: Math.max(known.lastSeenAt, now) });
      return;
    }
    this.definitions.set(key, {
      name: input.name,
      hash: input.hash,
      revision: input.revision,
      graph: structuredClone(input.graph),
      firstSeenAt: now,
      lastSeenAt: now,
    });
    this.forget(input.name, now - DEFINITION_RETENTION_MS);
  }

  async listDefinitions(options: DefinitionListOptions = {}): Promise<WorkflowDefinitionRecord[]> {
    return [...this.definitions.values()]
      .filter((d) => options.name === undefined || d.name === options.name)
      .sort(
        (a, b) =>
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
          b.lastSeenAt - a.lastSeenAt ||
          (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
      )
      .map((d) => structuredClone(d));
  }

  async summaries(options: ExecutionSummaryOptions = {}): Promise<ExecutionSummary[]> {
    const { limit, offset } = pageBounds(options);
    return [...this.rows.values()]
      .filter(
        ({ exec }) =>
          (options.id === undefined || exec.id === options.id) &&
          (options.workflowName === undefined || exec.workflowName === options.workflowName) &&
          (options.state === undefined || exec.state === options.state)
      )
      .sort((a, b) => byCreated(a.exec, b.exec))
      .slice(offset, offset + limit)
      .map(({ exec, wait }) => ({
        id: exec.id,
        workflowName: exec.workflowName,
        state: exec.state,
        ...(exec.definitionHash === undefined ? {} : { definitionHash: exec.definitionHash }),
        ...(exec.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: exec.parentExecutionId }),
        currentNodeIndex: exec.currentNodeIndex,
        ...(exec.rollbackStatus === undefined ? {} : { rollbackStatus: exec.rollbackStatus }),
        ...(exec.failureReason === undefined ? {} : { failureReason: exec.failureReason }),
        ...(exec.committedAt === undefined ? {} : { committedAt: exec.committedAt }),
        version: exec.version ?? 0,
        createdAt: exec.createdAt,
        updatedAt: exec.updatedAt,
        ...(wait === null ? {} : { waitEvent: wait.event }),
        ...(wait?.deadlineAt == null ? {} : { waitDeadlineAt: wait.deadlineAt }),
      }));
  }

  async counts(): Promise<ExecutionCount[]> {
    const tally = new Map<string, number>();
    for (const { exec } of this.rows.values()) {
      const key = `${exec.workflowName}\0${exec.state}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([key, count]) => {
        const [workflowName, state] = key.split('\0') as [string, ExecutionCount['state']];
        return { workflowName, state, count };
      })
      .sort(compareCounts);
  }

  async liveDefinitions(): Promise<LiveDefinitionCount[]> {
    const tally = new Map<string, LiveDefinitionCount>();
    for (const { exec } of this.rows.values()) {
      if (!LIVE_STATES.includes(exec.state)) continue;
      const key = `${exec.workflowName}\0${exec.definitionHash ?? ''}`;
      const known = tally.get(key);
      tally.set(key, {
        workflowName: exec.workflowName,
        ...(exec.definitionHash === undefined ? {} : { definitionHash: exec.definitionHash }),
        count: (known?.count ?? 0) + 1,
      });
    }
    return [...tally.values()].sort(compareLive);
  }

  private forget(name: string, cutoff: number): void {
    const mine = [...this.definitions.values()]
      .filter((d) => d.name === name)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt || (a.hash < b.hash ? -1 : 1));
    for (const old of mine.slice(DEFINITIONS_KEPT_PER_NAME)) {
      if (old.lastSeenAt < cutoff) this.definitions.delete(`${old.name}\0${old.hash}`);
    }
  }
}
