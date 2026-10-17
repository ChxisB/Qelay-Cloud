import type { Clock } from '@qelay-cloud/core';
import { LATEST_VERSION } from '@qelay-cloud/store-postgres';
import { within } from '../deadline';
import type { ReadinessProbes } from '../deps';
import type { Route } from '../http/router';
import type { CheckState, HealthResponse, ReadinessResponse, SchemaState } from '../types';

/** The longest a probe may take before it counts as failed, so a hung database cannot hang the probe. */
export const READINESS_DEADLINE_MS = 3_000;

const settle = async (probe: () => Promise<unknown>, deadlineMs: number): Promise<CheckState> => {
  try {
    await within(probe(), deadlineMs);
    return 'ok';
  } catch {
    return 'failed';
  }
};

/** The database's migrations against this build's. Null current is unreadable, not "none". */
export function schemaStateOf(current: number | null, expected: number): SchemaState {
  if (current === null) return 'unknown';
  return current > expected ? 'ahead' : current < expected ? 'behind' : 'current';
}

async function readSchema(
  probes: ReadinessProbes,
  deadlineMs: number
): Promise<ReadinessResponse['checks']['schema']> {
  if (probes.schemaVersion === undefined) return undefined;
  const current = await within(probes.schemaVersion(), deadlineMs).catch(() => null);
  return {
    state: schemaStateOf(current, LATEST_VERSION),
    current,
    expected: LATEST_VERSION,
  };
}

async function readiness(
  probes: ReadinessProbes,
  clock: Clock,
  deadlineMs: number
): Promise<ReadinessResponse> {
  const [database, tick, schema] = await Promise.all([
    settle(() => probes.database(), deadlineMs),
    within(probes.tick(), deadlineMs).catch(() => null),
    readSchema(probes, deadlineMs),
  ]);
  // A database that lacks a migration this build needs cannot serve it: the release's migration
  // step has not finished. A newer or unreadable schema does not stop an older build.
  const behind = schema?.state === 'behind';
  const ready = database === 'ok' && !behind;
  const lastSuccessAt = tick?.lastSuccessAt ?? null;
  return {
    ok: ready,
    ready,
    checks: {
      database: { state: database },
      transport: { state: probes.transport() },
      ...(schema === undefined ? {} : { schema }),
      tick: {
        lastSuccessAt,
        lastFailureAt: tick?.lastFailureAt ?? null,
        ageMs: tick === null || lastSuccessAt === null ? null : tick.now - lastSuccessAt,
      },
    },
    timestamp: clock.now(),
    ...(ready
      ? {}
      : {
          storage: {
            diskFull: false as const,
            error: behind
              ? `the database schema is at version ${schema?.current}, this build needs ${LATEST_VERSION}: run the migrations`
              : 'the database is unavailable',
            since: null,
          },
        }),
  };
}

/**
 * `GET /health` is the only route that needs no token: it answers from memory, touches nothing, and
 * says nothing about jobs. Readiness is behind the token, because it names what the service depends on.
 */
export function healthRoutes(
  version: string,
  probes: ReadinessProbes,
  clock: Clock,
  deadlineMs = READINESS_DEADLINE_MS
): Route[] {
  const startedAt = clock.now();
  const ready: Route['handle'] = async () => {
    const body = await readiness(probes, clock, deadlineMs);
    return Response.json(body, { status: body.ready ? 200 : 503 });
  };
  return [
    {
      method: 'GET',
      path: '/health',
      access: 'public',
      handle: (): HealthResponse => ({
        ok: true,
        status: 'healthy',
        version,
        uptime: Math.max(0, Math.floor((clock.now() - startedAt) / 1000)),
      }),
    },
    { method: 'GET', path: '/health/ready', access: 'read', handle: ready },
    // The path the panel's diagnostics page probes today.
    { method: 'GET', path: '/ready', access: 'read', handle: ready },
  ];
}
