import type { JobRecord, JobState } from '@qelay-cloud/core';
import type { CronRecord, CronSpec } from '../cron/types';
import type { AuditEntry, AuditIntent, AuditPage, AuditQuery, AuditResult } from './audit';
import {
  AUDIT_PRUNE_INTERVAL_MS,
  beginAudit,
  finishAudit,
  listAudit,
  pruneAudit,
  recordAudit,
} from './audit';
import type { CleanOptions, CleanReport } from './clean';
import { cleanJobs } from './clean';
import type { CompletionPrune } from './completions';
import { pruneCompletions } from './completions';
import type { StoreContext } from './context';
import type { CronFiring } from './crons';
import { claimDueCrons, deleteCron, getCron, listCrons, upsertCron } from './crons';
import { pruneEventCommits } from './eventCommitPrune';
import type { EventTrim } from './eventRetention';
import { DEFAULT_EVENT_TRIM_LIMIT, trimEvents } from './eventRetention';
import type { GroupPrune } from './groupRetention';
import { pruneGroupStates } from './groupRetention';
import type { EventCursor, EventPage } from './journal';
import { eventBaseline, readEvents } from './journal';
import type { JobLogEntry, LogLevel } from './logs';
import { addJobLog, clearJobLogs, listJobLogs } from './logs';
import type { DlqConfigPatch, QueueConfig, StallConfigPatch } from './queueConfig';
import { getQueueConfig, setDlqConfig, setStallConfig } from './queueConfig';
import type { DashboardTotals, JobStatePage, QueueSummaryPage } from './readModels';
import {
  dashboardTotals,
  jobByCustomId,
  jobsByState,
  priorityCounts,
  queueSummaries,
} from './readModels';
import type { NamespaceTotals, Throughput } from './throughput';
import { namespaceTotals, throughput } from './throughput';
import type { TickLease, TickStatus } from './tickState';
import { acquireTickLease, recordTick, releaseTickLease, tickStatus } from './tickState';
import type { WorkerExpiry, WorkerInfo, WorkerRegistration, WorkerStats } from './workers';
import {
  expireWorkers,
  heartbeatWorker,
  listWorkers,
  registerWorker,
  removeClientWorkers,
  removeWorker,
} from './workers';

/**
 * The parts of `PostgresStore` that are not the `StateStore` contract, grouped by subject so the
 * store class stays small: each is a thin binding of the module's functions to the store context.
 */

/** Recurring jobs (`store.crons`). */
export interface CronApi {
  /** Creates a cron or replaces the one with this name. Keeps `executions`; see `upsertCron`. */
  upsert(spec: CronSpec): Promise<CronRecord>;
  get(name: string): Promise<CronRecord | null>;
  list(): Promise<CronRecord[]>;
  /** Jobs the cron already created stay. False when there was no such cron. */
  delete(name: string): Promise<boolean>;
  /** Fires the crons that are due, once each across any number of concurrent callers. A step of `tick`. */
  claimDue(limit?: number): Promise<CronFiring>;
}

export const cronApi = (ctx: StoreContext): CronApi => ({
  upsert: (spec) => upsertCron(ctx, spec),
  get: (name) => getCron(ctx, name),
  list: () => listCrons(ctx),
  delete: (name) => deleteCron(ctx, name),
  claimDue: (limit) => claimDueCrons(ctx, limit),
});

/** The registry of live workers (`store.workers`). */
export interface WorkerApi {
  /** Registers a worker, or re-registers a known one keeping its start time and counters. */
  register(registration: WorkerRegistration): Promise<WorkerInfo>;
  /** False when the worker is not registered (it expired): register it again. */
  heartbeat(id: string, stats?: WorkerStats): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Removes every worker a client registered. Returns how many. */
  removeClient(clientId: string): Promise<number>;
  list(): Promise<WorkerInfo[]>;
  /** Deletes workers with no heartbeat for `workerExpireMs`. A step of `tick`. */
  expire(limit?: number): Promise<WorkerExpiry>;
}

export const workerApi = (ctx: StoreContext): WorkerApi => ({
  register: (registration) => registerWorker(ctx, registration),
  heartbeat: (id, stats) => heartbeatWorker(ctx, id, stats),
  remove: (id) => removeWorker(ctx, id),
  removeClient: (clientId) => removeClientWorkers(ctx, clientId),
  list: () => listWorkers(ctx),
  expire: (limit) => expireWorkers(ctx, limit),
});

