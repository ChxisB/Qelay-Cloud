/**
 * The local transport's fan-out: every `NOTIFY` reaches every listener, so N workers on one database receive
 * (bells x N) notifications. This drains a fixed backlog with 1, 4 and 16 workers, each with its own
 * `PostgresLocalTransport` (its own LISTEN connection, as separate processes would have), on one queue, and
 * records the end-to-end rate, so the cost of the fan-out can be set beside the unlisted figures of the load check.
 *
 *   QCLOUD_TEST_DATABASE_URL=... bun run scripts/load-local.ts [jobs=10000]
 *
 * The workers and the producer share this process's event loop: the numbers are a floor, as in the load check.
 */
import { Queue, Worker } from '../packages/sdk/src';
import { openDatabase, PostgresStore } from '../packages/store-postgres/src';
import { PostgresLocalTransport } from '../packages/transport-local/src';
import { testDatabaseUrl } from '../test/support/db';
import { counts, NAMESPACE, PAYLOAD, schema, sleep } from './load-lib';

const jobs = Number(process.argv[2] ?? 10_000);
const CHANNEL = 'qcloud_load_local';

async function drainWith(workers: number): Promise<void> {
  const fresh = await schema();
  const dbs = Array.from({ length: workers + 1 }, () =>
    openDatabase({ url: testDatabaseUrl(), schema: fresh.name, poolSize: 2 })
  );
  const transports: PostgresLocalTransport[] = [];
  const transportOf = (n: number) => {
    const transport = new PostgresLocalTransport({
      db: dbs[n]!,
      source: new PostgresStore({ db: dbs[n]!, namespace: NAMESPACE }).doorbell,
      namespace: NAMESPACE,
      channel: CHANNEL,
    });
    transports.push(transport);
    return transport;
  };
  const producerTransport = transportOf(workers);
  const queue = new Queue('q', {
    store: new PostgresStore({ db: dbs[workers]!, namespace: NAMESPACE }),
    transport: producerTransport,
  });
  const fleet = Array.from(
    { length: workers },
    (_, n) =>
      new Worker('q', () => {}, {
        store: new PostgresStore({ db: dbs[n]!, namespace: NAMESPACE }),
        transport: transportOf(n),
        concurrency: 10,
        heartbeatInterval: 0,
      })
  );
  await sleep(300);
  const started = performance.now();
  for (let from = 0; from < jobs; from += 100) {
    await queue.addBulk(
      Array.from({ length: Math.min(100, jobs - from) }, () => ({ name: 'noop', data: PAYLOAD }))
    );
  }
  while (((await counts(fresh.sql)).completed ?? 0) < jobs && performance.now() - started < 300_000)
    await sleep(100);
  const ms = performance.now() - started;
  const done = (await counts(fresh.sql)).completed ?? 0;
  console.log(
    `${workers} listeners: ${done}/${jobs} completed in ${ms.toFixed(0)} ms (${((done / ms) * 1000).toFixed(0)} jobs/s), ` +
      `${jobs * workers} NOTIFY deliveries (${jobs} bells x ${workers} listeners)`
  );
  await Promise.all(fleet.map((w) => w.close({ graceMs: 0, timeout: 2_000 }).catch(() => {})));
  await queue.close({ timeout: 1_000 }).catch(() => {});
  await Promise.all(transports.map((t) => t.close().catch(() => {})));
  await Promise.all(dbs.map((d) => d.close({ timeout: 1_000 }).catch(() => {})));
  await fresh.drop();
}

console.log(`local transport fan-out: ${jobs} jobs, one queue, ${new Date().toISOString()}`);
for (const workers of [1, 4, 16]) await drainWith(workers);
