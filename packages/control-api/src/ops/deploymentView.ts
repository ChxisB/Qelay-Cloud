import { budget, LATEST_VERSION } from '@qelay-cloud/store-postgres';
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
  const [databaseOk, tick, schema, usage, workers, scan] = await Promise.all([
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
  ]);
  return { databaseOk, latencyMs, tick, schema, usage, workers, scan };
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
  const notRung = rows === null ? null : rows.reduce((sum, row) => sum + row.notRung, 0);
  const oldest =
    rows === null
      ? null
      : rows.reduce<number | null>(
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
    warnings: deploymentWarnings(parts),
    timestamp: clock.now(),
  };
}