/** What the panel and the Control API configure per queue (`store.queues`). */
export interface QueueApi {
  /** Pause state, both limits, and the stall and DLQ settings, with the defaults for a queue never used. */
  config(queue: string): Promise<QueueConfig>;
  /** Patch: only the keys given change. */
  setStallConfig(queue: string, patch: StallConfigPatch): Promise<QueueConfig>;
  /** Patch: only the keys given change. Lowering `maxEntries` trims the DLQ in the same transaction. */
  setDlqConfig(queue: string, patch: DlqConfigPatch): Promise<QueueConfig>;
}

export const queueApi = (ctx: StoreContext): QueueApi => ({
  config: (queue) => getQueueConfig(ctx, queue),
  setStallConfig: (queue, patch) => setStallConfig(ctx, queue, patch),
  setDlqConfig: (queue, patch) => setDlqConfig(ctx, queue, patch),
});

/** What the panel's lists and dashboard read (`store.readModels`). Each call is one bounded query. */
export interface ReadModelApi {
  /** The queues by name, each with its counts by state. `after` is the previous page's `next`. */
  queueSummaries(page?: { limit?: number; after?: string }): Promise<QueueSummaryPage>;
  /** Queue count, paused queue count and the job counts of every queue summed. */
  dashboard(): Promise<DashboardTotals>;
  /** One page of a queue's jobs in a state, with the state's total. Claim order for claimable states. */
  jobsByState(
    queue: string,
    state: JobState,
    page?: { limit?: number; offset?: number }
  ): Promise<JobStatePage>;
  /** A job's id is its custom id when it has one, so this is a primary-key lookup. */
  jobByCustomId(queue: string, customId: string): Promise<JobRecord | null>;
  /** The claimable jobs of a queue by priority. See `priorityCounts`. */
  priorityCounts(queue: string): Promise<Readonly<Record<string, number>>>;
}

export const readModelApi = (ctx: StoreContext): ReadModelApi => ({
  queueSummaries: (page) => queueSummaries(ctx, page),
  dashboard: () => dashboardTotals(ctx),
  jobsByState: (queue, state, page) => jobsByState(ctx, queue, state, page),
  jobByCustomId: (queue, customId) => jobByCustomId(ctx, queue, customId),
  priorityCounts: (queue) => priorityCounts(ctx, queue),
});

/** The event journal (`store.events`): how a reader follows what changed, and its retention. */
export interface EventsApi {
  /** The end of the journal now: a reader that starts here sees only what comes after. */
  baseline(): Promise<EventCursor>;
  /** One page after `cursor`, in commit order. `gap` means events were deleted unread: reload from the jobs. */
  read(cursor: EventCursor, options?: { limit?: number; queue?: string }): Promise<EventPage>;
  /** Deletes events past the window or their queue's cap. A step of `tick`. */
  trim(limit?: number): Promise<EventTrim>;
  /** Deletes commit envelopes nothing refers to any more. A step of `tick`. Returns how many. */
  pruneCommits(limit?: number): Promise<number>;
}

export const eventsApi = (ctx: StoreContext): EventsApi => ({
  baseline: () => eventBaseline(ctx),
  read: (cursor, options) => readEvents(ctx, cursor, options),
  trim: (limit) => trimEvents(ctx, limit ?? DEFAULT_EVENT_TRIM_LIMIT),
  pruneCommits: (limit) => pruneEventCommits(ctx, limit ?? DEFAULT_EVENT_TRIM_LIMIT),
});

/** Per-job log lines (`store.logs`). */
export interface LogApi {
  /** Adds a line, deleting the job's oldest past `maxJobLogs`. False when the job does not exist. */
  add(jobId: string, message: string, level?: LogLevel): Promise<boolean>;
  /** Oldest first. */
  list(jobId: string): Promise<JobLogEntry[]>;
  /** Deletes the job's lines, or all but the newest `keep`. Returns how many it deleted. */
  clear(jobId: string, keep?: number): Promise<number>;
}

export const logApi = (ctx: StoreContext): LogApi => ({
  add: (jobId, message, level) => addJobLog(ctx, jobId, message, level),
  list: (jobId) => listJobLogs(ctx, jobId),
  clear: (jobId, keep) => clearJobLogs(ctx, jobId, keep),
});

