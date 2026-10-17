import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DatabaseOptions, WebhookEnvSettings } from '@qelay-cloud/store-postgres';
import { databaseOptionsFromEnv, webhookSettingsFromEnv } from '@qelay-cloud/store-postgres';
import type { TransportKind, TransportSettings } from '@qelay-cloud/transports';
import { transportSettingsFromEnv } from '@qelay-cloud/transports';
import type { ControlApiOptions, DeploymentSettings, FleetSettings } from '../config';
import { ControlApiConfigError, resolveConfig } from '../config';
import type { Env, ListenSettings } from '../env';
import { controlApiOptionsFromEnv, integer, listenFromEnv, text } from '../env';
import type { EventStreamOptions, JobsOptions } from '../jobs/limits';
import { resolveJobsConfig } from '../jobs/limits';
import type { FeatureFlags } from '../types';

export type { TransportKind };

/** The version `/health` reports when the image does not say (`QCLOUD_VERSION`). */
export const UNSET_VERSION = '0.0.0';

/** Cloud Run sends SIGKILL ten seconds after SIGTERM: the drain must end before it. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8_000;
export const MAX_SHUTDOWN_GRACE_MS = 60_000;

export interface RuntimeSettings extends TransportSettings {
  readonly namespace: string;
  readonly database: DatabaseOptions;
  readonly api: ControlApiOptions;
  readonly jobs: JobsOptions;
  /** Pages a deployment switches off (`QCLOUD_API_WORKFLOWS=false`); the rest follow what is served. */
  readonly features: Partial<FeatureFlags>;
  /** The key webhook secrets are sealed with and the address policy, read the way the tick reads them. */
  readonly webhooks: WebhookEnvSettings;
  readonly listen: ListenSettings;
  readonly shutdownGraceMs: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function flag(env: Env, name: string): boolean {
  const value = text(env, name);
  if (value === undefined) return false;
  if (value !== 'true' && value !== 'false') {
    throw new ControlApiConfigError(`${name} must be "true" or "false"`);
  }
  return value === 'true';
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function fleetFromEnv(env: Env): FleetSettings | undefined {
  const workers = integer(env, 'QCLOUD_FLEET_WORKERS');
  const others = [
    'QCLOUD_FLEET_POOL_SIZE',
    'QCLOUD_FLEET_LISTENERS',
    'QCLOUD_FLEET_CONTROL_PROCESSES',
    'QCLOUD_FLEET_POOLER_POOL_SIZE',
  ];
  if (workers === undefined) {
    const stray = others.find((name) => text(env, name) !== undefined);
    if (stray !== undefined) {
      throw new ControlApiConfigError(`${stray} needs QCLOUD_FLEET_WORKERS: the fleet's size`);
    }
    return undefined;
  }
  return defined({
    workers,
    poolSize: integer(env, 'QCLOUD_FLEET_POOL_SIZE'),
    listeners: integer(env, 'QCLOUD_FLEET_LISTENERS'),
    controlProcesses: integer(env, 'QCLOUD_FLEET_CONTROL_PROCESSES'),
    // The fleet goes through the pooler this process goes through, unless the deployer says otherwise.
    pooler: text(env, 'QCLOUD_DATABASE_POOLER') === 'transaction',
    poolerPoolSize: integer(env, 'QCLOUD_FLEET_POOLER_POOL_SIZE'),
  });
}

function deploymentFromEnv(env: Env): DeploymentSettings {
  const commit = text(env, 'QCLOUD_COMMIT');
  const fleet = fleetFromEnv(env);
  return defined({
    commit,
    tickLateAfterMs: integer(env, 'QCLOUD_API_TICK_LATE_AFTER_MS'),
    tickStaleAfterMs: integer(env, 'QCLOUD_API_TICK_STALE_AFTER_MS'),
    cacheMs: integer(env, 'QCLOUD_API_DEPLOYMENT_CACHE_MS'),
    maxQueues: integer(env, 'QCLOUD_API_TRANSPORT_MAX_QUEUES'),
    fleet,
  });
}

function jobsFromEnv(env: Env): JobsOptions {
  const events: EventStreamOptions = defined({
    pollMs: integer(env, 'QCLOUD_API_EVENTS_POLL_MS'),
    heartbeatMs: integer(env, 'QCLOUD_API_EVENTS_HEARTBEAT_MS'),
    maxLifetimeMs: integer(env, 'QCLOUD_API_EVENTS_MAX_LIFETIME_MS'),
    maxPerPrincipal: integer(env, 'QCLOUD_API_EVENTS_MAX_PER_PRINCIPAL'),
    maxStreams: integer(env, 'QCLOUD_API_EVENTS_MAX_STREAMS'),
  });
  return defined({
    summaryCacheMs: integer(env, 'QCLOUD_API_SUMMARY_CACHE_MS'),
    maxPageSize: integer(env, 'QCLOUD_API_MAX_PAGE_SIZE'),
    actionBudgetMs: integer(env, 'QCLOUD_API_ACTION_BUDGET_MS'),
    // The engine queue and idle window are the tick's own settings, read by the same names.
    workflowQueue: text(env, 'QCLOUD_WORKFLOW_QUEUE'),
    workflowIdleMs: integer(env, 'QCLOUD_WORKFLOW_IDLE_MS'),
    workflowServedMs: integer(env, 'QCLOUD_API_WORKFLOW_SERVED_MS'),
    events: Object.keys(events).length === 0 ? undefined : events,
  });
}

/** `QCLOUD_API_WORKFLOWS=false` hides the Workflows page; "true" and unset leave it to the schema. */
function featuresFromEnv(env: Env): Partial<FeatureFlags> {
  const workflows = text(env, 'QCLOUD_API_WORKFLOWS');
  if (workflows === undefined || workflows === 'true') return {};
  if (workflows !== 'false') {
    throw new ControlApiConfigError('QCLOUD_API_WORKFLOWS must be "true" or "false"');
  }
  return { workflows: false };
}

/** The broker's settings, with this service's error type: the process reports one kind of configuration error. */
function transportSettings(env: Env): TransportSettings {
  try {
    return transportSettingsFromEnv(env);
  } catch (error) {
    if (error instanceof UnsupportedOptionError) throw new ControlApiConfigError(error.message);
    throw error;
  }
}

/**
 * Everything the process takes from its environment, validated before anything connects. A setting
 * that must not run (the development token in production, a wildcard origin, no sign-in at all) is a
 * `ControlApiConfigError` here or in `resolveConfig`, and the database's own variables raise
 * `UnsupportedOptionError`. No message repeats a value.
 */
export function runtimeSettingsFromEnv(env: Env): RuntimeSettings {
  const version = text(env, 'QCLOUD_VERSION') ?? UNSET_VERSION;
  const listen = listenFromEnv(env);
  const api: ControlApiOptions = {
    ...controlApiOptionsFromEnv(env, version),
    deployment: deploymentFromEnv(env),
  };
  const jobs = jobsFromEnv(env);
  // The same validation the app runs, now, so a bad setting stops the process before it connects.
  resolveConfig(api, env);
  resolveJobsConfig(jobs);
  if (
    api.devToken !== undefined &&
    !LOOPBACK_HOSTS.has(listen.hostname) &&
    !flag(env, 'QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK')
  ) {
    throw new ControlApiConfigError(
      'QCLOUD_API_DEV_TOKEN is set while the service listens beyond loopback: configure OIDC, ' +
        'or set QCLOUD_API_DEV_TOKEN_ALLOW_NETWORK=true for a private development network'
    );
  }
  const broker = transportSettings(env);
  const grace = integer(env, 'QCLOUD_API_SHUTDOWN_GRACE_MS') ?? DEFAULT_SHUTDOWN_GRACE_MS;
  if (grace > MAX_SHUTDOWN_GRACE_MS) {
    throw new ControlApiConfigError(
      `QCLOUD_API_SHUTDOWN_GRACE_MS must be at most ${MAX_SHUTDOWN_GRACE_MS}`
    );
  }
  return {
    namespace: text(env, 'QCLOUD_NAMESPACE') ?? 'default',
    ...broker,
    database: databaseOptionsFromEnv(env, {
      applicationName: 'qcloud-api',
      purpose: 'the database the API reads and writes',
    }),
    api,
    jobs,
    features: featuresFromEnv(env),
    webhooks: webhookSettingsFromEnv(env),
    listen,
    shutdownGraceMs: grace,
  };
}
