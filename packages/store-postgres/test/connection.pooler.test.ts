import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { describeDb } from '../../../test/support/db';
import {
  DIRECT_URL,
  POOLER_NOT_TRACKING_PREPARED as NO_PREP,
  POOLER_TRACKING_PREPARED as PREP,
  createSchemaRole,
  describePooler,
  dropRole,
  open,
  poolerUrl,
  rejection,
} from '../../../test/support/pooler';

describeDb('connection: transaction-mode pooler', () => {
  describePooler('PgBouncer behaviour the connection options are built on', () => {
    test('prepared statements: Bun.SQL default works only if the pooler tracks them', async () => {
      const burst = async (port: number, prepare: boolean) => {
        const sql = open(poolerUrl(port), { max: 4, prepare });
        try {
          // More concurrent statements than connections: the same statement text is prepared
          // twice on one server connection unless the pooler keeps track.
          const results = await Promise.allSettled(
            Array.from({ length: 40 }, (_, n) => sql`SELECT ${n}::int AS n`)
          );
          return results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        } finally {
          await sql.close({ timeout: 2 });
        }
      };
      expect(await burst(PREP, true)).toHaveLength(0);
      const failures = await burst(NO_PREP, true);
      expect(failures.length).toBeGreaterThan(0);
      expect(String(failures[0]!.reason.message)).toMatch(/prepared statement/);
      // The documented workaround: unnamed statements, which cost the pipelining.
      expect(await burst(NO_PREP, false)).toHaveLength(0);
    });

    test('startup parameters: search_path and application_name pass, the session timeouts do not', async () => {
      const startup = async (parameter: string, value: string | number) => {
        const sql = open(poolerUrl(NO_PREP), { connection: { [parameter]: value } as never });
        try {
          return await rejection(async () => await sql`SELECT 1`);
        } finally {
          await sql.close({ timeout: 2 });
        }
      };
      expect(await startup('search_path', 'public')).toBeNull();
      expect(await startup('application_name', 'qcloud:probe')).toBeNull();
      for (const parameter of [
        'statement_timeout',
        'lock_timeout',
        'idle_in_transaction_session_timeout',
      ]) {
        expect(await startup(parameter, 5000)).toMatch(/unsupported startup parameter/);
      }
    });

    test('search_path as a startup parameter is accepted but not applied reliably: use the role', async () => {
      // One client at a time, each asking for a different schema. A tracked parameter would be
      // applied every time; here the server connection keeps whatever it last got.
      const wanted = [
        'qcloud_sp_a',
        'qcloud_sp_b',
        'qcloud_sp_a',
        'qcloud_sp_a',
        'qcloud_sp_b',
        'qcloud_sp_a',
      ];
      const seen: string[] = [];
      for (const schema of wanted) {
        const sql = open(poolerUrl(NO_PREP), { connection: { search_path: schema } });
        try {
          const [row] = await sql`SELECT current_setting('search_path') AS v`;
          seen.push(String(row!.v));
        } finally {
          await sql.close({ timeout: 2 });
        }
      }
      expect(seen).not.toEqual(wanted);
      // The same schemas through a role-level setting are exact, because they are set when the
      // server connection is opened and the pooler keeps one pool per role.
      const admin = open(DIRECT_URL);
      try {
        await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS qcloud_sp_a`);
        await createSchemaRole(admin, 'qcloud_sp', 'qcloud_sp_a');
        const sql = open(poolerUrl(NO_PREP, 'qcloud_sp'));
        try {
          for (let n = 0; n < 3; n++) {
            const [row] = await sql`SELECT current_setting('search_path') AS v`;
            expect(row!.v).toBe('qcloud_sp_a');
          }
        } finally {
          await sql.close({ timeout: 2 });
          await dropRole(admin, 'qcloud_sp');
        }
      } finally {
        await admin.unsafe(`DROP SCHEMA IF EXISTS qcloud_sp_a CASCADE`);
        await admin.close({ timeout: 2 });
      }
    });

    test('session defaults: a role-level setting reaches every pooled connection, SET LOCAL does not leak', async () => {
      const admin = open(DIRECT_URL);
      try {
        await admin.unsafe(`DROP ROLE IF EXISTS qcloud_pool`);
        await admin.unsafe(`CREATE ROLE qcloud_pool LOGIN PASSWORD 'qcloud_pool'`);
        await admin.unsafe(`ALTER ROLE qcloud_pool SET statement_timeout = '7s'`);
        const clients = [0, 1, 2].map(() => open(poolerUrl(NO_PREP, 'qcloud_pool')));
        try {
          const seen = await Promise.all(
            clients.map(
              async (sql) => (await sql`SELECT current_setting('statement_timeout') AS v`)[0]!.v
            )
          );
          expect(seen).toEqual(['7s', '7s', '7s']);
          const [a, b] = clients as [SQL, SQL, SQL];
          // SET LOCAL ends with the transaction, so the next client of that server connection is clean.
          await a.begin(async (tx) => {
            await tx`SET LOCAL statement_timeout = '1234ms'`;
            expect((await tx`SELECT current_setting('statement_timeout') AS v`)[0]!.v).toBe(
              '1234ms'
            );
          });
          expect((await b`SELECT current_setting('statement_timeout') AS v`)[0]!.v).toBe('7s');
        } finally {
          await Promise.all(clients.map((sql) => sql.close({ timeout: 2 })));
        }
      } finally {
        await admin.unsafe(`DROP ROLE IF EXISTS qcloud_pool`).catch(() => {});
        await admin.close({ timeout: 2 });
      }
    });

    test('session SET leaks to the next client of the same server connection', async () => {
      const a = open(poolerUrl(NO_PREP));
      const b = open(poolerUrl(NO_PREP));
      try {
        // Which server connection serves a client is the pooler's choice; retry until both land on one.
        let leaked: string | null = null;
        for (let attempt = 0; attempt < 10 && leaked === null; attempt++) {
          const [pidA] =
            await a`SELECT pg_backend_pid() AS pid, set_config('work_mem', ${`${5000 + attempt}kB`}, false)`;
          const [row] = await b`SELECT pg_backend_pid() AS pid, current_setting('work_mem') AS v`;
          if (row!.pid === pidA!.pid) leaked = String(row!.v);
          await b`RESET work_mem`;
        }
        expect(leaked).toMatch(/^50\d\dkB$/);
      } finally {
        await a.close({ timeout: 2 });
        await b.close({ timeout: 2 });
      }
    });

    test('advisory locks: transaction-level excludes across clients, session-level admits two holders', async () => {
      const key = 7_005_001;
      const attempt = async (url: string) => {
        const a = open(url);
        const b = open(url);
        try {
          const [first] =
            await a`SELECT pg_try_advisory_lock(${key}) AS ok, pg_backend_pid() AS pid`;
          const [second] =
            await b`SELECT pg_try_advisory_lock(${key}) AS ok, pg_backend_pid() AS pid`;
          return { first: first!.ok, second: second!.ok, samePid: first!.pid === second!.pid };
        } finally {
          // Release on whichever server connection holds it, then close.
          await a`SELECT pg_advisory_unlock_all()`.catch(() => {});
          await b`SELECT pg_advisory_unlock_all()`.catch(() => {});
          await a.close({ timeout: 2 });
          await b.close({ timeout: 2 });
        }
      };
      // Direct: the second session is refused, as a leader election needs.
      expect(await attempt(DIRECT_URL)).toMatchObject({ first: true, second: false });
      // Pooled: both clients are served by one server connection, and a session lock is
      // re-entrant within a session. Two "leaders".
      let split = false;
      for (let tries = 0; tries < 10 && !split; tries++) {
        const result = await attempt(poolerUrl(NO_PREP));
        split = result.samePid && result.first && result.second;
      }
      expect(split).toBe(true);

      // The transaction-level lock the ported store uses holds, because the server connection
      // stays with the client until commit.
      const a = open(poolerUrl(NO_PREP));
      const b = open(poolerUrl(NO_PREP));
      try {
        let secondGot = null as boolean | null;
        await a.begin(async (tx) => {
          const [mine] = await tx`SELECT pg_try_advisory_xact_lock(${key}) AS ok`;
          expect(mine!.ok).toBe(true);
          secondGot = await b.begin(
            async (other) => (await other`SELECT pg_try_advisory_xact_lock(${key}) AS ok`)[0]!.ok
          );
        });
        expect(secondGot).toBe(false);
      } finally {
        await a.close({ timeout: 2 });
        await b.close({ timeout: 2 });
      }
    });

    test('LISTEN through the pooler receives nothing, silently; NOTIFY through it is fine', async () => {
      const trial = async (listenUrl: string, notifyUrl: string) => {
        const listener = open(listenUrl);
        const sender = open(notifyUrl);
        const got: string[] = [];
        try {
          await listener.listen('qcloud_pooler_ch', (payload: string) => got.push(payload));
          await sender.notify('qcloud_pooler_ch', 'ping');
          for (let waited = 0; waited < 2_000 && got.length === 0; waited += 50)
            await Bun.sleep(50);
          return got;
        } finally {
          await listener.close({ timeout: 2 });
          await sender.close({ timeout: 2 });
        }
      };
      expect(await trial(DIRECT_URL, DIRECT_URL)).toEqual(['ping']);
      expect(await trial(DIRECT_URL, poolerUrl(NO_PREP))).toEqual(['ping']);
      // Subscribing "succeeds": nothing tells the caller that no event will ever arrive.
      expect(await trial(poolerUrl(NO_PREP), DIRECT_URL)).toEqual([]);
    });
  });
});
