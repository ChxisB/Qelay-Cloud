import { DEFAULT_WORKFLOW_QUEUE } from '@qelay-cloud/core';
import {
  DEFAULT_PAGE_SIZE,
  MAX_EVENT_PAGE,
  MAX_PAGE_OFFSET,
  MAX_PAGE_SIZE,
  MAX_THROUGHPUT_MINUTES,
} from '@qelay-cloud/store-postgres';
import { ControlApiConfigError } from '../config';

/**
 * What bounds a response and a request of the jobs and queues routes. Every list is paged and every
 * payload has a byte budget, so no answer grows with the size of a table or of a job.
 */
export interface JobsOptions {
  /**
   * JSON bytes one payload (`data`, `returnvalue`) may take in a list. A larger one is replaced by a
   * `truncated` marker (see `payload.ts`). Default 1,024.
   */
  readonly listPayloadBytes?: number;
  /** The same budget in a job's own response. Default 262,144. */
  readonly detailPayloadBytes?: number;
  /** Largest page of a list, at most the store's 1,000. Default 500. */
  readonly maxPageSize?: number;
  /** Page size when `limit` is absent. Default 50. */
  readonly defaultPageSize?: number;
  /**
   * How long this instance keeps the answer of `/dashboard`, `/queues/summary` and `/stats`, in ms.
   * 0 turns the cache off. A request with `x-qelay-cache: bypass` skips it. Default 2,000.
   */
  readonly summaryCacheMs?: number;
  /** Most jobs in one bulk add. Default 10,000, the panel's own limit. */
  readonly maxBulkJobs?: number;
  /** Largest body of a bulk add, in bytes. Default 64 MiB, the panel's own limit. */
  readonly bulkBodyBytes?: number;
  /** Largest `offset` of a job list; past it the caller uses `cursor`. Default the store's 100,000. */
  readonly maxOffset?: number;
  /**
   * How long one drain, clean or obliterate keeps deleting batches before it answers `done: false`
   * and leaves the rest to another call, in ms. Default 20,000, at most 120,000.
   */
  readonly actionBudgetMs?: number;
  /** What bounds `GET /events`, the live event stream. See `EventStreamOptions`. */
  readonly events?: EventStreamOptions;
  /**
   * Longest range of `GET /metrics/queues/:queue`, in minutes. The store keeps 14 days of minute
   * buckets, so more than 20,160 only adds empty minutes. Default 1,440 (one day).
   */
  readonly maxMetricsMinutes?: number;
  /**
   * The engine queue the workflow actions publish to. It must be the engine's `queueName`, which is
   * also what the tick's `QCLOUD_WORKFLOW_QUEUE` names. Default `__wf:steps`.
   */
  readonly workflowQueue?: string;
  /**
   * How long a run may show no progress before `recover` takes it, in ms: the tick's
   * `QCLOUD_WORKFLOW_IDLE_MS`, so an operator never takes a run the engine is still writing. Default 300,000.
   */
  readonly workflowIdleMs?: number;
  /**
   * A workflow definition counts as served while a worker announced it this recently, in ms. Workers
   * announce every 30 s by default, so the default of 120,000 allows several missed beats.
   */
  readonly workflowServedMs?: number;
}

/**
 * The bounds of one event stream. A stream polls the store's event journal, so each open stream is
 * a read every `pollMs`; the caps keep that read load, and the sockets, in a number an operator chose.
 */
export interface EventStreamOptions {
  /** How often an idle stream looks for new events, in ms. Default 1,000, at most 60,000 and not past `heartbeatMs`. */
  readonly pollMs?: number;
  /** A comment line this often keeps proxies and the panel's 45 s idle deadline quiet. Default 15,000. */
  readonly heartbeatMs?: number;
  /** A stream ends after this long so clients reconnect (and re-authenticate). Default 600,000. */
  readonly maxLifetimeMs?: number;
  /** Streams one principal may hold open (429 past it). Default 10. */
  readonly maxPerPrincipal?: number;
  /** Streams one instance may hold open (503 past it). Default 200. */
  readonly maxStreams?: number;
  /** Bytes a client may leave unread before the stream waits for it. Default 262,144. */
  readonly bufferBytes?: number;
  /** A client that reads nothing for this long, with events waiting, is disconnected. Default 30,000. */
  readonly slowClientMs?: number;
  /** Events one journal read takes, at most 5,000. Default 500. */
  readonly pageSize?: number;
}

export interface EventStreamConfig {
  readonly pollMs: number;
  readonly heartbeatMs: number;
  readonly maxLifetimeMs: number;
  readonly maxPerPrincipal: number;
  readonly maxStreams: number;
  readonly bufferBytes: number;
  readonly slowClientMs: number;
  readonly pageSize: number;
}

export interface JobsConfig {
  readonly listPayloadBytes: number;
  readonly detailPayloadBytes: number;
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  readonly summaryCacheMs: number;
  readonly maxBulkJobs: number;
  readonly bulkBodyBytes: number;
  readonly maxOffset: number;
  readonly actionBudgetMs: number;
  readonly events: EventStreamConfig;
  readonly maxMetricsMinutes: number;
  readonly workflowQueue: string;
  readonly workflowIdleMs: number;
  readonly workflowServedMs: number;
}

