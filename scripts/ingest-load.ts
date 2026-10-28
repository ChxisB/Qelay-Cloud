/**
 * Load check of the public ingest (task 10). The real `Bun.serve` listener and handler run over a real store on local
 * Postgres and are driven over HTTP at a set rate, in three runs:
 *
 *   capacity  the limits lifted: what the store accepts, and how long a request takes.
 *   defaults  the limits as shipped, at the same rate: the 429s the per-source limit gives.
 *   flood     the limits as shipped, a flood of random tokens beside one real sender: whether the flood takes the real
 *             sender's share (the global limit counts every request, before the lookup).
 *
 *   QCLOUD_REQUIRE_DB=1 bun scripts/ingest-load.ts [--seconds 10] [--rate 200] [--flood 2000]
 *
 * It fails when the ingest holds more connections than `budget()` counts for one process, or when the requests stored
 * differ from the 200s answered. Honest limit: the client and the server share this process's event loop and one CPU,
 * so the rates are a floor for separate processes, and p99 includes the client's own queueing.
 */
import { generateSourceToken } from '../packages/core/src';
import { createIngestHandler, DEFAULT_LIMITS, startIngest } from '../packages/ingest/src';
import type { IngestLimits } from '../packages/ingest/src';
import { budget, migrate, PostgresStore } from '../packages/store-postgres/src';
import { freshSchema } from '../packages/store-postgres/test/helpers';
import { percentile, sleep } from './load-lib';

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} is a number above 0.`);
  return value;
};
const SECONDS = arg('seconds', 10);
const RATE = arg('rate', 200);
const FLOOD = arg('flood', 2_000);
/** The pool the deployed ingest is given (`ingest.pool_size` and the chart both default to 2). */
const POOL = 2;
const APP = 'qcloud:ingest-load';
const LIFTED: IngestLimits = { ...DEFAULT_LIMITS, perSourcePerMinute: 1e9, globalPerMinute: 1e9 };
const BODY = JSON.stringify({ id: 500, name: 'chris' });

interface Load {
  readonly label: string;
  readonly perSecond: number;
  readonly path: () => string;
}
interface Tally {
  readonly status: Map<number, number>;
  readonly ms: number[];
}

/** Fires `load.perSecond` requests a second for `seconds`, open loop (a slow answer does not slow the next request). */
async function drive(origin: URL, load: Load, seconds: number): Promise<Tally> {
  const tally: Tally = { status: new Map(), ms: [] };
  const inflight = new Set<Promise<void>>();
  const fire = () => {
    const started = performance.now();
    const request = fetch(new URL(load.path(), origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    })
      .then(async (response) => {
        await response.arrayBuffer();
        return response.status;
      })
      .catch(() => 0)
      .then((status) => {
        tally.status.set(status, (tally.status.get(status) ?? 0) + 1);
        tally.ms.push(performance.now() - started);
      })
      .finally(() => inflight.delete(request));
    inflight.add(request);
  };
  const tick = 20;
  const end = performance.now() + seconds * 1000;
  let owed = 0;
  while (performance.now() < end) {
    owed += (load.perSecond * tick) / 1000;
    for (; owed >= 1; owed -= 1) fire();
    await sleep(tick);
  }
  await Promise.all(inflight);
  return tally;
}

const show = (status: Map<number, number>): string =>
  [...status].sort(([a], [b]) => a - b).map(([code, n]) => `${code}:${n}`).join(' ') || '-';

/** One run: a fresh schema, one source with one route, the listener, the loads together; returns whether it held. */
async function run(name: string, limits: IngestLimits, loads: Array<Load | ((token: string) => Load)>) {
  const fresh = await freshSchema({ poolSize: POOL, applicationName: APP });
  let ok = true;
  try {
    await migrate(fresh.db);
    const store = new PostgresStore({ db: fresh.db, namespace: 'load' });
    const source = await store.sources.create({ name: 'Load' }, 'ingest-load');
    if (source.token === null) throw new Error('A new source is issued with a token.');
    const token = source.token;
    await store.webhooks.create({ url: 'https://hooks.example.com/in', source: source.id }, 'ingest-load');
    const server = startIngest(createIngestHandler({ store: store.sources, limits }), {
      hostname: '127.0.0.1',
      port: 0,
      maxBodyBytes: limits.maxBodyBytes,
      readTimeoutMs: limits.readTimeoutMs,
    });

    let held = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const [row] = await fresh.sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${APP}`;
        held = Math.max(held, row?.n ?? 0);
        await sleep(100);
      }
    })();
    const tallies = await Promise.all(
      loads.map((load) => {
        const resolved = typeof load === 'function' ? load(token) : load;
        return drive(server.url, resolved, SECONDS).then((tally) => ({ resolved, tally }));
      })
    );
    sampling = false;
    await sampler;
    await server.stop(true);

    const [stored] = await fresh.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM qcloud_requests WHERE status = 'accepted'`;
    const answered = tallies.reduce((sum, { tally }) => sum + (tally.status.get(200) ?? 0), 0);
    const allowed = budget({ workers: 0, poolSize: POOL, controlProcesses: 1 }).application;
    console.log(`\n${name}  (per source ${limits.perSourcePerMinute}/min, global ${limits.globalPerMinute}/min, ${SECONDS} s)`);
    for (const { resolved, tally } of tallies) {
      const sorted = [...tally.ms].sort((a, b) => a - b);
      console.log(
        `  ${resolved.label.padEnd(14)} ${String(resolved.perSecond).padStart(5)}/s  sent ${String(tally.ms.length).padStart(6)}  ` +
          `${show(tally.status).padEnd(26)} p50 ${percentile(sorted, 0.5).toFixed(1)} ms  p99 ${percentile(sorted, 0.99).toFixed(1)} ms`
      );
    }
    console.log(`  stored ${stored?.n} accepted requests for ${answered} answers of 200; connections held ${held} of ${allowed} budgeted`);
    ok = stored?.n === answered && held <= allowed;
    if (!ok) console.log('  FAILED: the stored requests differ from the 200s, or the budget was exceeded');
  } finally {
    await fresh.drop();
  }
  return ok;
}

const real = (rate: number) => (token: string): Load => ({ label: 'real sender', perSecond: rate, path: () => `/s/${token}` });
const random: Load = { label: 'random tokens', perSecond: FLOOD, path: () => `/s/${generateSourceToken()}` };

const results = [
  await run('capacity', LIFTED, [real(RATE)]),
  await run('defaults', DEFAULT_LIMITS, [real(RATE)]),
  await run('flood', DEFAULT_LIMITS, [real(5), random]),
];
process.exit(results.every(Boolean) ? 0 : 1);
