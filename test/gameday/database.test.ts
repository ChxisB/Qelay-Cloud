import { expect, test } from 'bun:test';
import { SQL } from 'bun';
import { PostgresStore } from '../../packages/store-postgres/src';
import { openDatabase } from '../../packages/store-postgres/src/connection/connect';
import { until, untilFinished } from '../scenarios/scenario';
import { openStack } from '../scenarios/stack';
import { describeDb, testDatabaseUrl } from '../support/db';
import { TcpProxy } from '../support/tcpProxy';
import { operator, targetOf, urlVia } from './support';

/**
 * docs/runbooks/connection-exhaustion.md, slow-claims.md, control-api-errors.md and
 * database-storage-full.md: what a database in trouble looks like from the operator's side, and the
 * runbook's own queries and routes used to find it and put it right.
 */
describeDb('game day: the database', () => {
  test('connections near the limit: connections_high, the runbook query names the holder, closing it clears the warning', async () => {
    const s = await openStack('postgres');
    let hog: SQL | undefined;
    try {
      const api = operator(targetOf(s));
      const { inUse, maxConnections } = (await api.deployment()).connections;
      const hold = Math.ceil(maxConnections * 0.85) - inUse;
      expect(hold).toBeGreaterThan(0); // the drill is run alone on its database
      // A Bun.SQL pool opens all of `max` at once, so `max` is exactly what is held.
      hog = new SQL({ url: testDatabaseUrl(), max: hold });
      await Promise.all(Array.from({ length: hold }, () => hog!`SELECT pg_sleep(0.3)`));

      await until(
        'connections_high',
        async () => (await api.codes()).includes('connections_high'),
        10_000
      );
      // The runbook's check 2: many `idle` entries from one name is a pool larger than you set.
      const rows = await s.fresh.sql<
        Array<{ application_name: string; state: string; count: string }>
      >`
        SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC`;
      expect(rows[0]).toMatchObject({ state: 'idle' });
      expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(hold);

      await hog.close(); // the runbook's fix for a stuck process: its connections close
      hog = undefined;
      await until(
        'no connections warning',
        async () => !(await api.codes()).some((c) => c.startsWith('connections_')),
        10_000
      );
    } finally {
      await hog?.close().catch(() => {});
      await s.drop();
    }
  }, 60_000);

  test('a fleet that does not fit: connection_budget_exceeded names it before any leak is looked for', async () => {
    const s = await openStack('postgres');
    try {
      const body = await operator(targetOf(s), { fleet: { workers: 500 } }).deployment();
      expect(body.connections.needed).toBeGreaterThan(body.connections.maxConnections);
      expect(body.warnings.map((w: any) => w.code)).toContain('connection_budget_exceeded');
    } finally {
      await s.drop();
    }
  }, 30_000);

  test('slow claims: a lock held on qcloud_jobs shows as Lock waits, ending the holder lets the job start', async () => {
    const s = await openStack('postgres');
    try {
      const job = await s.queue().add('behind-a-lock', {});
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let holder = 0;
      const locker = s.fresh.sql
        .begin(async (tx) => {
          const [row] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          await tx.unsafe('LOCK TABLE qcloud_jobs IN ACCESS EXCLUSIVE MODE');
          holder = row!.pid;
          await held;
        })
        .catch(() => {});
      await until('the lock', () => holder !== 0, 5_000);

      let ran = false;
      s.worker(() => void (ran = true));
      await Bun.sleep(1_500);
      expect(ran).toBe(false);

      // The runbook's check 2, verbatim apart from the columns this drill does not need.
      const waits = await s.fresh.sql<
        Array<{ pid: number; state: string; wait_event_type: string | null }>
      >`
        SELECT pid, state, wait_event_type FROM pg_stat_activity
        WHERE datname = current_database() AND state <> 'idle' ORDER BY now() - query_start DESC`;
      expect(waits.some((w) => w.wait_event_type === 'Lock')).toBe(true);
      expect(waits.find((w) => w.pid === holder)?.state).toBe('idle in transaction');

      await s.fresh.sql`SELECT pg_terminate_backend(${holder})`;
      release();
      await locker;
      await untilFinished(s, [job.id], 15_000);
      expect(ran).toBe(true);
    } finally {
      await s.drop();
    }
  }, 60_000);

  test('control API 5xx: the database is unreachable, /health stays up, /health/ready says why, workers carry on, recovery needs nothing from the API', async () => {
    const s = await openStack('postgres');
    const proxy = await TcpProxy.start({
      targetHost: '127.0.0.1',
      targetPort: Number(new URL(testDatabaseUrl()).port),
    });
    const viaProxy = new SQL({
      url: urlVia(proxy.port),
      max: 2,
      connection: { search_path: s.fresh.name },
      connectionTimeout: 2,
    });
    try {
      const store = new PostgresStore({
        db: openDatabase({
          url: urlVia(proxy.port),
          schema: s.fresh.name,
          poolSize: 2,
          operationDeadlineMs: 2_000,
        }),
        namespace: s.namespace,
      });
      const api = operator({ store, sql: viaProxy, transport: s.ring });
      expect((await api.call('GET', '/health/ready')).status).toBe(200);

      await proxy.refuse();
      expect((await api.call('GET', '/health')).status).toBe(200);
      const ready = await api.call('GET', '/health/ready');
      expect(ready.status).toBe(503);
      const summary = await api.call('GET', '/queues/summary');
      expect(summary.status).toBeGreaterThanOrEqual(500);
      // One log line per request, with an id to search by, and no body or token in it.
      const failed = api.log.requests.find((r) => r.route === '/queues/summary');
      expect(failed?.status).toBe(summary.status);
      expect(failed?.requestId).toBeTruthy();
      expect(JSON.stringify(api.log)).not.toContain('gameday-token');

      // What the runbook calls safe: the API is not in the path of the work.
      let ran = false;
      s.worker(() => void (ran = true));
      const job = await s.queue().add('while-api-down', {});
      await untilFinished(s, [job.id]);
      expect(ran).toBe(true);

      await proxy.accept();
      await until(
        'ready again',
        async () => (await api.call('GET', '/health/ready')).status === 200,
        15_000
      );
      expect((await api.call('GET', '/queues/summary')).status).toBe(200);
    } finally {
      await proxy.stop().catch(() => {});
      await viaProxy.close().catch(() => {});
      await s.drop();
    }
  }, 60_000);

  test('storage growth: the runbook query ranks the tables, cleaning finished jobs in rounds frees them', async () => {
    const s = await openStack('postgres');
    try {
      const api = operator(targetOf(s));
      s.worker(() => {}, { concurrency: 10 });
      const jobs = await s
        .queue()
        .addBulk(Array.from({ length: 60 }, (_, n) => ({ name: 'done', data: { n } })));
      await untilFinished(
        s,
        jobs.map((job) => job.id),
        20_000
      );

      const sizes = await s.fresh.sql<Array<{ relname: string }>>`
        SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total
        FROM pg_class WHERE relkind = 'r' AND relname LIKE 'qcloud\\_%' AND relnamespace = current_schema()::regnamespace
        ORDER BY pg_total_relation_size(oid) DESC LIMIT 10`;
      expect(sizes.map((r) => r.relname)).toContain('qcloud_jobs');

      const counts = async () => (await api.get('/queues/jobs/counts')).counts.completed as number;
      expect(await counts()).toBe(60);
      await Bun.sleep(50);
      // Without `confirm` the call is refused: a stray POST deletes nothing.
      expect(
        (await api.call('POST', '/queues/jobs/clean', { state: 'completed', grace: 10 })).status
      ).toBe(400);
      expect(await counts()).toBe(60);
      let round = { done: false } as Record<string, any>;
      for (let n = 0; n < 20 && round.done !== true; n += 1) {
        round = await api.post('/queues/jobs/clean', {
          confirm: 'jobs',
          state: 'completed',
          grace: 10,
        });
      }
      expect(round.done).toBe(true);
      expect(await counts()).toBe(0);

      const probe = await s.queue().add('after-clean', {});
      await untilFinished(s, [probe.id]);
    } finally {
      await s.drop();
    }
  }, 60_000);
});
