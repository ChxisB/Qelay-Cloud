import { webhookPausedBy } from '@qelay-cloud/core';
import type { WebhookRecord } from '@qelay-cloud/store-postgres';
import { budget, LATEST_VERSION, MAX_ISSUE_PAGE } from '@qelay-cloud/store-postgres';
import type { DeploymentResponse } from '../opsTypes';
import { READINESS_DEADLINE_MS, schemaStateOf } from '../routes/health';
import type { OpsContext } from './context';
import { settled } from './context';
import { scanDoorbells } from './doorbells';
import { readTick } from './tick';
import { deploymentWarnings } from './warnings';

/** The probes and reads of the Deployment page, each bounded and each allowed to come back unknown. */
async function readings(ctx: OpsContext, fresh: boolean) {
  const { readiness } = ctx.deps;
  const store = ctx.jobs?.store;
  const deadline = READINESS_DEADLINE_MS;
  let latencyMs: number | null = null;
  const [databaseOk, tick, schema, usage, workers, scan, webhooks, ignored] = await Promise.all([
    settled(async () => {
      const started = performance.now();
      await readiness.database();
      latencyMs = Math.round(performance.now() - started);
      return true;
    }, deadline),
    settled(() => readiness.tick(), deadline),
    store ? settled(() => store.deployment.schemaVersion(), deadline) : null,
    store ? settled(() => store.deployment.connections(), deadline) : null,
    store ? settled(() => store.workers.list(), deadline) : null,
    store ? settled(() => scanDoorbells(ctx, fresh), deadline) : null,
    store ? settled(() => store.webhooks.list(), deadline) : null,
    // At most one live issue per route and 100 routes, so one page holds every ignored one.
    store
      ? settled(() => store.webhooks.issues({ status: 'ignored', limit: MAX_ISSUE_PAGE }), deadline)
      : null,
  ]);
  return { databaseOk, latencyMs, tick, schema, usage, workers, scan, webhooks, ignored };
}

/** `GET /deployment`: version, schema, database, connections, tick, workers and the warnings from them. */
export function readDeployment(ctx: OpsContext, fresh: boolean): Promise<DeploymentResponse> {
  return ctx.cache.get('deployment', () => build(ctx, fresh), fresh);
}

async function build(ctx: OpsContext, fresh: boolean): Promise<DeploymentResponse> {
  const { config, deps, clock } = ctx;
  const { deployment } = config;
  const read = await readings(ctx, fresh);
  const tick = readTick(read.tick, deployment.tickLateAfterMs, deployment.tickStaleAfterMs);

  const fleet = deployment.fleet;
  const needed =
    fleet === null
      ? null
      : (() => {
          const planned = budget({
            workers: fleet.workers,
            ...(fleet.poolSize === undefined ? {} : { poolSize: fleet.poolSize }),
            ...(fleet.listeners === undefined ? {} : { listeners: fleet.listeners }),
            ...(fleet.controlProcesses === undefined
              ? {}
              : { controlProcesses: fleet.controlProcesses }),
            ...(fleet.poolerPoolSize === undefined ? {} : { poolerPoolSize: fleet.poolerPoolSize }),
          });
          return fleet.pooler === true ? planned.pooled : planned.direct;
        })();

  const rows = read.scan === null ? null : [...read.scan.rows.values()];
  // A paused queue and one outside its run window are held on purpose: their unrung jobs are not the tick being behind.
  const live = rows?.filter((row) => !row.paused && !row.windowClosed) ?? null;
  const notRung = live === null ? null : live.reduce((sum, row) => sum + row.notRung, 0);
  const oldest =
    live === null
      ? null
      : live.reduce<number | null>(
          (max, row) =>
            row.oldestNotRungAgeMs === null ? max : Math.max(max ?? 0, row.oldestNotRungAgeMs),
          null
        );
  const partial =
    read.scan !== null &&
    (read.scan.truncated || read.scan.pendingSkipped > 0 || rows!.some((row) => row.capped));

  const parts = {
    devToken: config.devToken !== null,
    schema: {
      current: read.schema,
      expected: LATEST_VERSION,
      state: schemaStateOf(read.schema, LATEST_VERSION),
    },
    database: {
      state: read.databaseOk === true ? ('ok' as const) : ('failed' as const),
      latencyMs: read.databaseOk === true ? read.latencyMs : null,
    },
    transport: { name: deps.transport.name, state: deps.readiness.transport() },
    connections: {
      inUse: read.usage?.inUse ?? null,
      maxConnections: read.usage?.maxConnections ?? null,
      needed,
      mode:
        fleet === null ? null : fleet.pooler === true ? ('pooled' as const) : ('direct' as const),
    },
    tick: {
      ...tick,
      lateAfterMs: deployment.tickLateAfterMs,
      staleAfterMs: deployment.tickStaleAfterMs,
    },
    doorbells: {
      notRung,
      oldestNotRungAgeMs: oldest,
      queuesScanned: rows === null ? null : rows.length,
      partial,
    },
  };
  const interval = deployment.tickIntervalMs;
  const enabled = read.webhooks?.filter((route) => route.enabled) ?? null;
  const timing = {
    tickIntervalMs: interval,
    scheduledRoutes: enabled?.filter((route) => route.schedule !== null).length ?? null,
    shortDelayRoutes:
      enabled === null || interval === null
        ? null
        : enabled.filter((route) => route.delayMs !== null && route.delayMs < interval).length,
    // Only queues with pending jobs are read for their window, which is where it matters.
    closedWindows: rows === null ? null : rows.filter((row) => row.windowClosed).length,
  };
  return {
    ok: true,
    version: config.version,
    commit: deployment.commit,
    production: config.production,
    ...parts,
    workers: {
      total: read.workers === null ? null : read.workers.length,
      active: read.workers === null ? null : read.workers.filter((worker) => worker.active).length,
    },
    warnings: deploymentWarnings({
      ...parts,
      timing,
      webhooks: webhookCounts(
        read.webhooks,
        new Set(read.ignored?.items.map((issue) => issue.webhookId))
      ),
    }),
    timestamp: clock.now(),
  };
}

/**
 * What Home warns about: routes failing, and routes the failure streak paused. An operator's own pause is not a
 * fault, and a route whose issue the operator ignored has been looked at: neither is counted. When the ignored
 * issues could not be read the set is empty, so the warning errs toward showing.
 */
function webhookCounts(
  routes: readonly WebhookRecord[] | null,
  ignored: ReadonlySet<string>
): { failing: number; paused: number } | null {
  if (routes === null) return null;
  const heard = routes.filter((route) => !ignored.has(route.id));
  return {
    failing: heard.filter((route) => route.disabledReason === null && route.alertLevel > 0).length,
    paused: heard.filter((route) => webhookPausedBy(route) === 'failures').length,
  };
}
