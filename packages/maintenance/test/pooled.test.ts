import { afterEach, expect, test } from 'bun:test';
import { openDatabase, PostgresStore, migrate } from '@qelay-cloud/store-postgres';
import { describeDb } from '../../../test/support/db';
import {
  POOLER_NOT_TRACKING_PREPARED as NO_PREP,
  createSchemaRole,
  describePooler,
  directUrlFor,
  dropRole,
  poolerUrl,
} from '../../../test/support/pooler';
import { freshSchema } from '../../store-postgres/test/helpers';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import { TickLoop } from '../src/loop';
import { RecordingTransport, recordedTelemetry } from './support';

/**
 * The in-process tick behind a transaction pooler, as a worker on Cloud SQL's managed pool or
 * RDS Proxy runs it. This is why the lease is a row and not an advisory lock: a session lock
 * belongs to a server connection the next statement may not get, so two holders could both
 * believe they led. The lease is one statement against the database clock, which a pooler
 * cannot split.
 */
describeDb('the tick through a transaction pooler', () => {
  describePooler('PgBouncer', () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
    });

    test('one holder leads, the others follow, a release hands it over, and a pass rings a due job', async () => {
      const fresh = await freshSchema();
      const role = `qcloud_pt_${fresh.name.slice(-8)}`;
      await createSchemaRole(fresh.sql, role, fresh.name);
      await fresh.sql.unsafe(`GRANT CREATE ON SCHEMA ${fresh.name} TO ${role}`);
      cleanup.push(
        () => fresh.drop(),
        () => dropRole(fresh.sql, role)
      );
      // Each loop has a pooled connection of its own, as separate processes would.
      const open = (holder: string) => {
        const db = openDatabase({
          url: poolerUrl(NO_PREP, role),
          pooler: 'transaction',
          listenUrl: directUrlFor(role),
          poolSize: 2,
          applicationName: `qcloud:test-tick-${holder}`,
        });
        cleanup.push(() => db.close({ timeout: 1000 }));
        return db;
      };
      const dbs = { a: open('a'), b: open('b'), c: open('c') };
      await migrate(dbs.a);
      const transport = new RecordingTransport();
      cleanup.push(() => transport.close());
      const telemetry = recordedTelemetry();
      const store = (holder: keyof typeof dbs) =>
        new PostgresStore({ db: dbs[holder], namespace: 'pooled', ringWindowMs: 0 });
      const loop = (holder: keyof typeof dbs) =>
        new TickLoop(
          { store: store(holder), transport, telemetry },
          { holder, intervalMs: 1_000, leaseMs: 3_000, ringGraceMs: 0 }
        );
      const loops = { a: loop('a'), b: loop('b'), c: loop('c') };
      const [id] = await enqueueN(store('a'), 1);

      // Three holders beat at once: exactly one takes the lease.
      await Promise.all(Object.values(loops).map((each) => each.beat()));
      const leaders = Object.entries(loops).filter(([, each]) => each.leading);
      expect(leaders).toHaveLength(1);
      expect(Object.values(loops).reduce((sum, each) => sum + each.stats.led, 0)).toBe(1);
      const leader = leaders[0]![0] as keyof typeof loops;

      // Beats keep coming from everyone; the lease stays with the same holder.
      for (let round = 0; round < 3; round += 1) {
        await Promise.all(Object.values(loops).map((each) => each.beat()));
      }
      expect(Object.entries(loops).filter(([, each]) => each.leading)).toEqual([
        [leader, loops[leader]],
      ]);

      // The pass the leader ran rang the due job, once, and recorded it.
      expect(transport.attempts.filter((attempt) => attempt.jobId === id)).toHaveLength(1);
      const [row] = await fresh.sql`
        SELECT rung_at FROM qcloud_jobs WHERE id = ${id!}`;
      expect(row!.rung_at).not.toBeNull();

      // A graceful stop gives the lease up; a follower takes it on its next beat.
      await loops[leader].stop();
      const others = Object.entries(loops).filter(([holder]) => holder !== leader);
      await Promise.all(others.map(([, each]) => each.beat()));
      expect(others.filter(([, each]) => each.leading)).toHaveLength(1);
      expect(telemetry.errors).toEqual([]);
    }, 60_000);
  });
});
