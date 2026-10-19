import type {
  ClaimedJob,
  ClaimOptions,
  DlqEntry,
  EnqueuedJob,
  FailureInfo,
  JobQuery,
  JobRecord,
  Lease,
  NewJob,
  OperatorOptions,
  Outcome,
  Page,
  RateLimit,
  Ring,
  RungEntry,
  StateCounts,
  StateStore,
  StoreError,
  TickBudget,
  TickReport,
} from '@qelay-cloud/core';
import { claimJobs } from './store/claim';
import { completeJob, completeJobs } from './store/complete';
import type { StoreContext } from './store/context';
import type { ControlApi } from './store/controlApi';
import { controlApi } from './store/controlApi';
import type { PromotionReport } from './store/delay';
import { promoteDue } from './store/delay';
import { deploymentApi } from './store/deployment';
import type { DeploymentApi } from './store/deployment';
import type { DlqPage, DlqStats } from './store/dlq';
import { dlqStats, listDlq, listDlqPage, purgeDlq, purgeExpiredDlq } from './store/dlq';
import type { DoorbellApi } from './store/doorbell';
import { doorbellApi } from './store/doorbell';
import { enqueueJobs } from './store/enqueue';
import type { ExpiryReport } from './store/expiry';
import { expirePending } from './store/expiry';
import type {
  AuditApi,
  CronApi,
  EventsApi,
  LogApi,
  MaintenanceApi,
  MetricsApi,
  QueueApi,
  ReadModelApi,
  WorkerApi,
} from './store/facets';
import {
  auditApi,
  cronApi,
  eventsApi,
  logApi,
  maintenanceApi,
  metricsApi,
  queueApi,
  readModelApi,
  workerApi,
} from './store/facets';
import { failJob } from './store/fail';
import type { FlowApi } from './store/flowApi';
import { flowApi } from './store/flowApi';
import { heartbeat, release } from './store/lease';
import { pauseQueue, resumeQueue, setConcurrencyLimit, setRateLimit } from './store/limits';
import { cancelJob, changePriority, promoteJob } from './store/operator';
import { prepareJobs } from './store/prepare';
import { counts, getJob, listJobs } from './store/reads';
import type { RecoveryReport } from './store/recovery';
import { recoverExpired } from './store/recovery';
import type { RingQuery } from './store/ringQuery';
import { dueForRing } from './store/ringQuery';
import { markRung } from './store/rings';
import type { PostgresStoreOptions } from './store/storeContext';
import { createStoreContext, DEFAULT_LEASE_MS } from './store/storeContext';
import { runTick } from './store/tick';
import type { WebhookApi } from './store/webhookApi';
import { webhookApi } from './store/webhookApi';
import type { WorkflowApi } from './store/workflowApi';
import { workflowApi } from './store/workflowApi';

export type { PostgresStoreOptions };
export { DEFAULT_LEASE_MS };

/** `StateStore` over PostgreSQL, plus the facets the panel and the Control API need. */
export class PostgresStore implements StateStore {
  private readonly ctx: StoreContext;
  /** Recurring jobs. */
  readonly crons: CronApi;
  /** The registry of live workers. */
  readonly workers: WorkerApi;
  /** Per-queue configuration beyond pause and the limits. */
  readonly queues: QueueApi;
  /** The panel's lists and dashboard. */
  readonly readModels: ReadModelApi;
  /** The event journal: readers and retention. */
  readonly events: EventsApi;
  /** Per-job log lines. */
  readonly logs: LogApi;
  /** Cleanup of finished jobs, completion records and idle group state. */
  readonly maintenance: MaintenanceApi;
  /** Throughput of completed and failed jobs. */
  readonly metrics: MetricsApi;
  /** What the local transport's poll loop and `stats` read. */
  readonly doorbell: DoorbellApi;
  /** One job in full, edits of unfinished jobs, and the deletions of jobs and queues. */
  readonly control: ControlApi;
  /** Flows: parents that wait for their children. */
  readonly flows: FlowApi;
  /** Doorbell health, schema version and connection usage, for the Control API's Deployment page. */
  readonly deployment: DeploymentApi;
  /** The operator audit log of the Control API. */
  readonly audit: AuditApi;
  /** Webhooks: registrations, deliveries, and the calls the sender makes. */
  readonly webhooks: WebhookApi;
  /** Durable workflow executions: the workflow engine's store. */
  readonly workflows: WorkflowApi;
  /** How long a lease lasts from a claim or a heartbeat: a worker beats at a third of it. */
  readonly leaseMs: number;
  /** How far ahead a bell can be rung, in ms: the transport's window. 0: it cannot delay delivery. */
  readonly ringWindowMs: number;

  constructor(options: PostgresStoreOptions) {
    this.ctx = createStoreContext(options);
    this.crons = cronApi(this.ctx);
    this.workers = workerApi(this.ctx);
    this.queues = queueApi(this.ctx);
    this.readModels = readModelApi(this.ctx);
    this.events = eventsApi(this.ctx);
    this.logs = logApi(this.ctx);
    this.maintenance = maintenanceApi(this.ctx);
    this.metrics = metricsApi(this.ctx);
    this.doorbell = doorbellApi(this.ctx);
    this.control = controlApi(this.ctx);
    this.flows = flowApi(this.ctx);
    this.deployment = deploymentApi(this.ctx);
    this.audit = auditApi(this.ctx);
    this.webhooks = webhookApi(this.ctx);
    this.workflows = workflowApi(this.ctx);
    this.leaseMs = this.ctx.leaseMs;
    this.ringWindowMs = this.ctx.ringWindowMs;
  }

