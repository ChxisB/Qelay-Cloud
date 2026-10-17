# Task 16: transport-local (2026-10-14)

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** `packages/transport-local` now has the Postgres `LISTEN/NOTIFY` transport
next to the memory transport and contract suite v1 built earlier in the task: `ring` is one `pg_notify` batch, `subscribe` runs a
`LISTEN` connection with a heartbeat plus a per-queue poll loop, and `stats` come from the store. A regression run also found and fixed a
race in task 11's migrator. The user told me to defer Docker-backed runs until every task is done, which departs from CLAUDE.md's "run
the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/transport-local/src/`: `postgres.ts`, `listener.ts`, `poller.ts`, `wire.ts`, `types.ts`, `index.ts` (new); `memory.ts`
  from the earlier part of the task.
- `packages/transport-local/test/`: `wire`, `poller`, `postgres`, `postgres.wake`, `postgres.fault` and `support.ts`.
- `test/contract/`: `transport.ts` (an optional `backlog(queue, n)` hook for the stats case), `postgres.test.ts`, `memory.test.ts`.
- `packages/store-postgres/src/schema/migrate.ts` (the fix) and `test/schema.migrate.race.test.ts` (new).
- `tsconfig.tooling.json` (includes the transport tests).
- Docs: `docs/spikes/06-phase0-gate.md` (new section "The local transport: NOTIFY, a poll loop and a heartbeat (task 16)", items a to h,
  and a dated amendment), `22-phase1-gate.md` (local transport numbers come from task 16), the task 16 and task 11 files, `CURRENT.md`.
  No `docs/PORTING.md` rows: nothing was ported.
- Removed: `.claude/completions/2026-10-14-16-transport-local-partial.md`, replaced by this file.

**Decisions** (details in the task's Result and the gate document)

- A delayed bell is announced by `NOTIFY` with its delay and held at each listener in an in-memory buffer; it is never delivered early.
  This refines the gate's "a delayed job is not announced by `NOTIFY`". Delay, nack and visibility precision is the poll interval.
- The poll loop is the recovery guarantee: 1,000 ms, jitter plus or minus 20 %, backoff up to 8 times on probe errors. It probes
  `hasClaimable` only with capacity and an idle buffer, and rings a bell with no job id. A bell buffer past 1,000 per queue drops
  bells, since the poll finds the jobs.
- Bun's `SQL.listen` reconnects a killed backend silently and loses what was sent in the gap, so the transport heartbeats itself and
  replaces an unheard connection (`listenerReconnects`, the metric to export), then runs a catch-up poll.
- The probe is the claim's own ordered `LIMIT 1` select; a bare `EXISTS` read a sequential scan.
- `stats`: depth is claimable jobs (not bells), `source: 'postgres-counts'`, `maxStalenessMs: 0`.
- No `listenUrl` behind a pooler, or an unreachable database at start: poll-only mode, with `pollOnlyReason`.

**Bugs the tests found (fixed)**

- **A race in task 11's migrator** (found by the broad run: `schema.migrate.test.ts` "four processes" failed; ten in parallel failed 36
  of 40 with `SchemaVersionError: "qcloud_jobs" exists but there is no migration record`). After waiting on `pg_advisory_xact_lock`,
  `readRecorded` and `refuseForeignTables` used `to_regclass`, which a backend that waited on the lock answers from a stale catalog
  name cache. A failing test came first (`schema.migrate.race.test.ts`, 3 of 3 failing with the production error); the fix reads
  `pg_class` (`relationExists`). Now 3 of 3 pass and the ten-way stress is 40 of 40. Binding for later catalog reads after a lock: gate
  item (h).
- The bare `EXISTS` probe's sequential scan (above), found by reading the plan on a three-queue table.
- A planted bug, the poll probing while a bell was buffered, was not caught by any end-to-end test; "the poll stays quiet while a bell
  is being handled" was added.
- Smaller ones, each corrected in the code or test: a test file over the 300-line cap (split into `postgres.wake` and `postgres`),
  a proxy port read after the proxy was refused, and database env vars lost between shell calls (a run that skipped every DB suite).

**Checked** (PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (321 files).
- `bun test packages/store-postgres/test test/contract packages/transport-local packages/core` with `QCLOUD_REQUIRE_DB=1`: 1,158 pass,
  21 skip, 0 fail, 81 files. `bun test test/contract`: 29 pass. The transport-local suites: 44 pass, three runs in a row.
- `bun run test:model` with `QCLOUD_REQUIRE_DB=1`: 9 pass (no queue semantics changed, so no deep run).
- Four planted transport bugs (no buffer cap, delay ignored, poll ignoring capacity, poll ignoring the buffer); sources restored and diffed.
- Listener faults: `pg_terminate_backend` of the `LISTEN` backend and a blackholing TCP proxy, both recovered.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, **PgBouncer** (poll-only is tested with a throwing `openListener`, not through a real
  pooler), TLS, the Pub/Sub emulator and ElasticMQ. The `hasClaimable` plans and the migrator stress are PG 18.6 only.
- `NOTIFY` fan-out cost (listeners times bells) is unmeasured: task 22's load check should include listeners.
- Delay precision at the default 1 s poll is by construction, not measured under load.
- `bun run test:contract` is still the task-41 placeholder.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 17 (transport-gcp: Pub/Sub); any step that creates or calls a real project needs the user's go-ahead (D9).
