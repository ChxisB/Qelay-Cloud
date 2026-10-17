import type { DeploymentSettings, RequestLog } from '../../packages/control-api/src';
import { createControlApi } from '../../packages/control-api/src';
import type { DeliveryTransport } from '../../packages/core/src';
import { systemClock } from '../../packages/core/src';
import { runTicks } from '../../packages/maintenance/src';
import type { PostgresStore } from '../../packages/store-postgres/src';
import type { Stack } from '../scenarios/stack';
import { testDatabaseUrl } from '../support/db';

export type Wire = Record<string, any>;

/** Tick ages at which `/deployment` says "late" and "stale". Seconds, not the minutes a deployment uses, so a drill lasts seconds. */
export const LATE_MS = 1_500;
export const STALE_MS = 4_000;

const TOKEN = 'gameday-token-0123456789-abcdefghij';

/** What a drill reads: the store, the database behind it and the broker, which a `Stack` has and so can a bare schema. */
export interface Target {
  readonly store: PostgresStore;
  readonly sql: Stack['fresh']['sql'];
  readonly transport: DeliveryTransport;
  readonly name?: string;
}

export const targetOf = (s: Stack): Target => ({
  store: s.store,
  sql: s.fresh.sql,
  transport: s.ring,
});

/**
 * The operator's view: the real Control API app, in process, over the drill's store and broker, asked
 * the way the runbooks ask it (`GET /deployment`, `GET /transport`, ...). No HTTP server, no OIDC: the
 * development token stands in for the operator's token.
 */
export function operator(target: Target, deployment: DeploymentSettings = {}) {
  const log = {
    requests: [] as RequestLog[],
    errors: [] as Array<{ message: string; fields?: Wire }>,
  };
  const app = createControlApi(
    {
      version: 'gameday',
      devToken: { token: TOKEN },
      rateLimit: false,
      clock: systemClock,
      logger: {
        request: (record) => void log.requests.push(record),
        error: (message, fields) =>
          void log.errors.push({ message, ...(fields ? { fields } : {}) }),
        warn: () => {},
      },
      deployment: {
        cacheMs: 0,
        tickLateAfterMs: LATE_MS,
        tickStaleAfterMs: STALE_MS,
        ...deployment,
      },
    },
    {
      transport: {
        name: target.name ?? 'postgres-local',
        capabilities: target.transport.capabilities,
      },
      readiness: {
        database: async () => void (await target.sql`SELECT 1`),
        transport: () => 'ok',
        tick: () => target.store.maintenance.tickStatus(),
        schemaVersion: () => target.store.deployment.schemaVersion(),
      },
      jobs: { store: target.store, transport: target.transport },
    },
    {}
  );
  const call = (method: string, path: string, body?: unknown): Promise<Response> => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
    if (raw !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    return Promise.resolve(
      app.handle(
        new Request(`http://api.test${path}`, {
          method,
          headers,
          ...(raw === undefined ? {} : { body: raw }),
        })
      )
    );
  };
  const get = async (path: string): Promise<Wire> =>
    (await call('GET', path)).json() as Promise<Wire>;
  return {
    log,
    call,
    get,
    post: async (path: string, body?: unknown): Promise<Wire> =>
      (await call('POST', path, body)).json() as Promise<Wire>,
    deployment: () => get('/deployment'),
    codes: async (): Promise<string[]> =>
      ((await get('/deployment')).warnings as Wire[]).map((warning) => warning.code),
  };
}

/** "Run the tick by hand", as the runbook says: one invocation of the tick, the way `run` does it. */
export const tickByHand = (s: Stack) =>
  runTicks({ store: s.store, transport: s.ring }, s.loops[0]!.config);

/** A metrics sink that keeps what it is given, summed by name: the counters a dashboard would plot. */
export function counters() {
  const sums = new Map<string, number>();
  return {
    sink: {
      increment(name: string, value = 1): void {
        sums.set(name, (sums.get(name) ?? 0) + value);
      },
    },
    get: (name: string): number => sums.get(name) ?? 0,
  };
}

/** The test database's URL with the host and port of `proxyPort`: a worker that connects through a fault proxy. */
export function urlVia(proxyPort: number): string {
  const url = new URL(testDatabaseUrl());
  url.host = `127.0.0.1:${proxyPort}`;
  return url.toString();
}
