import type { JobOptions, StateStore, TickBudget } from '@qelay-cloud/core';
import { testDatabaseUrl } from '../../../test/support/db';
import { Ledger } from '../../../test/support/doorbell/ledger';
import type { Ringer } from '../../../test/support/doorbell/ringing';
import { ringAndMark } from '../../../test/support/doorbell/ringing';
import type { Database } from '../../store-postgres/src/connection/connect';
import { openDatabase } from '../../store-postgres/src/connection/connect';
import { PostgresStore } from '../../store-postgres/src/postgresStore';
import type { TestStore } from '../../store-postgres/test/storeHelpers';
import type { QueueSettings, SqsTransport } from '../src';
import type { Environment } from './support';
import { deadLetterCount, openEnvironment, transportFor, waitFor } from './support';
import type { TestWorker, WorkerOptions } from './testWorker';
import { startWorker } from './testWorker';

/** What the tick does when the test drives it: no grace, so a bell that was never rung is found now. */
const TICK_BUDGET: TickBudget = {
  maxDurationMs: 10_000,
  maxRingsPerQueue: 1_000,
  maxItems: 1_000,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
  ringWindowMs: 0,
};

export interface TickResult {
  readonly recovered: number;
  /** Bells the tick returned and the broker took. */
  readonly rung: number;
}

export interface ScenarioOptions {
  /** Settings of the SQS queues (maxReceiveCount and the like). */
  readonly queue?: QueueSettings;
  /**
   * The delay window of the workers' stores. It must match the store the test built, because a
   * retry or a delayed job is rung at the moment it is written only inside this window.
   */
  readonly ringWindowMs?: number;
}

/**
 * One fault scenario: its own SQS queues (so no bell leaks between tests), the file's store, a shared
 * ledger, and workers that each have their own client, transport and connection pool, as separate
 * processes would. Jobs of different scenarios never meet because each uses its own queue names.
 */
export class Scenario {
  readonly ledger = new Ledger();
  readonly #workers: Array<{ worker: TestWorker; db: Database }> = [];
  readonly #ringWindowMs: number;

  private constructor(
    readonly t: TestStore,
    readonly env: Environment,
    readonly queues: readonly string[],
    /** The producer's transport: enqueue and the tick ring through it. */
    readonly transport: SqsTransport,
    ringWindowMs: number
  ) {
    this.#ringWindowMs = ringWindowMs;
  }

  /** The store's namespace is the transport's: a bell for another environment is rejected. */
  static async open(
    t: TestStore,
    namespace: string,
    queues: readonly string[],
    options: ScenarioOptions = {}
  ): Promise<Scenario> {
    const env = await openEnvironment({ namespace, queues, ...options.queue });
    const transport = transportFor(namespace, {
      onError: (error, source) => console.error(`[producer] ${source}: ${error.message}`),
    });
    return new Scenario(t, env, queues, transport, options.ringWindowMs ?? 0);
  }

  get store(): StateStore {
    return this.t.store;
  }

  get namespace(): string {
    return this.env.namespace;
  }

  worker(options: WorkerOptions): TestWorker {
    // Like a separate process, a worker has its own pool: its claims do not queue behind the test's.
    const db = openDatabase({
      url: testDatabaseUrl(),
      schema: this.t.fresh.name,
      poolSize: 3,
      applicationName: `qcloud:${options.owner}`,
    });
    // A heartbeat extends to the store's lease length, so the store must be built with the worker's.
    const store = new PostgresStore({
      db,
      namespace: this.namespace,
      leaseMs: options.leaseMs,
      ringWindowMs: this.#ringWindowMs,
    });
    const worker = startWorker(store, this.namespace, this.ledger, options);
    this.#workers.push({ worker, db });
    return worker;
  }

  /**
   * Enqueues `count` jobs and rings them through `ringer` (default: the real transport). A job has
   * one attempt unless `options` say otherwise, and a recovered lease spends an attempt.
   */
  async enqueue(
    queue: string,
    count: number,
    ringer: Ringer = this.transport,
    options: JobOptions = {}
  ): Promise<{ ids: string[]; rung: boolean; rings: number }> {
    const jobs = await this.store.enqueue(
      Array.from({ length: count }, (_, n) => ({ queue, data: { n }, options }))
    );
    const rings = jobs.flatMap((job) => (job.ring ? [job.ring] : []));
    const taken = await ringAndMark(this.store, ringer, rings);
    return { ids: jobs.map((job) => job.id), rung: taken === rings.length, rings: rings.length };
  }

