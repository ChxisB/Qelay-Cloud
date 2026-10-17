import type { RingItem, RingResult } from '@qelay-cloud/core';
import { migrate, PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { testDatabaseUrl } from '../../../test/support/db';
import type { FreshSchema } from '../../store-postgres/test/helpers';
import { freshSchema } from '../../store-postgres/test/helpers';
import type { FlowProducerOptions, Logger, Metrics, QueueOptions } from '../src';
import { FlowProducer, Queue } from '../src';

export const NAMESPACE = 'test';

/**
 * A `MemoryTransport` whose next `ring` calls can throw as a whole, as an unreachable broker does,
 * or refuse every item, and which records the size of each call.
 */
export class FlakyTransport extends MemoryTransport {
  readonly batches: number[] = [];
  #throws = 0;
  #refusals: Array<Extract<RingResult, { ok: false }>['reason']> = [];

  throwNext(n = 1): void {
    this.#throws += n;
  }

  /** The next `ring` call refuses every item with `reason`. */
  refuseNext(reason: Extract<RingResult, { ok: false }>['reason']): void {
    this.#refusals.push(reason);
  }

  override async ring(items: readonly RingItem[]): Promise<RingResult[]> {
    this.batches.push(items.length);
    if (this.#throws > 0) {
      this.#throws -= 1;
      throw new Error('broker unreachable');
    }
    const reason = this.#refusals.shift();
    if (reason !== undefined) return items.map(() => ({ ok: false, reason }));
    return super.ring(items);
  }
}

export interface Recorded {
  readonly warnings: string[];
  readonly counts: Map<string, number>;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export function recorded(): Recorded {
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  return {
    warnings,
    counts,
    logger: { warn: (message) => void warnings.push(message) },
    metrics: {
      increment: (name, value = 1) => void counts.set(name, (counts.get(name) ?? 0) + value),
    },
  };
}

export interface SdkFixture {
  readonly fresh: FreshSchema;
  /** Replaced by `resetFixture`, so the bells of one test never reach the next. */
  readonly transport: FlakyTransport;
  /** A store on the same schema and namespace as the queues, to claim and inspect jobs behind them. */
  readonly store: PostgresStore;
  /** Each queue has its own pool, as two processes would. Closed by `drop`. */
  queue<T = unknown>(name?: string, extra?: Partial<QueueOptions>): Queue<T>;
  /** A `FlowProducer` on the same schema and namespace, with a pool of its own. Closed by `drop`. */
  producer(extra?: Partial<FlowProducerOptions>): FlowProducer;
  renewTransport(): void;
  drop(): Promise<void>;
}

/** A migrated schema, a transport, and a way to open `Queue`s on them. */
export async function openFixture(): Promise<SdkFixture> {
  const fresh = await freshSchema();
  await migrate(fresh.db);
  let transport = new FlakyTransport();
  const queues: Array<{ close(options?: { timeout?: number }): Promise<void> }> = [];
  return {
    fresh,
    get transport() {
      return transport;
    },
    renewTransport() {
      transport = new FlakyTransport();
    },
    store: new PostgresStore({ db: fresh.db, namespace: NAMESPACE }),
    queue<T>(name = 'q', extra: Partial<QueueOptions> = {}) {
      const own: Partial<QueueOptions> =
        extra.store === undefined
          ? {
              databaseUrl: testDatabaseUrl(),
              database: { schema: fresh.name, poolSize: 2 },
              namespace: NAMESPACE,
            }
          : {};
      const queue = new Queue<T>(name, { transport, ...own, ...extra } as QueueOptions);
      queues.push(queue as Queue);
      return queue;
    },
    producer(extra: Partial<FlowProducerOptions> = {}) {
      const own: Partial<FlowProducerOptions> =
        extra.store === undefined
          ? {
              databaseUrl: testDatabaseUrl(),
              database: { schema: fresh.name, poolSize: 2 },
              namespace: NAMESPACE,
            }
          : {};
      const producer = new FlowProducer({ transport, ...own, ...extra } as FlowProducerOptions);
      queues.push(producer);
      return producer;
    },
    async drop() {
      await Promise.all(queues.map((queue) => queue.close({ timeout: 1000 }).catch(() => {})));
      await fresh.drop();
    },
  };
}

export async function resetFixture(f: SdkFixture): Promise<void> {
  f.renewTransport();
  await f.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_completions,
    qcloud_job_logs, qcloud_dependencies, qcloud_flow_failures, qcloud_events,
    qcloud_group_state, qcloud_workers`;
}

/** `rung_at IS NOT NULL` for each job id given. */
export async function rungOf(
  f: SdkFixture,
  ids: readonly string[]
): Promise<Record<string, boolean>> {
  const rows = await f.fresh.sql<Array<{ id: string; rung: boolean }>>`
    SELECT id, rung_at IS NOT NULL AS rung FROM qcloud_jobs WHERE id IN ${f.fresh.sql([...ids])}`;
  return Object.fromEntries(rows.map((row) => [row.id, row.rung]));
}
