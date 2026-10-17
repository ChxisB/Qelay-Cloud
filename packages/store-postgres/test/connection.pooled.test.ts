import { afterEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import {
  POOLER_NOT_TRACKING_PREPARED as NO_PREP,
  createSchemaRole,
  describePooler,
  directUrlFor,
  dropRole,
  poolerUrl,
} from '../../../test/support/pooler';
import type { Database } from '../src/connection/connect';
import { openDatabase } from '../src/connection/connect';
import { PostgresStore } from '../src/postgresStore';
import { migrate, POSTGRES_EVENT_CHANNEL } from '../src/schema/migrate';
import type { FreshSchema } from './helpers';
import { freshSchema } from './helpers';
import { enqueueN } from './storeHelpers';

/**
 * `openDatabase` with `pooler: 'transaction'` in front of PgBouncer, the way a Cloud SQL managed
 * pool or RDS Proxy is reached: the schema comes from the role, nothing is sent as a startup
 * parameter, statements are unnamed, and `LISTEN` goes to a direct URL.
 */
describeDb('connection: Database through a transaction pooler', () => {
  describePooler('PgBouncer', () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => {});
    });

    /** An empty schema, a role that owns it, and a pooled `Database` that logs in as that role. */
    async function pooled(): Promise<{ fresh: FreshSchema; db: Database; role: string }> {
      const fresh = await freshSchema();
      const role = `qcloud_pd_${fresh.name.slice(-8)}`;
      await createSchemaRole(fresh.sql, role, fresh.name);
      await fresh.sql.unsafe(`GRANT CREATE ON SCHEMA ${fresh.name} TO ${role}`);
      const db = openDatabase({
        url: poolerUrl(NO_PREP, role),
        pooler: 'transaction',
        listenUrl: directUrlFor(role),
        poolSize: 4,
        applicationName: 'qcloud:test-pooled',
      });
      cleanup.push(
        () => fresh.drop(),
        () => dropRole(fresh.sql, role),
        () => db.close({ timeout: 1000 })
      );
      return { fresh, db, role };
    }

    test('options: unnamed statements and no startup parameters', async () => {
      const { db } = await pooled();
      expect(db.config.prepare).toBe(false);
      expect(db.config.startupParameters).toEqual({ application_name: 'qcloud:test-pooled' });
    });

    test('migrates an empty schema through the pooler, and a rerun changes nothing', async () => {
      const { db, fresh } = await pooled();
      expect(await migrate(db)).toMatchObject({ from: null, applied: [1] });
      expect(await migrate(db)).toMatchObject({ from: 1, applied: [] });
      const [row] = await fresh.sql`SELECT count(*)::int AS n FROM qcloud_schema_migrations`;
      expect(row!.n).toBe(1);
    });

    test('more concurrent operations than connections all complete', async () => {
      const { db } = await pooled();
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, n) => db.run('select', (sql) => sql`SELECT ${n}::int AS n`))
      );
      expect(results.map((rows) => rows[0]!.n)).toEqual(Array.from({ length: 60 }, (_, n) => n));
    });

    test('concurrent migrators through the pooler apply the migration once', async () => {
      const { db, fresh } = await pooled();
      const results = await Promise.all(Array.from({ length: 4 }, () => migrate(db)));
      expect(results.flatMap((result) => result.applied)).toEqual([1]);
      const [row] = await fresh.sql`SELECT count(*)::int AS n FROM qcloud_schema_migrations`;
      expect(row!.n).toBe(1);
    });

    test('four stores claim and complete 200 jobs through the pooler: each exactly once', async () => {
      const { db } = await pooled();
      await migrate(db);
      const stores = Array.from(
        { length: 4 },
        () => new PostgresStore({ db, namespace: 'pooled' })
      );
      const total = 200;
      await enqueueN(stores[0]!, total);
      const claims = new Map<string, number>();
      let remaining = total;
      const deadline = Date.now() + 30_000;
      await Promise.all(
        stores.map(async (store, n) => {
          while (remaining > 0 && Date.now() < deadline) {
            // A claim skips rows another claimer holds, so an empty result is not the end.
            const claimed = await store.claim('q', `worker-${n}`, 5);
            for (const job of claimed) {
              claims.set(job.id, (claims.get(job.id) ?? 0) + 1);
              if (await store.complete(job.lease, 'ok')) remaining -= 1;
            }
            if (claimed.length === 0) await Bun.sleep(10);
          }
        })
      );
      expect(remaining).toBe(0);
      expect(claims.size).toBe(total);
      expect([...claims.values()].filter((count) => count !== 1)).toEqual([]);
    }, 60_000);

    test('a listener on the direct url receives a NOTIFY sent through the pooler', async () => {
      const { db } = await pooled();
      const listener = db.openListener();
      cleanup.push(() => listener.close({ timeout: 1 }));
      const got: string[] = [];
      await listener.listen(POSTGRES_EVENT_CHANNEL, (payload: string) => got.push(payload));
      await db.run('notify', (sql) => sql.notify(POSTGRES_EVENT_CHANNEL, 'ping'));
      for (let waited = 0; waited < 2_000 && got.length === 0; waited += 50) await Bun.sleep(50);
      expect(got).toEqual(['ping']);
    });

    test('without a listenUrl there is no listener to open: it fails loudly, not silently', () => {
      const db = openDatabase({ url: poolerUrl(NO_PREP), pooler: 'transaction' });
      cleanup.push(() => db.close({ timeout: 1000 }));
      expect(() => db.openListener()).toThrow(/listenUrl/);
    });
  });
});
