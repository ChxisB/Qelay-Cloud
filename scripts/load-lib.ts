/** Helpers of `scripts/load-check.ts`: a timed store, the worker fleet, the reconciliation and the plan printer. */
import type { SQL } from 'bun';
import type { DeliveryTransport } from '../packages/core/src';
import { Queue, Worker } from '../packages/sdk/src';
import { migrate } from '../packages/store-postgres/src';
import type { Database } from '../packages/store-postgres/src';
import { PostgresStore } from '../packages/store-postgres/src';
import type { FreshSchema } from '../packages/store-postgres/test/helpers';
import { freshSchema } from '../packages/store-postgres/test/helpers';
import { MemoryTransport } from '../packages/transport-local/src';

export const NAMESPACE = 'ns';
export const QUEUES = ['q', 'r', 's', 't', 'u'];
export const PAYLOAD = { data: 'x'.repeat(100) };

/** A migrated schema of its own, whose connections the activity sampler can tell from other tests'. */
export async function schema(): Promise<FreshSchema> {
  const fresh = await freshSchema({ poolSize: 8, applicationName: 'qcloud:load' });
  await migrate(fresh.db);
  return fresh;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function summary(values: readonly number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
  return `n=${sorted.length} mean ${mean.toFixed(2)} p50 ${percentile(sorted, 0.5).toFixed(2)} p99 ${percentile(sorted, 0.99).toFixed(2)} max ${(sorted.at(-1) ?? 0).toFixed(2)} ms`;
}

/** A store that times every claim, the call a worker makes on each bell. */
export class TimedStore extends PostgresStore {
  readonly claimMs: number[] = [];
  readonly claimSizes: number[] = [];
  override async claim(...args: Parameters<PostgresStore['claim']>) {
    const started = performance.now();
    const claimed = await super.claim(...args);
    this.claimMs.push(performance.now() - started);
    this.claimSizes.push(claimed.length);
    return claimed;
  }
}

/** Counts the bells it is asked to ring, then rings them on the wrapped transport. */
export class CountingRing implements DeliveryTransport {
  items = 0;
  readonly capabilities: DeliveryTransport['capabilities'];
  constructor(readonly inner: DeliveryTransport) {
    this.capabilities = inner.capabilities;
  }
  ring: DeliveryTransport['ring'] = (items) => {
    this.items += items.length;
    return this.inner.ring(items);
  };
  subscribe: DeliveryTransport['subscribe'] = (q, h, o) => this.inner.subscribe(q, h, o);
  stats: DeliveryTransport['stats'] = (q) => this.inner.stats(q);
  close = (): Promise<void> => this.inner.close();
}

export interface Fleet {
  readonly stores: TimedStore[];
  /** Processor starts per job id: more than one for any id is a double run. */
  readonly runs: Map<string, number>;
  stop(): Promise<void>;
}

/**
 * `workers` in-process `Worker`s over `queues`, round-robin, each with a pool of its own as a process
 * would have. The processor is a no-op that records its job. Honest limit: they share one event loop and
 * one CPU, so the numbers are a floor for a fleet of separate processes, not a ceiling.
 */
export function startFleet(opts: {
  db: (n: number) => Database;
  transport: DeliveryTransport;
  queues: readonly string[];
  workers: number;
  concurrency: number;
}): Fleet {
  if (opts.workers < opts.queues.length) {
    throw new Error(
      `${opts.workers} workers cannot serve ${opts.queues.length} queues: a queue would never drain`
    );
  }
  const runs = new Map<string, number>();
  const stores: TimedStore[] = [];
  const workers: Worker[] = [];
  for (let n = 0; n < opts.workers; n += 1) {
    const store = new TimedStore({ db: opts.db(n), namespace: NAMESPACE });
    stores.push(store);
    workers.push(
      new Worker(
        opts.queues[n % opts.queues.length]!,
        (job) => void runs.set(job.id, (runs.get(job.id) ?? 0) + 1),
        {
          store,
          transport: opts.transport,
          concurrency: opts.concurrency,
          heartbeatInterval: 0,
        }
      )
    );
  }
  return {
    stores,
    runs,
    async stop() {
      await Promise.all(workers.map((w) => w.close({ graceMs: 0, timeout: 2_000 })));
    },
  };
}

export async function admit(
  queues: readonly Queue[],
  total: number,
  producers = 4,
  bulk = 100
): Promise<number> {
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: producers }, async (_, p) => {
      for (;;) {
        const from = next;
        if (from >= total) return;
        next += bulk;
        const size = Math.min(bulk, total - from);
        await queues[(p + from / bulk) % queues.length]!.addBulk(
          Array.from({ length: size }, () => ({ name: 'noop', data: PAYLOAD }))
        );
      }
    })
  );
  return performance.now() - started;
}

export const counts = async (sql: SQL): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await sql<Array<{ state: string; n: string }>>`
        SELECT state, count(*) AS n FROM qcloud_jobs WHERE namespace = ${NAMESPACE} GROUP BY state`
    ).map((r) => [r.state, Number(r.n)])
  );

/** The reconciliation: the rows are exactly the jobs added, all completed, and no job ran twice. */
export async function reconcile(sql: SQL, runs: Map<string, number>, expected: number) {
  const states = await counts(sql);
  const doubled = [...runs.values()].filter((n) => n > 1).length;
  const [distinct] = await sql<Array<{ n: string }>>`
    SELECT count(DISTINCT id) AS n FROM qcloud_jobs WHERE namespace = ${NAMESPACE}`;
  const ok =
    states.completed === expected &&
    Object.keys(states).length === 1 &&
    Number(distinct!.n) === expected &&
    runs.size === expected &&
    doubled === 0;
  return { ok, states, ranOnce: runs.size - doubled, doubled, rows: Number(distinct!.n) };
}

export { MemoryTransport, Queue };