/** Completed and failed counts for the panel's charts (`store.metrics`). */
export interface MetricsApi {
  /** One point per minute, oldest first, and the lifetime totals. See `throughput`. */
  throughput(
    queue: string,
    range?: { readonly minutes?: number; readonly until?: number }
  ): Promise<Throughput>;
  /** Lifetime completed and failed counts of every queue summed: what the dashboard shows as totals. */
  totals(): Promise<NamespaceTotals>;
}

export const metricsApi = (ctx: StoreContext): MetricsApi => ({
  throughput: (queue, range) => throughput(ctx, queue, range),
  totals: () => namespaceTotals(ctx),
});

/** Cleanup that the tick also runs in bounded batches (`store.maintenance`). */
export interface MaintenanceApi {
  /** Deletes a queue's completed or failed jobs that finished long enough ago. */
  clean(queue: string, options: CleanOptions): Promise<CleanReport>;
  /** Deletes completion records of jobs that are gone, beyond the newest `maxCompletedJobs`. */
  pruneCompletions(limit?: number): Promise<CompletionPrune>;
  /** Deletes group scheduler state of groups that have no live job. */
  pruneGroupStates(limit?: number): Promise<GroupPrune>;
  /** Takes or renews the in-process tick's leader lease, on the database clock. See `tickState.ts`. */
  acquireTickLease(holder: string, ttlMs: number): Promise<TickLease>;
  /** Gives the lease up if `holder` has it. Returns whether it did. */
  releaseTickLease(holder: string): Promise<boolean>;
  /** Records that a tick ran to the end (`true`) or failed, for `tickStatus`. */
  recordTick(ok: boolean): Promise<void>;
  /** When a tick last succeeded or failed and who leads, for the control API and the alerts. */
  tickStatus(): Promise<TickStatus>;
}

export const maintenanceApi = (ctx: StoreContext): MaintenanceApi => ({
  clean: (queue, options) => cleanJobs(ctx, queue, options),
  pruneCompletions: (limit) => pruneCompletions(ctx, limit),
  pruneGroupStates: (limit) => pruneGroupStates(ctx, limit),
  acquireTickLease: (holder, ttlMs) => acquireTickLease(ctx, holder, ttlMs),
  releaseTickLease: (holder) => releaseTickLease(ctx, holder),
  recordTick: (ok) => recordTick(ctx, ok),
  tickStatus: () => tickStatus(ctx),
});

/** The operator audit log (`store.audit`): one row per mutation of the Control API. See `audit.ts`. */
export interface AuditApi {
  /**
   * Writes the intent as `pending` and returns the entry's id. The caller runs the operation only
   * when this resolves, so an operation that cannot be recorded does not happen.
   */
  begin(intent: AuditIntent): Promise<number>;
  /** Closes a pending entry. False when it is gone or already closed. */
  finish(id: number, result: AuditResult): Promise<boolean>;
  /** Writes an entry for an operation that never ran (refused, rate limited), already closed. */
  record(intent: AuditIntent, result: AuditResult): Promise<number>;
  /** Newest first. */
  list(query?: AuditQuery): Promise<AuditPage>;
  /** Deletes entries past the age and count caps, a bounded batch of each. Appends do this too, at most once a minute. */
  prune(limit?: number): Promise<number>;
}

export const auditApi = (ctx: StoreContext): AuditApi => {
  let prunedAt = Number.NEGATIVE_INFINITY;
  // Retention rides on the appends: no process has to run it, and an idle log does not grow. A
  // failed prune never fails the append (the next one tries again).
  const retain = async (now: number): Promise<void> => {
    if (now - prunedAt < AUDIT_PRUNE_INTERVAL_MS) return;
    prunedAt = now;
    try {
      await pruneAudit(ctx);
    } catch {
      prunedAt = Number.NEGATIVE_INFINITY;
    }
  };
  return {
    begin: async (intent) => {
      const written = await beginAudit(ctx, intent);
      await retain(written.now);
      return written.id;
    },
    finish: (id, result) => finishAudit(ctx, id, result),
    record: async (intent, result) => {
      const written = await recordAudit(ctx, intent, result);
      await retain(written.now);
      return written.id;
    },
    list: (query) => listAudit(ctx, query),
    prune: (limit) => pruneAudit(ctx, limit),
  };
};

export type { AuditEntry };
