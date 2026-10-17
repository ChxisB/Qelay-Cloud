import type { Lease, Ring } from '@qelay-cloud/core';
import type { SQL } from 'bun';
import { migrate, openDatabase, PostgresStore } from '../../../packages/store-postgres/src/index';
import type { TestSchema } from '../../support/db';
import { createTestSchema, testDatabaseUrl } from '../../support/db';
import { VirtualClock } from '../transport';
import { FlowModel } from './reference';

/** The lease length of the store, and how far `tick` moves the clock: one sweep interval. */
export const LEASE_MS = 30_000;
export const TICK_MS = 10_000;

/** The properties the flow harness checks. A violation names the one that failed. */
export const FLOW_CHECKS = {
  'F1.state':
    'Every job is in the state the model gives it, and the store holds no job the model lacks.',
  'F2.edges': 'The dependency rows are the edges the model holds, each with its policy.',
  'F3.failures': 'The failures a parent can read are the ones the model recorded for it.',
  'F4.parentOrder':
    'A parent is claimed only once released: never while a child it awaits is unfinished.',
  'F5.atMostOnce': 'No job is claimed twice: a parent runs at most once.',
  'F6.noDefects': 'No dangling or orphaned dependency row and no parent stuck waiting.',
  'F7.rings': 'The bells an operation returns are exactly those of the jobs it made claimable.',
  'F8.outcome': 'An operation succeeds exactly when the model says it may.',
  'F9.tick': 'After a tick every claimable job has been rung, and the tick rings nothing else.',
} as const;

export type FlowCheck = keyof typeof FLOW_CHECKS;

export class FlowViolation extends Error {
  constructor(
    readonly check: FlowCheck,
    detail: string
  ) {
    super(`[${check}] ${detail}`);
    this.name = 'FlowViolation';
  }
}

/** A bug planted in what the store returns or holds, to show the harness finds it. */
export interface Planted {
  /** Runs after a flow was added, with the ids of its jobs in pre-order. */
  afterAdd?(world: FlowWorld, ids: readonly string[]): Promise<void>;
  /** Runs after a command that ended jobs (completed, failed or recovered them). */
  afterEnd?(world: FlowWorld): Promise<void>;
  /** Changes the bells an add returned. */
  rings?(rings: readonly Ring[], ids: readonly string[]): readonly Ring[];
}

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

export async function closeFlowTarget(): Promise<void> {
  const open = schema;
  schema = null;
  runs = 0;
  if (open) await (await open).drop();
}

/**
 * What a history acts on: the real store on a clock the harness moves, the model of what it must hold
 * and the leases the model's workers hold. `ringWindowMs: 0` makes a job that is due now ring at once.
 * Every flow job has one attempt, so a failure or an expired lease ends it.
 */
export class FlowWorld {
  readonly model = new FlowModel();
  /** The lease of each active job. */
  readonly leases = new Map<string, Lease>();
  /** Leases whose job has moved on: a worker that comes back with one must be refused. */
  readonly stale: Array<{ readonly id: string; readonly lease: Lease }> = [];

  private constructor(
    readonly store: PostgresStore,
    readonly clock: VirtualClock,
    /** A connection on the same schema, for reading what the store holds. */
    readonly sql: SQL,
    readonly namespace: string,
    readonly planted: Planted | null
  ) {}

  static async open(planted: Planted | null = null): Promise<FlowWorld> {
    const { name, sql } = await sharedSchema();
    runs += 1;
    const clock = new VirtualClock();
    const db = openDatabase({
      url: testDatabaseUrl(),
      schema: name,
      // Four, so two completions can each hold a connection at once.
      poolSize: 4,
      applicationName: 'qcloud:flow-model',
      clock,
    });
    const namespace = `flow-${runs}`;
    const store = new PostgresStore({ db, namespace, ringWindowMs: 0, leaseMs: LEASE_MS });
    return new FlowWorld(store, clock, sql, namespace, planted);
  }

  now(): number {
    return this.clock.now();
  }

  violate(check: FlowCheck, detail: string): never {
    throw new FlowViolation(check, detail);
  }

  /** What the SDK does after an outcome: ring the bells, then tell the store which were rung. */
  async ring(rings: readonly Ring[]): Promise<void> {
    const rung = rings.flatMap((ring) =>
      ring.bell.jobId === undefined
        ? []
        : [{ jobId: ring.bell.jobId, deliverAfterMs: ring.dueInMs }]
    );
    if (rung.length > 0) await this.store.markRung(rung);
  }

  /** The jobs an operation rang, sorted, with repeats kept: a job rung twice shows twice. */
  static rungIds(rings: readonly Ring[]): string[] {
    return rings.map((ring) => ring.bell.jobId ?? '?').sort();
  }

  /** A job leaves the active set: its lease is spent. */
  retire(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    this.stale.push({ id, lease });
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
