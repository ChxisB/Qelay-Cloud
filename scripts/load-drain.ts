/** One drain of the load check: workers running, jobs admitted meanwhile, until every job has completed. */
import { TickLoop, transportWindowMs } from '../packages/maintenance/src';
import { openDatabase, PostgresStore } from '../packages/store-postgres/src';
import { testDatabaseUrl } from '../test/support/db';
import {
  admit,
  counts,
  CountingRing,
  MemoryTransport,
  NAMESPACE,
  Queue,
  reconcile,
  schema,
  sleep,
  startFleet,
  summary,
} from './load-lib';

export interface Run {
  readonly label: string;
  readonly queues: readonly string[];
  readonly jobs: number;
  readonly workers: number;
  /** The in-process tick's interval, or null for no tick. */
  readonly tickMs: number | null;
  readonly rateLimit?: number;
}

const round = (n: number): string => n.toFixed(0);

/** What the database's backends are waiting on, and which statements wait on a lock, sampled every 50 ms. */
function sampleActivity(sql: Awaited<ReturnType<typeof schema>>['sql']) {
  const waits = new Map<string, number>();
  const blocked = new Map<string, number>();
  let polls = 0;
  let running = true;
  const done = (async () => {
    while (running) {
      const rows = await sql<Array<{ w: string; q: string; n: string }>>`
        SELECT coalesce(wait_event_type || ':' || wait_event, 'running') AS w,
               CASE WHEN wait_event_type = 'Lock'
                    THEN left(regexp_replace(query, '\s+', ' ', 'g'), 70) ELSE '' END AS q,
               count(*) AS n
        FROM pg_stat_activity
        WHERE application_name = 'qcloud:load' AND state = 'active' AND pid <> pg_backend_pid()
        GROUP BY 1, 2`;
      polls += 1;
      for (const row of rows) {
        waits.set(row.w, (waits.get(row.w) ?? 0) + Number(row.n));
        if (row.q !== '') blocked.set(row.q, (blocked.get(row.q) ?? 0) + Number(row.n));
      }
      await sleep(50);
    }
  })();
  const top = (map: Map<string, number>, n: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ${(v / Math.max(1, polls)).toFixed(2)}/poll`);
  return {
    async stop() {
      running = false;
      await done;
      return { polls, waits: top(waits, 4), locks: top(blocked, 2) };
    },
  };
}

export async function drain(run: Run): Promise<boolean> {
  const fresh = await schema();
  const memory = new MemoryTransport();
  const timer = setInterval(() => memory.tick(), 10);
  const producerRing = new CountingRing(memory);
  const tickRing = new CountingRing(memory);
  const dbs = Array.from({ length: run.workers }, () =>
    openDatabase({
      url: testDatabaseUrl(),
      schema: fresh.name,
      poolSize: 2,
      applicationName: 'qcloud:load',
    })
  );
  const store = new PostgresStore({ db: fresh.db, namespace: NAMESPACE });
  const queues = run.queues.map((name) => new Queue(name, { store, transport: producerRing }));
  if (run.rateLimit !== undefined) await queues[0]!.setRateLimit(run.rateLimit, 1_000);
  const fleet = startFleet({
    db: (n) => dbs[n]!,
    transport: memory,
    queues: run.queues,
    workers: run.workers,
    concurrency: 10,
  });
  const tickErrors: string[] = [];
  const tickSteps = new Map<string, { n: number; max: number }>();
  const loop =
    run.tickMs === null
      ? null
      : new TickLoop(
          {
            store: new PostgresStore({
              db: fresh.db,
              namespace: NAMESPACE,
              ringWindowMs: transportWindowMs(tickRing),
            }),
            transport: tickRing,
            telemetry: {
              duration(step, ms) {
                const seen = tickSteps.get(step) ?? { n: 0, max: 0 };
                tickSteps.set(step, { n: seen.n + 1, max: Math.max(seen.max, ms) });
              },
              gauge() {},
              error: (step, error) =>
                tickErrors.push(
                  `${step}: ${String((error as Error).message ?? error).slice(0, 200)}`
                ),
            },
          },
          { intervalMs: run.tickMs, ringGraceMs: 500, worstLatenessMs: 100, holder: 'load' }
        );
  loop?.start();
  const activity = sampleActivity(fresh.sql);

  const started = performance.now();
  const admitMs = await admit(queues, run.jobs);
  let completed = 0;
  while (performance.now() - started < 900_000) {
    completed = (await counts(fresh.sql)).completed ?? 0;
    if (completed >= run.jobs) break;
    await sleep(250);
  }
  const totalMs = performance.now() - started;
  const sampled = await activity.stop();
  await loop?.stop({ timeout: 5_000 });
  await fleet.stop();

  const claims = fleet.stores.flatMap((s) => s.claimMs);
  const sizes = fleet.stores.flatMap((s) => s.claimSizes);
  const result = await reconcile(fresh.sql, fleet.runs, run.jobs);
  const stats = loop?.stats;
  console.log(`\n## ${run.label}`);
  console.log(
    `admit ${run.jobs} in ${round(admitMs)} ms (${round((run.jobs / admitMs) * 1000)}/s); ` +
      `all completed after ${round(totalMs)} ms (${round((run.jobs / totalMs) * 1000)} jobs/s end to end)`
  );
  console.log(
    `claim latency: ${summary(claims)}; ${claims.length} claims, mean ` +
      `${(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)).toFixed(1)} jobs each`
  );
  console.log(
    `bells: ${producerRing.items} rung by the producers, ${tickRing.items} by the tick` +
      (stats ? ` (${stats.led} led beats of ${stats.beats}, ${stats.failed} failed)` : '')
  );
  for (const message of new Set(tickErrors)) console.log(`tick error: ${message}`);
  const slow = [...tickSteps].sort((a, b) => b[1].max - a[1].max).slice(0, 4);
  if (slow.length > 0)
    console.log(
      `slowest tick steps (max ms over passes): ${slow.map(([k, v]) => `${k} ${round(v.max)} (${v.n}x)`).join(', ')}`
    );
  console.log(`backend activity (${sampled.polls} polls): ${sampled.waits.join(', ')}`);
  if (sampled.locks.length > 0)
    console.log(`statements waiting on a lock: ${sampled.locks.join(' | ')}`);
  console.log(
    `reconciliation: ${result.ok ? 'OK' : 'FAILED'} - rows ${result.rows}, ran once ${result.ranOnce}, ` +
      `run twice ${result.doubled}, states ${JSON.stringify(result.states)}`
  );
  clearInterval(timer);
  await Promise.all(queues.map((q) => q.close({ timeout: 1_000 }).catch(() => {})));
  await Promise.all(dbs.map((d) => d.close({ timeout: 1_000 }).catch(() => {})));
  await memory.close();
  await fresh.drop();
  return result.ok;
}
