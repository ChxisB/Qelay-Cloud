/** The unrung-backlog part of the load check: the tick's ring cap, and the plans of the claim and ring queries. */
import { resolveTickConfig, runTick, transportWindowMs } from '../packages/maintenance/src';
import { PostgresStore } from '../packages/store-postgres/src';
import { PLANNED } from '../packages/store-postgres/test/schema.planned';
import { FaultyTransport } from '../test/support/faults/faultyTransport';
import {
  admit,
  counts,
  CountingRing,
  MemoryTransport,
  NAMESPACE,
  Queue,
  QUEUES,
  schema,
  sleep,
} from './load-lib';

type Fresh = Awaited<ReturnType<typeof schema>>;

async function dbNow(fresh: Fresh): Promise<number> {
  const [row] = await fresh.sql<Array<{ t: string }>>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t`;
  return Number(row!.t);
}

/** EXPLAIN (ANALYZE, BUFFERS) of the planned queries on the loaded table, with the time values of the plan test made real. */
async function plans(fresh: Fresh): Promise<void> {
  const now = await dbNow(fresh);
  console.log('\n### EXPLAIN (ANALYZE, BUFFERS) on the loaded table');
  for (const planned of PLANNED.filter((p) =>
    /^(claim, (FIFO|LIFO)|ring query|promotion)/.test(p.query)
  )) {
    const sql = planned.sql
      .replace(/\b5000\b/g, String(now))
      .replace(/\b4000\b/g, String(now - 2_000));
    const rows = await fresh.sql.unsafe<Array<Record<string, string>>>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`
    );
    const lines = rows.map((row) => row['QUERY PLAN']!);
    const used = [...new Set(lines.flatMap((l) => /using (\S+)/.exec(l)?.[1] ?? []))];
    const time = lines.find((l) => l.startsWith('Execution Time'))?.replace('Execution Time: ', '');
    const buffers = lines.find((l) => l.trim().startsWith('Buffers:'))?.trim();
    const returned = /rows=([\d.]+)/.exec(lines[0]!)?.[1];
    const verdict = lines.some((l) => /Seq Scan/.test(l))
      ? 'SEQUENTIAL SCAN'
      : used.includes(planned.index)
        ? `planned index ${planned.index}`
        : `${used.join(' + ')} (the plan test names ${planned.index})`;
    const sorted = lines.some((l) => /Sort/.test(l)) ? ', with a Sort node' : '';
    console.log(
      `- ${planned.query}: ${time}, ${returned} rows, ${buffers ?? ''}; ${verdict}${sorted}`
    );
  }
}

/** A backlog whose publishes all failed, the tick's worst case: what a cap of N rings per pass does to it. */
export async function backlog(jobs: number): Promise<void> {
  const fresh = await schema();
  const memory = new MemoryTransport();
  const dead = new FaultyTransport(memory);
  dead.failNext(1_000_000);
  const store = new PostgresStore({ db: fresh.db, namespace: NAMESPACE });
  const queues = QUEUES.map((name) => new Queue(name, { store, transport: dead }));
  const admitMs = await admit(queues, jobs);
  console.log(`\n## Unrung backlog of ${jobs} jobs over ${QUEUES.length} queues`);
  console.log(
    `admitted in ${admitMs.toFixed(0)} ms with every publish failing; states ${JSON.stringify(await counts(fresh.sql))}`
  );

  console.log('\n### One tick pass over the backlog, by per-queue ring cap');
  for (const [cap, items] of [
    [100, 200],
    [1_000, 200],
    [1_000, 100_000],
  ] as const) {
    await fresh.sql`UPDATE qcloud_jobs SET rung_at = NULL WHERE namespace = ${NAMESPACE}`;
    await fresh.sql`ANALYZE qcloud_jobs`;
    const sink = new CountingRing(memory);
    const tickStore = new PostgresStore({
      db: fresh.db,
      namespace: NAMESPACE,
      ringWindowMs: transportWindowMs(sink),
    });
    const config = resolveTickConfig(
      sink,
      {
        intervalMs: 5_000,
        ringGraceMs: 0,
        maxRingsPerQueue: cap,
        maxItems: items,
        maxPassMs: 60_000,
      },
      tickStore
    );
    const started = performance.now();
    const pass = await runTick({ store: tickStore, transport: sink }, config);
    const ms = performance.now() - started;
    const passes = Math.ceil(jobs / Math.max(1, sink.items));
    console.log(
      `cap ${cap}, maxItems ${items}: one pass ${ms.toFixed(0)} ms, ${sink.items} doorbells ` +
        `(due ${pass.ring.due}, rung ${pass.ring.rung}), more work ${pass.moreWork}; ` +
        `${passes} passes to ring the whole backlog once (${passes * 5} s at a 5 s interval)`
    );
  }

  // A mixed table, as a busy one is: half the jobs rung a while ago and still waiting, half never rung.
  await sleep(2_500);
  await fresh.sql`UPDATE qcloud_jobs SET rung_at = NULL WHERE namespace = ${NAMESPACE}`;
  await fresh.sql`
    UPDATE qcloud_jobs SET rung_at = ${(await dbNow(fresh)) - 5_000}::bigint
    WHERE namespace = ${NAMESPACE} AND hashtext(id) % 2 = 0`;
  await fresh.sql`ANALYZE qcloud_jobs`;
  await plans(fresh);

  await Promise.all(queues.map((q) => q.close({ timeout: 1_000 }).catch(() => {})));
  await memory.close();
  await fresh.drop();
}
