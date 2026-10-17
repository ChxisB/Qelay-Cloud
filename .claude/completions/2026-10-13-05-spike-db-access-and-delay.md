# Task 05: spike, database access and delay precision (2026-10-13)

**Done locally.** The connection formula, the pooling rules, the driver's failure behaviour and the delay and tick
options are measured on Postgres 16, PgBouncer 1.26 and a TLS Postgres. **The real-instance steps (3 and 4 on Cloud SQL
and RDS) were not run** (D9). Nothing was created in any cloud account.

**Docs:**

- the write-up: `docs/spikes/05-db-access-and-delay.md`;
- the full Result: `.claude/.planning/v1.0.0/05-spike-db-access-and-delay.md`;
- task 06's inputs: a "From task 05" block.

**Code:** `packages/store-postgres/spike/db-access/`, 6 test files with 37 tests, plus `budget.ts`, `pooler.ts`,
`tcpProxy.ts`, `resilient.ts`, `tick.ts`, `fleetWorker.ts`, `fleetStats.ts` and the PgBouncer configs.

**Other changes:**

- `docker-compose.test.yml`: opt-in `pgbouncer` (ports 56432 and 56433) and `tls` (port 55433) profiles. The main
  Postgres runs with `max_connections=200`;
- `.gitignore`: `db-access/.tls/`;
- `CLAUDE.md` says how to start them and what `QCLOUD_REQUIRE_PGBOUNCER=1` and `QCLOUD_REQUIRE_TLS=1` do.

**Findings:**

1. **Connections scale with processes, not jobs.** Default pool 2. 10, 50 and 200 worker processes need 32, 112 and 412
   direct connections, or 26 behind a pooler. Measured peaks equal the formula. At the cap, direct is a hard `53300`
   failure and a pooler queues.
2. **A transaction pooler works with `prepare: false`, no timeout startup parameters, and the schema and timeouts on the
   role.** `search_path` as a startup parameter is not applied reliably. Session advisory locks give two holders and
   `LISTEN` receives nothing, silently. The ported code uses neither.
3. **`Bun.SQL` hangs for good on a silent connection.** `cancel()` and `statement_timeout` do not help. A deadline wrapper,
   `maxLifetime` and `close({ timeout })` bound it.
4. **No Cloud Tasks relay in v1.0.0.** An opt-in in-process tick with a lease-row leader gives second-level delay,
   retry backoff and rate limits on always-on workers, never early. Cloud Scheduler stays at 1 minute.
5. **Documented, not run:** Cloud SQL managed pooling is Enterprise Plus only, and RDS Proxy pins on `nextval`, which
   grouped-job admission calls.

**Verified:**

- the gate with Postgres, ElasticMQ, the Pub/Sub emulator, PgBouncer and TLS all required: 88 tests across 18 files, 248 s;
- the Verify command, `typecheck` and `bun test packages/store-postgres/spike` with the same services: 79 tests across 16 files, 180 s;
- `failure.test.ts` 3 times in a row: 9 of 9 each time.

**Not done or not verified:**

- no real cloud: Cloud SQL, RDS, IAM auth, HA failover, managed pooling, RDS Proxy pinning, the Cloud SQL certificate
  check, a fleet on a real instance, Cloud Tasks precision and cost;
- a Postgres restart is one probe, not a committed test;
- latencies are loopback;
- CI runs none of the new suites;
- nothing committed.

**Open for task 06:** D1 (worker hosting) decides whether the in-process tick exists; whether Phase 1 needs a real
Cloud SQL run first; spike disposal (`budget.ts`, `resilient.ts` and the lease row are candidates to promote).

**Next:** task 06 (Phase 0 gate). It ends with the user's explicit go-ahead, so work stops there until the user gives it.
