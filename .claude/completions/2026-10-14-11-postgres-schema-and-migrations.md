# Task 11: Postgres schema and migrations (2026-10-14)

**Done locally, on PostgreSQL 18, not on the Docker PG 16 of CI.** `packages/store-postgres` now has one clean
version-1 schema (event journal kept), a forward-only migration runner with a checksum and object check, a connection
factory (`openDatabase`) with a per-operation deadline, TLS and pooler rules and a connection budget, and the clock seam.
The user told me to defer Docker-backed runs until every task is done, which departs from CLAUDE.md's "run the gate with
`QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/store-postgres/src/`: `time.ts`, `errors.ts`, `index.ts`, `connection/{budget,resilient,target,options,connect}.ts`,
  `schema/ddl/{jobs,auxiliary,events,eventFunctions}.ts`, `schema/{migrations,migrate}.ts`.
- `packages/store-postgres/scripts/` and repo `scripts/`: `connection-budget.ts`, `port.ts`.
- `packages/store-postgres/test/`: `connection.{budget,target,options,driver,fault,socket,tls,pooler,pooled}.test.ts`,
  `schema.{migrate,snapshot,indexes}.test.ts`, `schema.snapshot.txt`, `time.test.ts`, `helpers.ts`, `fault.ts`, `migrator.ts`.
- `test/support/`: `db.ts`, `clock.ts`, `pooler.ts`, `tcpProxy.ts`, `schemaSnapshot.ts`.
- Deleted: `spike/db-access/{failure,tls,pooling}.test.ts` (promoted into `test/connection.*`).
- Docs: `docs/PORTING.md`, `docs/spikes/01`, `05` and `06`, `CLAUDE.md` (forward-only migration rule, connection suites
  paragraph), the task file and `CURRENT.md`.

**Decisions** (details in the task's Result)

- The clock seam: one `StoreTime.now` per operation, passed as a bound parameter; the database clock is the default.
- `qcloud_jobs_ring_idx` has `rung_at` nulls last, queried as two bounded branches. `rung_at` updates are not HOT.
- Dropped: the GIN index on `qcloud_workers.queues` and two prune-watermark indexes. Dropped upstream drift and repair code.
- `nextval('qcloud_group_order_seq')` stays in version 1; task 12 decides on `group_sequence`.

**Checked** (PostgreSQL 18.6, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (186 files).
- `bun test packages/store-postgres --grep schema`: 53 pass, 0 fail.
- `bun test packages/store-postgres/test`: 101 pass, 21 skip, 0 fail.
- `bun test`: 161 pass, 72 skip, 1 fail (the `fleet` cap spike on macOS, below).
- The TLS suite passed 6 of 6 once against a throwaway PG 18 with TLS; that instance is gone and it was not re-run.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1`. The DDL snapshot was generated on PG 18 and may differ in text on PG 16.
- PgBouncer: `connection.pooler` (7) and `connection.pooled` (6) skipped. `connection.pooled` has never executed.
- Pub/Sub emulator, ElasticMQ and `bun run test:model` (no core queue semantics changed).
- `spike/db-access/fleet.test.ts` "at the cap, direct" fails on this Mac: 400 simultaneous loopback connects overflow
  `kern.ipc.somaxconn` (128) and some are refused before Postgres can answer `53300`. A spike suite; CI runs none of them.
- The model harness cannot drive time through Postgres yet: there is no Postgres `StateStore` until tasks 12-14.
- The DDL snapshot is not committed (the repository has no commits) and is awaiting the user's review.
- Nothing run against a real cloud resource; nothing committed, pushed or published.

**Next:** task 12 (store: enqueue, admission, dedup).
