import type { DeliveryTransport, TransportCapabilities, WebhookUrlPolicy } from '@qelay-cloud/core';
import type { AuditApi, PostgresStore } from '@qelay-cloud/store-postgres';
import type { Route } from './http/router';
import type { JobsOptions } from './jobs/limits';
import type {
  CheckState,
  FeatureFlags,
  OverviewResponse,
  StatsResponse,
  TransportInfo,
} from './types';

/** What the tick's row says, on the database's clock. */
export interface TickSnapshot {
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  /** Database time of the read, so an age needs no clock of the caller's. */
  readonly now: number;
}

/** What `GET /health/ready` asks. Each probe is bounded by the caller; a throw or a timeout is a failure. */
export interface ReadinessProbes {
  /** Resolves when the database answers a trivial query. */
  database(): Promise<void>;
  /** Whether the broker was reachable the last time anything used it. */
  transport(): CheckState;
  /** The tick's last success and failure, or null when it cannot be read. */
  tick(): Promise<TickSnapshot | null>;
  /**
   * The highest migration the database records (null when it records none). Optional: without it
   * `/health/ready` says nothing about the schema.
   */
  schemaVersion?(): Promise<number | null>;
}

export interface DashboardReadOptions {
  /** Skip the short-lived cache (the caller sent `x-qelay-cache: bypass`). */
  readonly fresh?: boolean;
}

/** The reads behind `/dashboard` and `/stats`, supplied by the jobs and queues routes. */
export interface DashboardReader {
  overview(options?: DashboardReadOptions): Promise<OverviewResponse>;
  stats(options?: DashboardReadOptions): Promise<StatsResponse>;
}

/** The transport this deployment runs, declared once by the process that builds it. */
export interface DeclaredTransport {
  /** For example `gcp-pubsub`, `aws-sqs`, `postgres-local`, `memory`. */
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  /** Default `none`. SQS standard queues are `best-effort`. */
  readonly ordering?: TransportInfo['ordering'];
  /**
   * Whether the broker has a dead-letter queue of bells (Pub/Sub and SQS do; the local and memory
   * transports do not). Default true. When false the Transport page says "none" and does not read one.
   */
  readonly doorbellDeadLetter?: boolean;
  /**
   * Whether the broker documents its message counts as approximate (SQS does). Default false. The
   * Transport page then labels the counts as estimates.
   */
  readonly approximateCounts?: boolean;
}

/**
 * The store and broker behind the jobs and queues routes. One store is one namespace, so everything
 * the routes read or change is that namespace's and no request can name another.
 */
export interface JobsDeps {
  readonly store: PostgresStore;
  /** Rings the doorbell for what an operator action makes claimable (add, promote, delay). */
  readonly transport: DeliveryTransport;
  readonly options?: JobsOptions;
  /**
   * Which webhook destinations may be registered: `https` and public ones unless the deployment is in
   * development mode (`QCLOUD_WEBHOOK_DEV_MODE`). Default: the strict policy. The sender applies the
   * same policy again at every attempt.
   */
  readonly webhookUrlPolicy?: WebhookUrlPolicy;
}

export interface ControlApiDeps {
  readonly transport: DeclaredTransport;
  /** Which features are on; the rest take `DEFAULT_FEATURES`. The panel hides a page whose flag is off. */
  readonly features?: Partial<FeatureFlags>;
  readonly readiness: ReadinessProbes;
  /**
   * The jobs and queues routes (dashboard, queues, jobs, the job inspector, add job). Given, they
   * are served and `/dashboard` and `/stats` read from this store unless `dashboard` is also given.
   */
  readonly jobs?: JobsDeps;
  /** Overrides the reader of `/dashboard` and `/stats`. Without it and without `jobs` they answer 501. */
  readonly dashboard?: DashboardReader;
  /**
   * Where operator mutations are recorded and `GET /audit` reads from. Defaults to the audit log of
   * `jobs.store`. With one, a mutation is written down before it runs and does not run if that
   * fails; without one, mutations are not audited and `/audit` answers 501.
   */
  readonly audit?: AuditApi;
  /** Routes of the other endpoint groups (jobs, queues, DLQ, cron, workers, events, flows, workflows). */
  readonly routes?: readonly Route[];
}

export const DEFAULT_FEATURES: FeatureFlags = {
  dlq: true,
  cron: true,
  flows: false,
  workflows: false,
  webhooks: false,
};
