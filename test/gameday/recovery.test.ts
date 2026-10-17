import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { runTicks } from '../../packages/maintenance/src';
import { Worker } from '../../packages/sdk/src';
import { LATEST_VERSION, migrate, PostgresStore } from '../../packages/store-postgres/src';
import { openDatabase } from '../../packages/store-postgres/src/connection/connect';
import { MemoryTransport } from '../../packages/transport-local/src';
import { Ledger, reconcile, until, untilFinished } from '../scenarios/scenario';
import { openStack, QUEUE } from '../scenarios/stack';
import { describeDb, testDatabaseUrl } from '../support/db';
import { counters } from './support';

const PG_TOOLS = Bun.which('pg_dump') !== null && Bun.which('pg_restore') !== null;
if (!PG_TOOLS)
  console.warn('[gameday] pg_dump or pg_restore is not installed: the restore drill is skipped');

const hex = () => randomBytes(8).toString('hex');

/** The test database's URL with another user, password and database name. */
function urlOf(parts: { user?: string; password?: string; database?: string }): string {
  const url = new URL(testDatabaseUrl());
  if (parts.user !== undefined) url.username = parts.user;
  if (parts.password !== undefined) url.password = parts.password;
  if (parts.database !== undefined) url.pathname = `/${parts.database}`;
  return url.toString();
}

