import type { DeliveryTransport, JobOptions } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { ConnectionOptions, PostgresStore, ShardMap } from '@qelay-cloud/store-postgres';

/** Receives what the SDK swallows on purpose, such as a ring that failed after the job was admitted. */
export interface Logger {
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
}

/** A counter sink. Names are listed in `docs/compat.md`; every one starts with `qcloud.`. */
export interface Metrics {
  increment(name: string, value?: number, tags?: Readonly<Record<string, string>>): void;
  /** A measurement, such as a duration in ms (`qcloud.worker.claim_ms`). A sink that has no use for them leaves this out. */
  observe?(name: string, value: number, tags?: Readonly<Record<string, string>>): void;
}

/** What a span says about itself. `jobId` is absent where the job does not exist yet (the add). */
export interface TraceSpan {
  /** `add` or `process`. */
  readonly operation: 'add' | 'process';
  readonly queue: string;
  readonly jobId?: string;
  readonly jobName?: string;
  /** Tries made before this one (process only). */
  readonly attempt?: number;
  /** Jobs added by this call (add only). */
  readonly count?: number;
}

/** What the code inside a span can tell it. */
export interface TraceHandle {
  event(name: string): void;
  fail(error: unknown): void;
}

/**
 * Opt-in tracing, off unless passed. `produce` runs `work` in a span and hands it the `traceparent`
 * to store with the jobs; `consume` runs `work` in a span that continues the stored one (or starts
 * a new trace for a job added without one). Both must call `work` once and return what it returns.
 * `@qelay-cloud/telemetry` has an OpenTelemetry implementation.
 */
export interface Tracing {
  produce<T>(span: TraceSpan, work: (traceparent: string | undefined) => Promise<T>): Promise<T>;
  consume<T>(
    span: TraceSpan,
    traceparent: string | undefined,
    work: (handle: TraceHandle) => Promise<T>
  ): Promise<T>;
}

/**
 * What a `Queue` is built from. Qelay's `host`, `port`, `embedded`, `connection`, `dataPath`,
 * `autoBatch` and `prefixKey` are refused (see `rejectLegacyOptions`).
 */
export interface QueueOptions {
  /** `postgres://user:password@host:port/database`. Give this or `database`, or `shards` or a `store`. */
  readonly databaseUrl?: string;
  /** Discrete connection options: pooler mode, `listenUrl`, `socketPath`, timeouts, TLS. */
  readonly database?: ConnectionOptions;
  /** The doorbell. The caller owns it: `queue.close()` does not close it. */
  readonly transport: DeliveryTransport;
  /**
   * In place of `databaseUrl` and `database`: the database that holds `namespace` is looked up here,
   * and a namespace the map does not list is refused. Every producer, worker and listener of a
   * namespace must be given the same map.
   */
  readonly shards?: ShardMap;
  /** The tenant of every row. Queues and workers that share a namespace see each other's jobs. Default `default`. */
  readonly namespace?: string;
  /** Merged under the options of every `add`. */
  readonly defaultJobOptions?: JobOptions;
  /**
   * Off by default. When on, `add` calls made while another add is being stored share one
   * transaction (up to `maxJobs`, default 100), which cuts commits per job for a producer that adds
   * concurrently. A caller that awaits each add one at a time is unchanged. See `AddBatcher`.
   */
  readonly groupCommit?: boolean | { readonly maxJobs?: number };
  /**
   * Off by default (0). A positive number of ms: `add` rings a queue at most once per window while
   * the queue has a claimable job rung inside it; the other new jobs get no bell and are found by the
   * worker's next claim or the tick's re-ring. It saves a publish and a write per job under a
   * standing backlog. Turn it on only when every consumer is this package's worker: one from before
   * `claim again after a full claim` claims once per bell and would wait for the re-ring.
   */
  readonly ringCoverMs?: number;
  /** An open store to use instead of opening one. The caller owns it: `queue.close()` leaves it open. */
  readonly store?: PostgresStore;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  /** Off by default. A `Queue` stores the trace context with each job it adds; a `Worker` continues it. */
  readonly tracing?: Tracing;
}

export const DEFAULT_NAMESPACE = 'default';

/** Delays above this are never rung from `add`, whatever the transport says (job delay is capped at 365 days). */
export const MAX_RING_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const LEGACY: Readonly<Record<string, string>> = {
  host: 'there is no Qelay server to connect to: pass databaseUrl or database',
  port: 'there is no Qelay server to connect to: pass databaseUrl or database',
  connection: 'there is no Qelay server to connect to: pass databaseUrl or database',
  embedded: 'there is no embedded mode: pass databaseUrl or database',
  dataPath: 'there is no embedded mode: pass databaseUrl or database',
  autoBatch: 'adds are not batched across calls: use addBulk, or the groupCommit option',
  prefixKey: 'queues are separated by namespace: pass namespace',
};

/** Qelay's connection options throw here instead of being ignored. The guide is `docs/compat.md`. */
export function rejectLegacyOptions(options: object): void {
  for (const key of Object.keys(options)) {
    const advice = LEGACY[key];
    if (advice !== undefined) {
      throw new UnsupportedOptionError(
        key,
        `is a Qelay option and is not supported: ${advice} (docs/compat.md)`
      );
    }
  }
}

/** How far ahead the transport can hold a bell, as a finite number the store accepts. */
export function ringWindowMs(transport: DeliveryTransport): number {
  const max = transport.capabilities.maxDeliverDelayMs;
  return Number.isFinite(max) ? Math.max(0, max) : MAX_RING_WINDOW_MS;
}

export function checkQueueName(name: unknown): string {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) {
    throw new UnsupportedOptionError('name', 'must be a non-empty string without NUL');
  }
  return name;
}