  enqueue(jobs: readonly NewJob[]): Promise<EnqueuedJob[]> {
    return enqueueJobs(this.ctx, jobs);
  }

  /** Throws what `enqueue` would throw about these jobs' own input, without using a connection. */
  checkJobs(jobs: readonly NewJob[]): void {
    prepareJobs(jobs, this.ctx.codec, this.ctx.limits);
  }

  markRung(rung: readonly RungEntry[]): Promise<void> {
    return markRung(this.ctx, rung);
  }

  getJob(id: string): Promise<JobRecord | null> {
    return getJob(this.ctx, id);
  }

  listJobs(query: JobQuery): Promise<Page<JobRecord>> {
    return listJobs(this.ctx, query);
  }

  counts(queue: string): Promise<StateCounts> {
    return counts(this.ctx, queue);
  }

  listDlq(queue: string): Promise<DlqEntry[]> {
    return listDlq(this.ctx, queue);
  }

  close(options?: { readonly timeout?: number }): Promise<void> {
    return this.ctx.db.close(options);
  }

  claim(queue: string, owner: string, n: number, options?: ClaimOptions): Promise<ClaimedJob[]> {
    return claimJobs(this.ctx, queue, owner, n, options);
  }

  heartbeat(lease: Lease): Promise<boolean> {
    return heartbeat(this.ctx, lease);
  }

  release(lease: Lease): Promise<Outcome> {
    return release(this.ctx, lease);
  }

  pause(queue: string): Promise<void> {
    return pauseQueue(this.ctx, queue);
  }

  resume(queue: string): Promise<void> {
    return resumeQueue(this.ctx, queue);
  }

  setRateLimit(queue: string, limit: RateLimit | null): Promise<void> {
    return setRateLimit(this.ctx, queue, limit);
  }

  setConcurrencyLimit(queue: string, limit: number | null): Promise<void> {
    return setConcurrencyLimit(this.ctx, queue, limit);
  }

  complete(lease: Lease, result: unknown): Promise<Outcome> {
    return completeJob(this.ctx, lease, result);
  }

  completeMany(
    items: ReadonlyArray<{ readonly lease: Lease; readonly result: unknown }>
  ): Promise<Array<Outcome | StoreError>> {
    return completeJobs(this.ctx, items);
  }

  fail(lease: Lease, error: FailureInfo): Promise<Outcome> {
    return failJob(this.ctx, lease, error);
  }

  /** One pass of lease recovery (at most `limit` jobs). A step of `tick`; not part of `StateStore`. */
  recoverExpired(limit?: number): Promise<RecoveryReport> {
    return recoverExpired(this.ctx, limit);
  }

  /** Deletes pending jobs whose `ttl` elapsed. A step of `tick`; not part of `StateStore`. */
  expirePending(limit?: number): Promise<ExpiryReport> {
    return expirePending(this.ctx, limit);
  }

  /** One page of the queue's DLQ entries, oldest failure first, with the queue's total. */
  listDlqPage(queue: string, page: { limit: number; offset?: number }): Promise<DlqPage> {
    return listDlqPage(this.ctx, queue, page);
  }

  dlqStats(queue: string): Promise<DlqStats> {
    return dlqStats(this.ctx, queue);
  }

  /** Deletes the named failed jobs of the queue, or all of them. Returns how many. */
  purgeDlq(queue: string, jobIds?: readonly string[]): Promise<number> {
    return purgeDlq(this.ctx, queue, jobIds);
  }

  /** Deletes failed jobs older than their queue's `maxAge`. A step of `tick`. Returns how many. */
  purgeExpiredDlq(limit: number): Promise<number> {
    return purgeExpiredDlq(this.ctx, limit);
  }

  /** The tick's work, composed (`store/tick.ts`): recovery, crons, promotion, expiry, retention, then the rings. */
  tick(budget: TickBudget): Promise<TickReport> {
    return runTick(this.ctx, budget);
  }

  /** Moves delayed jobs that came due to waiting or prioritized, at most `limit`. A step of `tick`. */
  promoteDue(limit?: number): Promise<PromotionReport> {
    return promoteDue(this.ctx, limit);
  }

  /** The jobs that need a bell now, read-only. A step of `tick`; not part of `StateStore`. */
  dueForRing(query?: RingQuery): Promise<Ring[]> {
    return dueForRing(this.ctx, query);
  }

  promote(id: string, options?: OperatorOptions): Promise<Outcome> {
    return promoteJob(this.ctx, id, options);
  }

  changePriority(id: string, priority: number, options?: OperatorOptions): Promise<boolean> {
    return changePriority(this.ctx, id, priority, options);
  }

  cancel(id: string, options?: OperatorOptions): Promise<boolean> {
    return cancelJob(this.ctx, id, options);
  }
}
