/**
 * Tells the store which definitions this engine serves, now and every `everyMs` after, so that an
 * operator surface can draw a run's graph and see whether any worker still serves the definition a
 * live run is bound to. A failure to announce is reported and otherwise ignored: the engine runs the
 * same without it, and the next refresh tries again.
 */

import type { WorkflowDefinitionInput, WorkflowStorePort } from '@qelay-cloud/core';
import { describeWorkflow } from './definitionRecord';
import type { Workflow } from './workflow';

export const DEFAULT_ANNOUNCE_MS = 30_000;

export class DefinitionAnnouncer {
  private readonly definitions: WorkflowDefinitionInput[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly port: Pick<WorkflowStorePort, 'recordDefinition'>,
    private readonly everyMs: number,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Announces `workflow` at once and keeps announcing it. Never throws. */
  async add(workflow: Workflow): Promise<void> {
    if (this.closed || this.everyMs <= 0) return;
    const definition = describeWorkflow(workflow);
    this.definitions.push(definition);
    this.timer ??= this.start();
    await this.record(definition);
  }

  /** Stops the refresh and waits for an announcement in flight. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  private start(): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      for (const definition of this.definitions) void this.record(definition);
    }, this.everyMs);
    timer.unref();
    return timer;
  }

  private record(definition: WorkflowDefinitionInput): Promise<void> {
    const run = this.port.recordDefinition(definition).catch((error: unknown) => {
      this.onError(error);
    });
    this.pending = this.pending.then(() => run);
    return run;
  }
}
