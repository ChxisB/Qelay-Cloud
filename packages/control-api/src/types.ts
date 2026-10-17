/**
 * The JSON the Control API sends. Field names and nesting follow what the panel's clients read today
 * (`src/lib/types.ts` and `src/lib/bq/serverApi.ts` of `../qelay-control-panel`), so the panel keeps
 * working with a change of base URL; `test/contract/` pins each shape against a verbatim copy of the
 * panel's types. Timestamps are epoch milliseconds.
 */

export type Role = 'viewer' | 'operator';

/** Every error response has exactly this body, and never a stack trace, SQL or a payload. */
export interface ErrorBody {
  readonly error: {
    /** A stable, lower-case snake_case code: callers branch on it, never on `message`. */
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/**
 * `GET /health`: liveness only. It says nothing about the database or the jobs. `status` and `uptime`
 * are there because the panel's connection test rejects a body without them.
 */
export interface HealthResponse {
  readonly ok: true;
  readonly status: 'healthy';
  readonly version: string;
  /** Whole seconds since the process built its routes. */
  readonly uptime: number;
}

export type CheckState = 'ok' | 'failed' | 'unknown';

/** The database's migrations against this build's: `behind` is the only one that stops serving. */
export type SchemaState = 'current' | 'behind' | 'ahead' | 'unknown';

/**
 * `GET /health/ready` (also `GET /ready`, the path the panel probes). `ready` is true when the database
 * answers and has every migration this build needs. The transport and the tick are reported but do not make the service unready: a lost bell is
 * repaired by the tick, and a stale tick is an alert, not a reason to stop serving the panel.
 */
export interface ReadinessResponse {
  readonly ok: boolean;
  readonly ready: boolean;
  readonly checks: {
    readonly database: { readonly state: CheckState };
    readonly transport: { readonly state: CheckState };
    /**
     * Present when the process can read the schema version. `behind` (the database lacks a migration
     * this build needs) makes the service unready: the release step that runs the migrations has not
     * finished, or failed. `ahead` (a newer release already migrated) and `unknown` do not, because
     * the forward-only migrations keep an older build working.
     */
    readonly schema?: {
      readonly state: SchemaState;
      /** The highest migration the database records, or null when it could not be read. */
      readonly current: number | null;
      /** The highest migration this build knows. */
      readonly expected: number;
    };
    readonly tick: {
      /** Database time of the last tick that ran to the end, or null if none has. */
      readonly lastSuccessAt: number | null;
      readonly lastFailureAt: number | null;
      /** Milliseconds since `lastSuccessAt` on the database's clock; null when there is none. */
      readonly ageMs: number | null;
    };
  };
  readonly timestamp: number;
  /**
   * Only when not ready. The panel's probe reads `storage.error` from a 503, so it is here; `diskFull`
   * is always false (this service does not report a full disk) and `error` names the database.
   */
  readonly storage?: {
    readonly diskFull: false;
    readonly error: string | null;
    readonly since: number | null;
  };
}

export interface TransportInfo {
  /** For example `gcp-pubsub`, `aws-sqs`, `postgres-local`, `memory`. */
  readonly name: string;
  /** The longest delay the broker takes at ring time. Null means unbounded. 0 means none. */
  readonly maxDeliverDelayMs: number | null;
  /**
   * What the broker promises about the order of bells. A bell only wakes a worker: the store orders
   * the claims (priority, FIFO or LIFO), so no transport needs more than `best-effort`.
   */
  readonly ordering: 'none' | 'best-effort';
}

export interface FeatureFlags {
  readonly dlq: boolean;
  readonly cron: boolean;
  readonly flows: boolean;
  readonly workflows: boolean;
  readonly webhooks: boolean;
}

/** Panel pages that exist only for a Qelay TCP server or a local control agent, and never apply here. */
export const HIDDEN_FEATURES = [
  'serverControl',
  'sqliteDatabase',
  's3Backup',
  'fleet',
  'queueOperations',
] as const;

/**
 * Operator actions the panel has a button for and this deployment closes. Each answers 501
 * `not_supported` with its name as `details.capability`; `GET /capabilities` lists them so a client
 * can leave the control out instead of offering one that fails.
 */
export const UNSUPPORTED_ACTIONS = [
  'job-fail',
  'job-discard',
  'job-retry',
  'job-move-to-delayed',
  'dlq-retry',
  'dlq-auto-retry',
  'dlq-retention',
] as const;

/** `GET /capabilities`: what the panel shows or hides. */
export interface CapabilitiesResponse {
  readonly transport: TransportInfo;
  readonly features: FeatureFlags;
  readonly hidden: readonly string[];
  /** The actions of `UNSUPPORTED_ACTIONS`: closed, so a client does not offer them. */
  readonly unsupported: readonly string[];
  /** The caller's own role: a client leaves out the controls it may not use. The server stays the authority. */
  readonly principal: { readonly role: Role };
  readonly version: string;
}

export interface OverviewStats {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly completed: number;
  readonly dlq: number;
  readonly totalPushed: number;
  readonly totalPulled: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
  readonly uptime: number;
}

export interface ThroughputRates {
  readonly pushPerSec: number;
  readonly pullPerSec: number;
  readonly completePerSec: number;
  readonly failPerSec: number;
}

export interface WorkerSummary {
  readonly id: string;
  readonly name: string;
  readonly queues: readonly string[];
  readonly lastSeen: number;
  readonly activeJobs: number;
  readonly processedJobs: number;
  readonly failedJobs: number;
}

export interface CronSummary {
  readonly name: string;
  readonly queue: string;
  readonly schedule: string | null;
  readonly repeatEvery: number | null;
  readonly nextRun: number;
  readonly executions: number;
}

export interface MemoryFigures {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly rss: number;
}

/** `GET /dashboard`. */
export interface OverviewResponse {
  readonly ok: boolean;
  readonly stats: OverviewStats;
  readonly throughput: ThroughputRates;
  readonly latency: {
    readonly averages: Readonly<Record<string, number>>;
    readonly percentiles: Readonly<Record<string, { p50: number; p95: number; p99: number }>>;
  };
  readonly memory: MemoryFigures;
  readonly collections: Readonly<Record<string, number>>;
  readonly workers: {
    readonly total: number;
    readonly active: number;
    readonly list: readonly WorkerSummary[];
    readonly truncated: boolean;
  };
  readonly crons: {
    readonly total: number;
    readonly list: readonly CronSummary[];
    readonly truncated: boolean;
  };
  readonly storage: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}

/** `GET /stats`. */
export interface StatsResponse {
  readonly ok: boolean;
  readonly stats: OverviewStats &
    ThroughputRates & {
      readonly prioritized: number;
      readonly 'waiting-children': number;
      readonly [key: string]: number;
    };
  readonly memory: MemoryFigures & { readonly external: number; readonly arrayBuffers: number };
  readonly collections: Readonly<Record<string, number>>;
}