  /** One maintenance tick, then ringing what it returned (through `ringer`, by default the transport). */
  async tick(
    budget: Partial<TickBudget> = {},
    ringer: Ringer = this.transport
  ): Promise<TickResult> {
    const report = await this.store.tick({ ...TICK_BUDGET, ...budget });
    return {
      recovered: report.recovered,
      rung: await ringAndMark(this.store, ringer, report.rings),
    };
  }

  /** Bells sitting in the queues' dead-letter queues right now (they are left in place). */
  async deadLettered(): Promise<number> {
    const counts = await Promise.all(this.queues.map((queue) => deadLetterCount(this.env, queue)));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async completed(ids: readonly string[]): Promise<number> {
    const [row] = await this.t.fresh.sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM qcloud_jobs
      WHERE namespace = ${this.namespace}
        AND id = ANY(${this.t.fresh.sql.array([...ids], 'TEXT')}) AND state = 'completed'`;
    return row?.count ?? 0;
  }

  async allCompleted(ids: readonly string[]): Promise<boolean> {
    return (await this.completed(ids)) === ids.length;
  }

  /** The `rung_at` of each job, null where nothing rang it: what the tick keys its re-ring on. */
  async rungAt(ids: readonly string[]): Promise<Array<number | null>> {
    return (await this.times(ids)).map((row) => row.rungAt);
  }

  /** The `run_at` of each job: when a delayed or retried job becomes claimable. */
  async runAt(ids: readonly string[]): Promise<number[]> {
    return (await this.times(ids)).map((row) => row.runAt);
  }

  async states(ids: readonly string[]): Promise<string[]> {
    const rows = await this.t.fresh.sql<Array<{ id: string; state: string }>>`
      SELECT id, state FROM qcloud_jobs
      WHERE namespace = ${this.namespace} AND id = ANY(${this.t.fresh.sql.array([...ids], 'TEXT')})`;
    const byId = new Map(rows.map((row) => [row.id, row.state]));
    return ids.map((id) => byId.get(id) ?? 'missing');
  }

  /** The database clock in milliseconds: delays and leases are measured on it. */
  async databaseNow(): Promise<number> {
    const [row] = await this.t.fresh.sql<Array<{ now: string }>>`
      SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`;
    return Number(row?.now);
  }

  async untilDatabaseTime(at: number): Promise<void> {
    await waitFor(async () => (await this.databaseNow()) >= at, `database time ${at}`, 30_000, 10);
  }

  private async times(
    ids: readonly string[]
  ): Promise<Array<{ runAt: number; rungAt: number | null }>> {
    const rows = await this.t.fresh.sql<
      Array<{ id: string; run_at: string | number; rung_at: string | number | null }>
    >`
      SELECT id, run_at, rung_at FROM qcloud_jobs
      WHERE namespace = ${this.namespace} AND id = ANY(${this.t.fresh.sql.array([...ids], 'TEXT')})`;
    const byId = new Map(
      rows.map((row) => [
        row.id,
        { runAt: Number(row.run_at), rungAt: row.rung_at === null ? null : Number(row.rung_at) },
      ])
    );
    return ids.map((id) => byId.get(id) ?? { runAt: Number.NaN, rungAt: null });
  }

  async close(): Promise<void> {
    for (const { worker, db } of this.#workers) {
      await worker.close();
      await db.close({ timeout: 1_000 }).catch(() => {});
    }
    await this.transport.close();
    await this.env.destroy();
  }
}

/** Polls until every job of `ids` is completed, ticking every `everyMs` when `tick` is given. */
export async function untilCompleted(
  s: Scenario,
  ids: readonly string[],
  timeoutMs: number,
  tick?: { every: number; budget?: Partial<TickBudget> }
): Promise<number> {
  let rung = 0;
  await waitFor(
    async () => {
      if (tick) rung += (await s.tick(tick.budget)).rung;
      return await s.allCompleted(ids);
    },
    `${ids.length} job(s) to complete`,
    timeoutMs,
    tick?.every
  );
  return rung;
}