export const DEFAULT_LIST_PAYLOAD_BYTES = 1_024;
export const DEFAULT_DETAIL_PAYLOAD_BYTES = 256 * 1_024;
export const DEFAULT_MAX_PAGE_SIZE = 500;
export const DEFAULT_SUMMARY_CACHE_MS = 2_000;
export const DEFAULT_MAX_BULK_JOBS = 10_000;
export const DEFAULT_BULK_BODY_BYTES = 64 * 1_024 * 1_024;
export const DEFAULT_ACTION_BUDGET_MS = 20_000;
export const DEFAULT_WORKFLOW_IDLE_MS = 300_000;
export const DEFAULT_WORKFLOW_SERVED_MS = 120_000;
/** Queues past this offset are not walked: the dashboard's queue list reads a page per 1,000 before it. */
export const MAX_QUEUE_OFFSET = 10_000;

function bounded(name: string, value: number | undefined, fallback: number, max: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > max) {
    throw new ControlApiConfigError(`${name} must be an integer from 1 to ${max}`);
  }
  return chosen;
}

function resolveEvents(options: EventStreamOptions = {}): EventStreamConfig {
  const pollMs = bounded('jobs.events.pollMs', options.pollMs, 1_000, 60_000);
  const heartbeatMs = bounded('jobs.events.heartbeatMs', options.heartbeatMs, 15_000, 60_000);
  if (pollMs > heartbeatMs) {
    throw new ControlApiConfigError('jobs.events.pollMs must not be more than heartbeatMs');
  }
  return {
    pollMs,
    heartbeatMs,
    maxLifetimeMs: bounded('jobs.events.maxLifetimeMs', options.maxLifetimeMs, 600_000, 86_400_000),
    maxPerPrincipal: bounded('jobs.events.maxPerPrincipal', options.maxPerPrincipal, 10, 1_000),
    maxStreams: bounded('jobs.events.maxStreams', options.maxStreams, 200, 100_000),
    bufferBytes: bounded('jobs.events.bufferBytes', options.bufferBytes, 262_144, 16_777_216),
    slowClientMs: bounded('jobs.events.slowClientMs', options.slowClientMs, 30_000, 600_000),
    pageSize: bounded('jobs.events.pageSize', options.pageSize, 500, MAX_EVENT_PAGE),
  };
}

function workflowQueue(name: string | undefined): string {
  const chosen = name ?? DEFAULT_WORKFLOW_QUEUE;
  if (chosen === '' || chosen.includes('\0')) {
    throw new ControlApiConfigError('jobs.workflowQueue must be a non-empty string without NUL');
  }
  return chosen;
}

/** Validates the options and fills the defaults. */
export function resolveJobsConfig(options: JobsOptions = {}): JobsConfig {
  const maxPageSize = bounded(
    'jobs.maxPageSize',
    options.maxPageSize,
    DEFAULT_MAX_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const defaultPageSize = bounded(
    'jobs.defaultPageSize',
    options.defaultPageSize,
    Math.min(DEFAULT_PAGE_SIZE, maxPageSize),
    maxPageSize
  );
  const cache = options.summaryCacheMs ?? DEFAULT_SUMMARY_CACHE_MS;
  if (!Number.isSafeInteger(cache) || cache < 0 || cache > 60_000) {
    throw new ControlApiConfigError('jobs.summaryCacheMs must be an integer from 0 to 60000');
  }
  return {
    listPayloadBytes: bounded(
      'jobs.listPayloadBytes',
      options.listPayloadBytes,
      DEFAULT_LIST_PAYLOAD_BYTES,
      1_048_576
    ),
    detailPayloadBytes: bounded(
      'jobs.detailPayloadBytes',
      options.detailPayloadBytes,
      DEFAULT_DETAIL_PAYLOAD_BYTES,
      16 * 1_048_576
    ),
    maxPageSize,
    defaultPageSize,
    summaryCacheMs: cache,
    maxBulkJobs: bounded('jobs.maxBulkJobs', options.maxBulkJobs, DEFAULT_MAX_BULK_JOBS, 100_000),
    bulkBodyBytes: bounded(
      'jobs.bulkBodyBytes',
      options.bulkBodyBytes,
      DEFAULT_BULK_BODY_BYTES,
      512 * 1_048_576
    ),
    maxOffset: bounded('jobs.maxOffset', options.maxOffset, MAX_PAGE_OFFSET, MAX_PAGE_OFFSET),
    actionBudgetMs: bounded(
      'jobs.actionBudgetMs',
      options.actionBudgetMs,
      DEFAULT_ACTION_BUDGET_MS,
      120_000
    ),
    events: resolveEvents(options.events),
    maxMetricsMinutes: bounded(
      'jobs.maxMetricsMinutes',
      options.maxMetricsMinutes,
      1_440,
      MAX_THROUGHPUT_MINUTES
    ),
    workflowQueue: workflowQueue(options.workflowQueue),
    workflowIdleMs: bounded(
      'jobs.workflowIdleMs',
      options.workflowIdleMs,
      DEFAULT_WORKFLOW_IDLE_MS,
      86_400_000
    ),
    workflowServedMs: bounded(
      'jobs.workflowServedMs',
      options.workflowServedMs,
      DEFAULT_WORKFLOW_SERVED_MS,
      86_400_000
    ),
  };
}
