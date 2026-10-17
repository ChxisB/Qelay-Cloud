/**
 * The Phase 2 performance check (task 37): the Control API's heaviest reads against a realistic
 * volume, over a real loopback socket, with the response time and the size of each answer.
 *
 *   QCLOUD_TEST_DATABASE_URL=... bun run scripts/perf-control-api.ts [bigQueueJobs=100000] [queues=50] [smallQueueJobs=1000]
 *
 * One queue `big` holds `bigQueueJobs`, the other `queues - 1` hold `smallQueueJobs` each, split
 * 70% waiting, 20% completed and 10% delayed. The rows are written straight to the table, copied
 * from one job the store wrote, so every row has a real payload envelope. Each read is made 40
 * times in a row (after 3 warm-ups), then 40 times with 8 callers at once, which is what a few open
 * panels look like. The targets are task 31's: a list or summary page under 500 ms at p95 locally.
 * The client, the server and Postgres share this machine, so the figures are a floor for a split
 * deployment on the network side and a ceiling for the database side.
 */
import { createControlApi, silentLogger, startControlApi } from '../packages/control-api/src';
import { PostgresStore } from '../packages/store-postgres/src';
import { MemoryTransport } from '../packages/transport-local/src';
import { NAMESPACE, percentile, schema } from './load-lib';

const BIG = Number(process.argv[2] ?? 100_000);
const QUEUES = Number(process.argv[3] ?? 50);
const SMALL = Number(process.argv[4] ?? 1_000);
const TOKEN = 'perf-token-0123456789-abcdefghij';
const TARGET_P95_MS = 500;
const SERIAL = 40;
const CONCURRENT = 8;

const fresh = await schema();
const store = new PostgresStore({ db: fresh.db, namespace: NAMESPACE });
const transport = new MemoryTransport();
const queueName = (n: number) => `q${String(n).padStart(2, '0')}`;

async function seed(): Promise<void> {
  const [template] = await store.enqueue([{ queue: 'template', name: 'job', data: { n: 1, text: 'sample' } }]);
  const sql = fresh.sql;
  const insert = (queue: string, count: number) =>
    sql.unsafe(`
      INSERT INTO qcloud_jobs (namespace, id, queue, payload, state, priority, run_at, created_at, completed_at)
      SELECT '${NAMESPACE}', '${queue}-' || lpad(g::text, 7, '0'), '${queue}', source.payload,
             CASE WHEN g % 10 = 0 THEN 'delayed' WHEN g % 5 = 0 THEN 'completed' ELSE 'waiting' END,
             0, CASE WHEN g % 10 = 0 THEN 9000000000000 ELSE g END, g,
             CASE WHEN g % 5 = 0 AND g % 10 <> 0 THEN g END
      FROM generate_series(1, ${count}) g,
           (SELECT payload FROM qcloud_jobs WHERE id = '${template!.id}') source`);
  await insert('big', BIG);
  for (let n = 1; n < QUEUES; n += 1) await insert(queueName(n), SMALL);
  await sql.unsafe(`DELETE FROM qcloud_jobs WHERE id = '${template!.id}'`);
  await sql.unsafe(`DELETE FROM qcloud_queue_state WHERE queue = 'template'`);
  for (const queue of ['big', ...Array.from({ length: QUEUES - 1 }, (_, n) => queueName(n + 1))]) {
    await sql.unsafe(`INSERT INTO qcloud_queue_state (namespace, queue, paused)
      VALUES ('${NAMESPACE}', '${queue}', false) ON CONFLICT DO NOTHING`);
  }
  await sql.unsafe('ANALYZE qcloud_jobs');
}

const started = performance.now();
await seed();
console.log(`seeded ${BIG + (QUEUES - 1) * SMALL} jobs over ${QUEUES} queues in ${Math.round(performance.now() - started)} ms`);

function boot(cacheMs: number) {
  const app = createControlApi(
    {
      version: 'perf',
      production: false,
      devToken: { token: TOKEN, role: 'operator' },
      rateLimit: false,
      logger: silentLogger,
    },
    {
      transport: { name: 'memory', capabilities: transport.capabilities },
      readiness: { database: async () => {}, transport: () => 'ok', tick: async () => null },
      jobs: { store, transport, options: { summaryCacheMs: cacheMs } },
    },
    {}
  );
  return startControlApi(app, { hostname: '127.0.0.1', port: 0 });
}

