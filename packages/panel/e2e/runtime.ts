/**
 * The stack the browser specs run against: a migrated Postgres schema, an in-process transport, the
 * Control API twice (an operator's credential and a viewer's) and the built panel served under two
 * mounts. Started by Playwright's `webServer`; nothing here talks to a cloud.
 *
 * `POST /upstream/stop` and `/upstream/start` take the operator's Control API down and up on its
 * port (the SSE reconnect specs), `POST /jobs` adds a job, `POST /seed/failed` leaves one failed,
 * `POST /seed/flow` adds a flow whose one child failed and holds its parent back,
 * `POST /tick/stop` and `/tick/start` stop and resume the in-process tick the Dashboard's status
 * strip reports on, and `POST /worker/start` (body `{queue}`) and `/worker/stop` run and stop one
 * worker, which fails a job whose data says `fail` (the walkthrough). `POST /workflow/start` (body
 * `{name, input}`) starts a run of a workflow the runtime serves (`workflowHost.ts`; the first call starts
 * its worker) and answers its id, `POST /workflow/stop` closes that worker again (it shows in the worker
 * registry), `POST /workflow/repair` (body `{id}`) lets a run's stuck rollback succeed, and `POST /seed/fanout`
 * (body `{id, iterations}`) saves a running for-each of that many items without running it.
 */
import { MemoryTransport } from '@qelay-cloud/transport-local';
import type { ControlApp } from '../../control-api/src';
import { createControlApi, startControlApi } from '../../control-api/src';
import type { RunningServer } from '../../control-api/src/server';
import { TickLoop } from '../../maintenance/src';
import { openTestStore } from '../../store-postgres/test/storeHelpers';
import { KEY as WEBHOOK_KEY } from '../../store-postgres/test/webhookHelpers';
import {
  E2E_API_PORT,
  E2E_BASE_PATH,
  E2E_CONTROL_PORT,
  E2E_CONTROL_TOKEN,
  E2E_DASHBOARD_PORT,
  E2E_LOOPBACK_HOST,
  E2E_SEED_QUEUE,
  E2E_SERVER_TOKEN,
  E2E_TICK_INTERVAL_MS,
  E2E_TICK_LATE_AFTER_MS,
  E2E_TICK_STALE_AFTER_MS,
  E2E_VERSION,
  E2E_VIEWER_API_PORT,
  E2E_VIEWER_TOKEN,
} from './config';
import { servePanel } from './panelServer';
import { seedFailedJob, seedFanOutRun, seedStuckFlow } from './seeds';
import { WorkerControl } from './workerControl';
import { WorkflowHost } from './workflowHost';

const t = await openTestStore({ clock: null, webhookKey: WEBHOOK_KEY });
const transport = new MemoryTransport();
// The real repair loop, on a short interval: stopping it is what a dead tick looks like.
const tick = new TickLoop(
  { store: t.store, transport },
  { intervalMs: E2E_TICK_INTERVAL_MS, holder: 'e2e-tick' }
);
await tick.beat();
tick.start();
const worker = new WorkerControl(t.store, transport);
// The application that owns the workflow definitions; the Control API holds none.
const workflows = new WorkflowHost(t.store, transport);

function api(token: string, role: 'operator' | 'viewer'): ControlApp {
  return createControlApi(
    {
      version: E2E_VERSION,
      production: false,
      devToken: { token, role },
      rateLimit: false,
      // Small thresholds and no cache, so a stopped tick shows within seconds.
      deployment: {
        tickLateAfterMs: E2E_TICK_LATE_AFTER_MS,
        tickStaleAfterMs: E2E_TICK_STALE_AFTER_MS,
        cacheMs: 0,
      },
    },
    {
      transport: { name: 'memory', capabilities: transport.capabilities },
      readiness: {
        database: async () => {
          await t.fresh.sql`SELECT 1`;
        },
        transport: () => 'ok',
        tick: async () => {
          try {
            return await t.store.maintenance.tickStatus();
          } catch {
            return null;
          }
        },
      },
      // The specs enqueue behind the API's back (the control server writes to the store), so a
      // cached summary would hide what they just added.
      jobs: { store: t.store, transport, options: { summaryCacheMs: 0 } },
    },
    {}
  );
}

