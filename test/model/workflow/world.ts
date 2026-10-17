import type { Execution, WorkflowStorePort } from '@qelay-cloud/core';
import type { SQL } from 'bun';
import { MemoryWorkflowStore } from '../../../packages/core/src';
import {
  createMsgpackCodec,
  migrate,
  openDatabase,
  PostgresStore,
} from '../../../packages/store-postgres/src/index';
import type { TestSchema } from '../../support/db';
import { createTestSchema, testDatabaseUrl } from '../../support/db';
import { VirtualClock } from '../transport';

/** The properties the workflow harness checks. A violation names the one that failed. */
export const WORKFLOW_CHECKS = {
  'WF1.state':
    'The store holds the executions the reference holds, field by field, in the same order.',
  'WF2.outcome':
    'Every operation returns, or fails with, what the reference returns or fails with.',
  'WF3.signals': 'A signal that was delivered is never lost or changed while its run exists.',
  'WF4.version': 'The version of a run never goes down while the run exists.',
  'WF5.archive': 'The archive only grows: a run that was archived is never taken out of it.',
} as const;

export type WorkflowCheck = keyof typeof WORKFLOW_CHECKS;

export class WorkflowViolation extends Error {
  constructor(
    readonly check: WorkflowCheck,
    detail: string
  ) {
    super(`[${check}] ${detail}`);
    this.name = 'WorkflowViolation';
  }
}

/** A bug planted in the data the store holds, to show the harness finds it. */
export interface Planted {
  /** Runs after each command, with the command's name (`advance`, `signal`, ...), before the checks. */
  after?(world: WorkflowWorld, command: string): Promise<void>;
}

/** How often each rule of the stores was reached, so a run too short to reach one can be told. */
export const COVERAGE = new Map<string, number>();

/** One migrated schema for every run of the process, and a namespace of its own in it for each run. */
let schema: Promise<TestSchema> | null = null;
let runs = 0;

function sharedSchema(): Promise<TestSchema> {
  schema ??= (async () => {
    const created = await createTestSchema();
    const setup = openDatabase({ url: testDatabaseUrl(), schema: created.name, poolSize: 1 });
    try {
      await migrate(setup);
    } finally {
      await setup.close({ timeout: 1000 });
    }
    return created;
  })();
  return schema;
}

export async function closeWorkflowTarget(): Promise<void> {
  const open = schema;
  schema = null;
  runs = 0;
  if (open) await (await open).drop();
}

/** What was last seen of a run, so a later look can tell that something was lost. */
export interface Seen {
  readonly version: number;
  readonly signals: Record<string, unknown>;
}

/**
 * What a history acts on: the Postgres store and the in-memory reference, both on the one clock the
 * harness moves. Each command does the same thing to both and compares what comes back.
 */
export class WorkflowWorld {
  /** The last look at each run that still exists. */
  readonly seen = new Map<string, Seen>();
  /** The most runs the archive has held. */
  archived = 0;
  readonly emptySignals = createMsgpackCodec().encode({});

  private constructor(
    readonly real: WorkflowStorePort,
    readonly reference: MemoryWorkflowStore,
    readonly store: PostgresStore,
    readonly clock: VirtualClock,
    /** A connection on the same schema, for reading what the store holds. */
    readonly sql: SQL,
    readonly namespace: string,
    readonly planted: Planted | null
  ) {}

  static async open(planted: Planted | null = null): Promise<WorkflowWorld> {
    const { name, sql } = await sharedSchema();
    runs += 1;
    const clock = new VirtualClock();
    const db = openDatabase({
      url: testDatabaseUrl(),
      schema: name,
      poolSize: 2,
      applicationName: 'qcloud:workflow-model',
      clock,
    });
    const namespace = `wf-${runs}`;
    const store = new PostgresStore({ db, namespace });
    return new WorkflowWorld(
      store.workflows,
      new MemoryWorkflowStore(clock),
      store,
      clock,
      sql,
      namespace,
      planted
    );
  }

  now(): number {
    return this.clock.now();
  }

  violate(check: WorkflowCheck, detail: string): never {
    throw new WorkflowViolation(check, detail);
  }

  hit(rule: string | undefined): void {
    if (rule) COVERAGE.set(rule, (COVERAGE.get(rule) ?? 0) + 1);
  }

  /** The same new run, once for each store: each one stamps its own copy. */
  fresh(id: string, overrides: Partial<Execution> = {}): Execution {
    const now = this.now();
    return {
      id,
      workflowName: 'order',
      state: 'running',
      input: { n: 1 },
      steps: {},
      currentNodeIndex: 0,
      signals: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