const READS: readonly [string, string][] = [
  ['dashboard', '/dashboard'],
  ['queues summary', '/queues/summary'],
  ['dashboard queues (page)', '/dashboard/queues?limit=50'],
  ['dashboard queues (big)', '/dashboard/queues/big'],
  ['stats', '/stats'],
  ['queue counts (big)', '/queues/big/counts'],
  ['jobs list: first page of big', '/queues/big/jobs/list?limit=50'],
  ['jobs list: 500 of big', '/queues/big/jobs/list?limit=500'],
  ['jobs list: waiting of big', '/queues/big/jobs/list?states=waiting&limit=50'],
  ['jobs list: deep offset of big', '/queues/big/jobs/list?limit=50&offset=50000'],
  ['jobs list: delayed of big', '/queues/big/jobs/list?states=delayed&limit=50'],
  ['jobs list: a small queue', `/queues/${queueName(7)}/jobs/list?limit=50`],
  ['dlq stats (big)', '/queues/big/dlq/stats'],
  ['metrics', '/metrics'],
  ['workers', '/workers'],
  ['crons', '/crons'],
];

async function timed(base: string, path: string): Promise<{ ms: number; bytes: number; status: number }> {
  const began = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const bytes = (await response.arrayBuffer()).byteLength;
  return { ms: performance.now() - began, bytes, status: response.status };
}

interface Row {
  name: string;
  path: string;
  status: number;
  bytes: number;
  serial: number[];
  concurrent: number[];
}

async function measure(base: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const [name, path] of READS) {
    for (let n = 0; n < 3; n += 1) await timed(base, path);
    const serial: number[] = [];
    let last = { bytes: 0, status: 0 };
    for (let n = 0; n < SERIAL; n += 1) {
      const result = await timed(base, path);
      serial.push(result.ms);
      last = result;
    }
    const concurrent: number[] = [];
    for (let round = 0; round < SERIAL / CONCURRENT; round += 1) {
      const batch = await Promise.all(Array.from({ length: CONCURRENT }, () => timed(base, path)));
      for (const result of batch) concurrent.push(result.ms);
    }
    rows.push({ name, path, status: last.status, bytes: last.bytes, serial, concurrent });
  }
  return rows;
}

const kb = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);
const at = (values: number[], p: number) => percentile([...values].sort((a, b) => a - b), p).toFixed(1);

function print(title: string, rows: Row[]): number {
  console.log(`\n${title}\n`);
  console.log('| read | status | size | serial p50 | serial p95 | max | 8 at once p95 | target |');
  console.log('|---|---|---|---|---|---|---|---|');
  let over = 0;
  for (const row of rows) {
    const p95 = Number(at(row.serial, 0.95));
    const burst = Number(at(row.concurrent, 0.95));
    const ok = row.status === 200 && p95 < TARGET_P95_MS && burst < TARGET_P95_MS;
    if (!ok) over += 1;
    const max = Math.max(...row.serial).toFixed(1);
    console.log(
      `| ${row.name} | ${row.status} | ${kb(row.bytes)} | ${at(row.serial, 0.5)} ms | ${p95} ms | ${max} ms | ${burst} ms | ${ok ? 'met' : 'OVER'} |`
    );
  }
  return over;
}

let over = 0;
for (const [title, cacheMs] of [
  ['Uncached (the summary cache off: every request reads the database)', 0],
  ['As deployed (the summary cache at its default, 2 s per instance)', 2_000],
] as const) {
  const server = boot(cacheMs);
  try {
    over += print(title, await measure(`http://127.0.0.1:${server.port}`));
  } finally {
    await server.stop(true);
  }
}
await fresh.drop();
console.log(`\n${over === 0 ? 'every read met' : `${over} reads over`} the ${TARGET_P95_MS} ms p95 target`);
process.exit(over === 0 ? 0 : 1);