const operator = api(E2E_SERVER_TOKEN, 'operator');
const viewer = api(E2E_VIEWER_TOKEN, 'viewer');
let operatorServer: RunningServer | null = null;
const listen = (app: ControlApp, port: number) =>
  startControlApi(app, { hostname: E2E_LOOPBACK_HOST, port });
operatorServer = listen(operator, E2E_API_PORT);
const viewerServer = listen(viewer, E2E_VIEWER_API_PORT);

servePanel();

async function operatorCall(path: string, body: unknown): Promise<Response> {
  return operator.handle(
    new Request(`http://api.e2e${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${E2E_SERVER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  );
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

// One waiting job, so the dashboards have a queue to show before a spec has done anything.
await operatorCall(`/queues/${E2E_SEED_QUEUE}/jobs`, { name: 'seed', data: { seeded: true } });

Bun.serve({
  hostname: E2E_LOOPBACK_HOST,
  port: E2E_CONTROL_PORT,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return json({ ok: true });
    if (request.headers.get('authorization') !== `Bearer ${E2E_CONTROL_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (pathname === '/upstream/stop') {
      await operatorServer?.stop(true);
      operatorServer = null;
      return json({ ok: true });
    }
    if (pathname === '/upstream/start') {
      operatorServer ??= listen(operator, E2E_API_PORT);
      return json({ ok: true });
    }
    if (pathname === '/tick/stop') {
      await tick.stop();
      return json({ ok: true });
    }
    if (pathname === '/tick/start') {
      tick.start();
      return json({ ok: true });
    }
    if (pathname === '/worker/stop') {
      await worker.stop();
      return json({ ok: true });
    }
    const body = (await request.json().catch(() => ({}))) as {
      queue?: string;
      name?: string;
      input?: unknown;
      id?: string;
      iterations?: number;
    };
    const queue = body.queue ?? 'e2e';
    if (pathname === '/worker/start') {
      if (!worker.running) worker.start(queue);
      return json({ ok: true, queue });
    }
    if (pathname === '/jobs') {
      const added = await operatorCall(`/queues/${encodeURIComponent(queue)}/jobs`, {
        name: body.name ?? 'seeded',
        data: { seeded: true },
      });
      return json(await added.json(), added.status);
    }
    if (pathname === '/workflow/start') {
      const id = await workflows.run(body.name ?? 'e2e-approval', body.input ?? {});
      return json({ ok: true, id });
    }
    if (pathname === '/workflow/stop') {
      await workflows.stop();
      return json({ ok: true });
    }
    if (pathname === '/workflow/repair') {
      workflows.repair(body.id ?? '');
      return json({ ok: true });
    }
    if (pathname === '/seed/fanout') {
      return json(await seedFanOutRun(t.store, body.id ?? 'e2e-fanout', body.iterations ?? 10_000));
    }
    if (pathname === '/seed/failed') {
      const seeded = await seedFailedJob(t.store, queue, body.name ?? 'doomed');
      return seeded ? json({ ...seeded, queue }) : json({ error: 'nothing to claim' }, 500);
    }
    if (pathname === '/seed/flow') {
      const seeded = await seedStuckFlow(t.store, queue, body.name ?? 'assemble');
      return seeded ? json({ ...seeded, queue }) : json({ error: 'children not claimable' }, 500);
    }
    return json({ error: 'unknown' }, 404);
  },
});

const stop = async () => {
  await worker.stop();
  await workflows.stop();
  await tick.stop();
  await operatorServer?.stop(true);
  await viewerServer.stop(true);
  await t.drop();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
console.log(`e2e runtime ready: panel ${E2E_BASE_PATH} on :${E2E_DASHBOARD_PORT}`);