async function run(command: string[], url: string): Promise<void> {
  const target = new URL(url);
  const env = {
    ...process.env,
    PGHOST: target.hostname,
    PGPORT: target.port,
    PGDATABASE: target.pathname.slice(1),
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
  };
  const done = Bun.spawn(command, { env, stdout: 'ignore', stderr: 'pipe' });
  const [code, stderr] = await Promise.all([done.exited, new Response(done.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`);
}

/**
 * docs/runbooks/rotate-database-secret.md and restore-from-backup.md, in the one form a laptop can run:
 * a password changed on a throwaway role, and a dump restored into a second database on the same server.
 * The providers' own commands (a secret version, a point-in-time clone) are not run here.
 */
describeDb('game day: recovering', () => {
  test('rotate the secret: open connections stay, a process that reconnects fails until it has the new one, no job is lost', async () => {
    const s = await openStack('postgres');
    const admin = new SQL({ url: testDatabaseUrl(), max: 1 });
    const role = `qcloud_gd_${hex()}`;
    const [oldPassword, newPassword] = [hex(), hex()];
    try {
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${oldPassword}'`);
      for (const grant of [
        'USAGE ON SCHEMA',
        'ALL ON ALL TABLES IN SCHEMA',
        'ALL ON ALL SEQUENCES IN SCHEMA',
      ]) {
        await admin.unsafe(`GRANT ${grant} ${s.fresh.name} TO ${role}`);
      }
      const ran = new Ledger();
      const handler = (job: { id: string }) => void ran.record(job.id, 0);
      const old = counters();
      const before = s.worker(handler, {
        databaseUrl: urlOf({ user: role, password: oldPassword }),
        metrics: old.sink,
      });
      before.on('error', () => {});

      const a = await s.queue().add('before', {}, { jobId: 'a' });
      await untilFinished(s, [a.id]);
      await admin.unsafe(`ALTER ROLE ${role} PASSWORD '${newPassword}'`); // the secret is rotated
      const b = await s.queue().add('during', {}, { jobId: 'b' });
      await untilFinished(s, [b.id]); // connections already open were not asked again

      // The rollout restarts the database side of the pool: the worker must log in again, with the old password.
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`
      );
      const c = await s.queue().add('after', {}, { jobId: 'c' });
      await until('claim_failed', () => old.get('qcloud.worker.claim_failed') > 0, 10_000);
      expect((await s.states())['completed']).toBe(2); // waiting, not lost

      const fresh = counters();
      s.worker(handler, {
        databaseUrl: urlOf({ user: role, password: newPassword }),
        metrics: fresh.sink,
      });
      await untilFinished(s, [c.id], 20_000);
      expect(fresh.get('qcloud.worker.claim_failed')).toBe(0);
      await reconcile(s, [a.id, b.id, c.id]);
    } finally {
      await s.drop();
      await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await admin.close().catch(() => {});
    }
  }, 90_000);

  test.skipIf(!PG_TOOLS)(
    'restore: a copy on a new database is looked at, migrated, switched to, and rings every claimable job again',
    async () => {
      const s = await openStack('postgres');
      const admin = new SQL({ url: testDatabaseUrl(), max: 1 });
      const copy = `qcloud_gd_${hex()}`;
      const dir = mkdtempSync(join(tmpdir(), 'qcloud-gd-'));
      const memory = new MemoryTransport();
      const timer = setInterval(() => memory.tick(), 10);
      const db = () =>
        openDatabase({ url: urlOf({ database: copy }), schema: s.fresh.name, poolSize: 3 });
      let restored: ReturnType<typeof db> | undefined;
      let worker: Worker<unknown, unknown> | undefined;
      try {
        // The restore point: two jobs done, three waiting with bells rung.
        const done = await s.queue().addBulk([1, 2].map((n) => ({ name: 'done', data: { n } })));
        const first = s.worker(() => {});
        await untilFinished(
          s,
          done.map((job) => job.id)
        );
        await first.close({ timeout: 1_000, graceMs: 0 }); // nobody takes the waiting jobs
        await s.stopTicks();
        const waiting = await s.queue().addBulk(
          [1, 2, 3].map((n) => ({
            name: 'waiting',
            data: { n },
            opts: { jobId: `waiting-${n}` },
          }))
        );
        // One schema: the bells are not state and are not in it.
        await run(
          [
            'pg_dump',
            '--format=custom',
            '--no-owner',
            `--schema=${s.fresh.name}`,
            `--file=${join(dir, 'backup')}`,
          ],
          testDatabaseUrl()
        );

        // The damage: every row of the running database is gone.
        await s.fresh.sql`DELETE FROM qcloud_jobs`;
        expect(Object.values(await s.states()).reduce((a, b) => a + b, 0)).toBe(0);

        // Restore to a new database, look before switching.
        await admin.unsafe(`CREATE DATABASE ${copy}`);
        await run(
          ['pg_restore', '--no-owner', `--dbname=${copy}`, join(dir, 'backup')],
          testDatabaseUrl()
        );
        restored = db();
        const store = new PostgresStore({
          db: restored,
          namespace: s.namespace,
          ringWindowMs: s.store.ringWindowMs,
        });
        expect(await store.deployment.schemaVersion()).toBe(LATEST_VERSION);
        expect((await migrate(restored)).applied).toEqual([]); // current: the migration job is a no-op
        const copySql = new SQL({
          url: urlOf({ database: copy }),
          max: 1,
          connection: { search_path: s.fresh.name },
        });
        try {
          const counts = await copySql<
            Array<{ state: string; n: string }>
          >`SELECT state, count(*) AS n FROM qcloud_jobs GROUP BY state ORDER BY state`;
          expect(counts.map((r) => [r.state, Number(r.n)])).toEqual([
            ['completed', 2],
            ['waiting', 3],
          ]);
        } finally {
          await copySql.close().catch(() => {});
        }

        // Switch: a worker and a tick on the copy, with a broker that holds no bells. The tick rings them again.
        const ran = new Ledger();
        worker = new Worker(QUEUE, (job: { id: string }) => void ran.record(job.id, 0), {
          transport: memory,
          closeTransport: false,
          databaseUrl: urlOf({ database: copy }),
          database: { schema: s.fresh.name, poolSize: 3 },
          namespace: s.namespace,
          heartbeatInterval: 0,
        } as never) as never;
        await Bun.sleep(300);
        expect(ran.total).toBe(0); // nothing is rung yet: bells are not state
        await until(
          'the tick to ring them',
          async () =>
            (await runTicks({ store, transport: memory }, s.loops[0]!.config)).ring.rung > 0,
          5_000
        );
        await until('the waiting jobs to run', () => ran.total === 3, 15_000);
        expect(waiting.map((job) => ran.count(job.id))).toEqual([1, 1, 1]);
      } finally {
        await worker?.close({ timeout: 1_000, graceMs: 0 }).catch(() => {});
        await restored?.close({ timeout: 1_000 }).catch(() => {});
        clearInterval(timer);
        await memory.close().catch(() => {});
        await s.drop();
        await admin.unsafe(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE)`).catch(() => {});
        await admin.close().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000
  );
});
