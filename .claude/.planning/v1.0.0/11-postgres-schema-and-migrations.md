# 11 — Postgres schema and migrations

**Status:** done · **Depends on:** 10 · **Phase:** 1

## Goal

Create the `qcloud_*` schema and a safe migration runner in `store-postgres`, derived from Qelay's Postgres schema version 21 with the broker concepts removed.

## Scope

In: schema, indexes, the migration runner, connection factory, and schema tests.
Out: query code (tasks 12-15).

## Reference

`../qelay/src/infrastructure/persistence/postgres/schema.ts` (and `groupSchema.ts`, `eventJournalSchema.ts`,
`eventRetentionSchema.ts`, `schemaInitialization.ts`, `legacySchemaGuard.ts`), plus the verdicts from task 01.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md),
[spike 01](../../../docs/spikes/01-postgres-port.md), [spike 05](../../../docs/spikes/05-db-access-and-delay.md).

- **Event journal: keep** the commit and retention tables. The cloud model has more concurrent writers, and the lock
  serialises event-writing commits per namespace. Task 13's 5,000-job run measures the cost; step 4's "decide" is closed.
- **`sessionLimits` is kept.** It validates timeout values. Only the broker-session parts go.
- **`rung_at` means "a doorbell is deliverable at this time"**: now, or `run_at` for a delayed bell. It is set only for
  bells the broker took, and cleared whenever a job returns to claimable (retry, recovery, resume, promotion).
- **Clock seam (condition 1 of the go).** The store takes an injected `Clock`, defaulting to the database clock.
  Decide the mechanism (for example a bound parameter obtained from the `Clock`, with the default resolving to the
  database's own time) and record it. The requirement: the default never reads a worker's clock, and the model
  harness can drive time. Tasks 13 and 14 cannot be done without it.
- **Connection factory** (step 7) carries the whole contract of DESIGN.md section 7, not just a pool: a per-operation
  deadline wrapper (`ResilientPool` in the spike, throwing `OperationDeadlineError`), `maxLifetime`, `idleTimeout`,
  `close({ timeout })`; pool default **2**; budget validation from `direct = sum(count x (pool + listen)) + 6`; TLS
  with `tls: { ca }` (the driver's default is plaintext); `prepare: false` behind a transaction pooler; no
  `statement_timeout`, `lock_timeout` or idle-in-transaction startup parameters behind a pooler, with schema and
  timeouts set on the role (`ALTER ROLE ... SET`); a direct `listenUrl`; `password` as a function for IAM tokens;
  `/cloudsql` through `path`. The libpq `?host=/dir` form is read silently as TCP: detect it and fail loudly.
- **Pooler-safe locking only.** The migration runner and everything it shares code with use `pg_advisory_xact_lock*`,
  never session-level advisory locks.
- **`nextval('qcloud_group_order_seq')`** is in the ported code and RDS Proxy documents `nextval` as pinning a
  connection. Keep the sequence in the first schema version. Task 12 (which owns grouped admission) decides whether it moves to a
  `group_sequence` table, and if it does that is a new migration.
- **Spike code that lands here:** `spike/db-access/budget.ts`, `resilient.ts`, the pooler recipe and `tcpProxy.ts`
  (to `test/support/`); `spike/tools/port.ts` moves to `scripts/`. The `spike/db-access/*.test.ts` suites are kept as a
  compatibility suite if CI can run the `pgbouncer` and `tls` compose profiles, otherwise deleted. Record the choice
  and update `docs/PORTING.md`.

## Steps

1. **Rename** every table to `qcloud_*` (rules in `CURRENT.md`). Use `qcloud_schema_migrations` for versioning, starting at version 1.
2. **Remove broker concepts:** the `qelay_brokers` table, `lease_broker_id`, `lease_broker_session_id`, and `broker_id` / `broker_session_id` on workers, and their indexes.
3. **Add** to `qcloud_jobs`: `rung_at BIGINT` (the time a doorbell is deliverable, see Gate decisions; null = needs ringing), plus a partial index for the tick:
   claimable jobs where `rung_at IS NULL OR rung_at < $threshold` (the threshold is `now - reRingAfterMs`, and the query is capped per queue), and one for delayed jobs by `run_at`.
4. **Keep** (subject to task 01 verdicts): `qcloud_jobs` with its indexes (ready, state, lease, parent, group, lifo, ttl, live unique key), dependencies, flow failures,
   repeat links, job logs, crons, workers, metric buckets and totals, completions, queue state, group state, events.
   The event-journal commit and retention tables stay (decided at the gate, see above).
5. **Payload encoding:** keep msgpackr `BYTEA` for payload, result and DLQ blobs (parity and fidelity with Qelay). Revisit JSONB only if the inspector's needs demand it, and record the decision.
6. **Migration runner:** ordered, transactional migrations; a transaction-scoped advisory lock (`pg_advisory_xact_lock`, which survives a transaction pooler) so concurrent starters do not race; refuses to run against a database whose version is newer than the code; idempotent re-run.
7. **Connection factory** using `Bun.SQL`, as specified under Gate decisions: URL or discrete options, TLS, the deadline wrapper, lifetimes, `close({ timeout })`, the budget validation from task 05, pooler mode, `listenUrl`, and the clock seam. Behaviour is covered by tests against the TCP fault proxy (silent stall, reset, refusal), PgBouncer and the TLS Postgres where CI can run them.
8. **Schema tests** against the test Postgres: empty → latest; re-run is a no-op; four concurrent migrators leave one consistent schema; newer-version refusal; a snapshot of the final DDL so unplanned changes show in review.

## Acceptance

- A fresh database migrates to the latest version; a second run changes nothing.
- No `broker` identifier remains in the schema.
- Concurrent migration test passes with 4 processes.
- Every query path planned for tasks 12-15 has a supporting index (list them in the task Result with the planned query).
- The DDL snapshot is committed and reviewed.
- A query on a connection that stops answering fails with `OperationDeadlineError` within its deadline, and the pool is usable afterwards (fault-proxy test).
- A fleet that exceeds the supplied `max_connections` is refused at configuration time, with the budget in the message.
- The store can be built with a fake `Clock`, and the model harness can drive time through it.

## Verify

```bash
docker compose -f docker-compose.test.yml up -d --wait
bun run typecheck && bun run lint && bun run architecture
bun test packages/store-postgres --grep schema
```

## Risks / notes

- Index choices came from Qelay's query shapes. Re-check them with `EXPLAIN` on realistic row counts (task 22 does a load check); do not add speculative indexes.
- Write amplification: every index costs on each state transition. Keep the partial indexes partial.
- Migrations must be forward-only and safe to run while old workers are still connected (add-column-with-default style). State that rule in `CLAUDE.md`.

## Result

Done locally on 2026-10-14, **verified against a throwaway PostgreSQL 18.6, not the Docker PG 16 of CI**, on the user's
instruction ("you don't need to test in docker until all tasks are done"). That deviates from CLAUDE.md's "run the gate
with `QCLOUD_REQUIRE_DB=1`" rule; the full Docker-backed run is the last step of the whole plan. See "Not run" below.

### What was built (`packages/store-postgres/`)

| Area | Files |
|------|-------|
| Schema | `src/schema/ddl/{jobs,auxiliary,events,eventFunctions}.ts` (one clean version-1 DDL, 477 lines), `src/schema/migrations.ts` (registry, checksum, expected objects), `src/schema/migrate.ts` (runner) |
| Connection | `src/connection/{budget,resilient,target,options,connect}.ts`: `openDatabase(options): Database` |
| Time seam | `src/time.ts` |
| Errors | `src/errors.ts`: `SchemaVersionError`, `SchemaDriftError`, `MigrationError`, `ConnectionConfigError`, `ConnectionBudgetError` |
| Tooling | `scripts/connection-budget.ts`, `scripts/port.ts` (moved from `spike/tools/`) |
| Test support | `test/support/{pooler,tcpProxy,schemaSnapshot,clock}.ts`, `packages/store-postgres/test/{helpers,fault,migrator}.ts` |

Tests (`packages/store-postgres/test/`): `connection.{budget,target,options}` (units), `connection.driver` (raw `Bun.SQL`
under faults, 7), `connection.fault` (`openDatabase` under faults, 8), `connection.socket` (3), `connection.tls` (6),
`connection.pooler` (7) and `connection.pooled` (6), `schema.migrate` (18), `schema.snapshot` (3, plus
`schema.snapshot.txt`, 337 lines), `schema.indexes` (29), `time` (5).

### Acceptance

| Item | Status |
|------|--------|
| Fresh database migrates to latest, second run changes nothing | True (`schema.migrate`). |
| No `broker` identifier in the schema | True: a test scans every relation, function and trigger name for `broker` and `qelay_`. |
| Concurrent migration with 4 processes | True: 4 spawned `bun` processes, one applies, three find it applied. Also 4 concurrent calls through PgBouncer in `connection.pooled` (**not run**, see below). |
| Every query path planned for tasks 12-15 has an index | True: 28 planned queries, each checked with `EXPLAIN` (sequential scans disabled, and sort disabled for ordered queries) on 8,000 seeded jobs. A final test fails if any index is not used by a planned query. Table below. |
| DDL snapshot committed and reviewed | The snapshot exists (`test/schema.snapshot.txt`); **nothing is committed** (the repository has no commits, by rule) and **review is the user's**. A missing snapshot fails; it is regenerated only with `QCLOUD_UPDATE_SNAPSHOT=1`. |
| Silent connection ends in `OperationDeadlineError` within the deadline, pool usable afterwards | True (`connection.fault`, fault proxy): fails at 650-1300 ms for a 700 ms deadline, retires the pool once for 8 concurrent calls, the next call works. |
| Fleet over `max_connections` refused at configuration time, budget in the message | True (`connection.options`, `connection.budget`). Direct 10/50/200 workers cost 32/112/412, pooled 26. |
| Store buildable with a fake `Clock`, harness can drive time through it | The seam is built and tested (`time.test.ts`: an injected `ManualClock` is returned with no query; the default reads the DB clock). The **model harness has not yet driven time through Postgres**, because no Postgres `StateStore` exists until task 12; tasks 13 and 14 do that. |

### Decisions

1. **Clock seam.** An operation asks `StoreTime.now(sql)` once and passes the number to every statement as a bound
   parameter; no SQL text computes time. An injected `Clock` is returned with no query. The default reads the database
   clock (`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`). A worker's clock is never consulted, so
   skew between workers cannot move a lease deadline. Tested with a clock an hour behind.
2. **Migrations.** `qcloud_schema_migrations(version, applied_at, checksum)` is created by the runner.
   - *Current database:* one read, no lock: recorded versions and checksums are checked, then every object the
     migrations create (derived from their `CREATE`/`DROP` statements) is verified to exist.
   - *Pending:* one transaction, `pg_advisory_xact_lock(hashtextextended('qcloud:migrate:' || current_schema(), 0))`, re-read
     under the lock, refuse foreign `qcloud_*` tables that have no record, apply statement by statement, record each
     version with a DB-clock `applied_at`.
   - *Errors:* newer database -> `SchemaVersionError`; edited checksum, unknown recorded version or a missing object ->
     `SchemaDriftError`; a statement failure -> `MigrationError` (rolled back, with `cause`).
   - *Deadline:* an `OperationDeadlineError` from a migration means "outcome unknown": the retired pool finishes its
     transaction once the lock frees, so a retry may find the migration already applied. The test accepts both.
3. **Dropped drift code.** `schemaInitialization.ts`, `groupSchemaFingerprint.ts`, `legacySchemaGuard.ts` and upstream's
   repair and backfill paths are not ported (rows in `docs/PORTING.md`). Version 1 has no older shape to repair; the
   checksum plus the object check replace them. This also means upstream's 21 versions are folded into one: there
   are no `ALTER`s in the DDL.
4. **Ring index `qcloud_jobs_ring_idx`** is `(namespace, queue, rung_at, id) WHERE state IN ('waiting','prioritized','delayed')`,
   nulls last. The tick runs two bounded branches, each `ORDER BY rung_at, id LIMIT n`: `rung_at IS NULL`, and
   `rung_at < threshold`. Both are index-only scans of about 0.03 ms on 300,000 rows.
   - *Why not `NULLS FIRST`:* the `IS NULL` branch fell back to a sequential scan and sort (about 25 ms) unless the query
     spelled `ORDER BY rung_at NULLS FIRST`, which is a trap for the next author.
   - *Why not one `OR`:* it scans the whole range.
   - **For task 22:** `rung_at` is indexed, so `markRung` updates are **not HOT** (a write-amplification cost on every
     bell). The load check must measure it against the per-queue cap.
5. **Dropped indexes** (the "do not add speculative indexes" note):
   - the GIN index on `qcloud_workers.queues`: the only query is `queue = ANY(queues) AND last_seen > ...` scoped by
     namespace, which GIN cannot serve, and the primary key narrows to the fleet size;
   - `qcloud_event_prune_watermarks_namespace_queue_idx` and `..._transaction_idx`: every lookup is by `(namespace, queue)`,
     a prefix of the primary key, or carries `commit_seq IS NULL` (the partial `pending_commit_idx`); the table holds about
     one row per queue. **Task 15** ports the journal code and may add one back with a migration if a query needs it.
6. **Event journal** (commit and retention tables, statement-level and deferred constraint triggers, per-namespace
   advisory lock) kept verbatim from upstream by the gate decision; the trigger bodies are copied unchanged. **`nextval('qcloud_group_order_seq')` stays in version 1**;
   `qcloud_queue_state.group_sequence` exists and is unused; task 12 decides. Payloads stay msgpackr `BYTEA`.
7. **TLS.** `tls` is typed: `{ ca }` verifies, `'unverified'` encrypts without checking, `false` is plaintext said aloud. Omitted
   is allowed only for a loopback host or a unix socket. URL parameters (`ssl*`, `host`, and anything else) are
   rejected, because `Bun.SQL` 1.4.2 reads `sslmode=require` as encrypt-without-verify and `?host=/dir` as TCP.
8. **Pooler mode.** `pooler: 'transaction'` sets `prepare: false`, refuses `schema` and the three session timeouts as startup
   parameters (set them on the role), and `openListener()` throws without a `listenUrl`.

### Planned query -> index (for tasks 12-15; task 20 owns the tick queries)

| Query | Index |
|-------|-------|
| claim, FIFO ungrouped (`NOT lifo`, priority desc, then age) | `qcloud_jobs_ready_idx` |
| claim, LIFO ungrouped | `qcloud_jobs_lifo_ready_idx` |
| claim, grouped: next ready of one group | `qcloud_jobs_group_ready_idx` |
| group concurrency: active jobs of a group | `qcloud_jobs_group_active_idx` |
| lease recovery: expired leases, oldest first | `qcloud_jobs_lease_idx` |
| list a queue by state | `qcloud_jobs_state_idx` |
| flow: children of a parent | `qcloud_jobs_parent_idx` |
| TTL expiry of unclaimed jobs | `qcloud_jobs_ttl_pending_idx` |
| dedup: live job holding a unique key | `qcloud_jobs_live_unique_key_idx` |
| tick re-ring, never rung / bell older than threshold (two branches) | `qcloud_jobs_ring_idx` |
| tick pre-ring: delayed jobs due inside the transport window | `qcloud_jobs_delayed_idx` |
| flow: dependencies a job waits for / jobs waiting on one | `qcloud_dependencies_pkey` / `qcloud_dependencies_dependency_idx` |
| flow failures by parent and mode; repeat successor; job logs in order | `qcloud_flow_failures_parent_idx`, `qcloud_repeat_links_successor_idx`, `qcloud_job_logs_job_idx` |
| cron: due schedules | `qcloud_crons_due_idx` |
| workers: a live worker serves a queue | `qcloud_workers_pkey` (fleet-sized) |
| completions: ids of a queue / most recent first | `qcloud_completions_queue_idx` / `qcloud_completions_recent_idx` |
| group rotation order within a queue | `qcloud_group_state_rotation_idx` |
| events: latest of a queue; a namespace after a cursor; one transaction's rows | `qcloud_events_queue_id_idx`, `qcloud_events_namespace_id_idx`, `qcloud_events_transaction_idx` |
| commits: replay after a cursor | `qcloud_event_commits_replay_idx` |
| prune watermarks: newest committed of a queue; those waiting for a commit number | `qcloud_event_prune_watermarks_commit_idx`, `..._pending_commit_idx` |

**Warning for task 13 (claim path).** Upstream's ungrouped claim orders by `priority DESC, CASE WHEN lifo ... END, ...`.
No index can deliver an order built from a `CASE`, so that shape sorts every ready job of the queue. Use two branches
instead: FIFO through `ready_idx` with `NOT lifo`, LIFO through `lifo_ready_idx`, merged by priority in the caller or
with a `UNION ALL ... ORDER BY ... LIMIT`. `schema.indexes.test.ts` has the two branch queries as the reference.

### Connection suites: what happened to the spike tests

- `failure.test.ts` -> `connection.driver.test.ts` (raw `Bun.SQL`, pins the behaviour `ResilientPool` and the retry-once rule rest on) and `connection.fault.test.ts` (`openDatabase`).
- `tls.test.ts` -> `connection.tls.test.ts` (typed `tls`, password function) and `connection.socket.test.ts` (unix socket, now also migrates a schema over it). The `sslmode` URL cases are replaced by the target unit tests.
- `pooling.test.ts` -> `connection.pooler.test.ts` (PgBouncer behaviour) and new `connection.pooled.test.ts` (`openDatabase` through PgBouncer: migrate, 60 concurrent operations, 4 concurrent migrators, listener on a direct `listenUrl`).
- Kept as spikes (not promoted; CI runs none of them): `claimPath`, `fleet`, `tick` in `spike/db-access/`, repointed at `test/support/`. Tasks 13 and 20 replace them.
- The socket test builds a short temporary path (macOS limits a socket path to 104 bytes).

### Verified (PostgreSQL 18.6, local, TCP only)

- Static gate, re-run at close-out: `bun run typecheck && bun run lint && bun run format:check && bun run architecture`
  exits 0; 186 project TypeScript files, all within 300 lines.
- `bun test packages/store-postgres --grep schema` (the task's Verify command, without its `docker compose` line):
  53 pass, 0 fail. 56 more tests were skipped, because they need an emulator, PgBouncer or TLS Postgres.
- `bun test packages/store-postgres/test`: 101 pass, 21 skip, 0 fail. The 21 skips are `connection.pooler` (7),
  `connection.pooled` (6) and `connection.tls` (8 as Bun counts them), all for lack of PgBouncer or the TLS Postgres.
- `bun test` (everything): 161 pass, 72 skip, **1 fail**, see below.
- `connection.tls` was run once earlier in this task against a throwaway PostgreSQL 18 with TLS on 55433 (its own
  certificate, because the compose container makes a new one on each start): all 6 tests passed. That instance was
  stopped and deleted, so the TLS suite is **not** part of the numbers above and was not re-run at close-out.

### Not run, or failing

- **Docker, PG 16, `QCLOUD_REQUIRE_DB=1`, the compose profiles: not run.** The snapshot was generated on PG 18 and may differ in text on PG 16. It is built to resist that (not-null constraints of `contype 'n'` are excluded, nullability comes from `pg_attribute.attnotnull`, the schema name is normalised), but the Docker run is what proves it.
- **PgBouncer: not run.** `connection.pooler` (7) and `connection.pooled` (6) skipped; **`connection.pooled` is new and has never executed**, so expect to fix it in the Docker pass. Also not run: Pub/Sub emulator, ElasticMQ, `bun run test:model` (no core queue semantics changed in this task).
- **`spike/db-access/fleet.test.ts` "at the cap, direct" fails on this Mac** and passes on the Docker PG 16 it was written against (task 05). 400 simultaneous loopback connects overflow macOS's listen backlog (`kern.ipc.somaxconn` = 128), so some are refused at TCP level (`ERR_POSTGRES_CONNECTION_REFUSED`) before Postgres can answer `53300`. Not a code regression; it is a spike suite and CI does not run it. Left unchanged.
- Nothing was run against a real cloud resource.

### Notes for the next tasks

- **Task 12:** decide `nextval` vs `group_sequence`; if it moves, that is migration 2. Every statement of an operation takes `now` from `StoreTime.now` once.
- **Task 13:** the claim-path warning above.
- **Task 14:** a same-instant reset gives `ERR_POSTGRES_CONNECTION_CLOSED` (pinned in `connection.driver.test.ts`); idempotent callers retry once. `OperationDeadlineError` means "outcome unknown".
- **Task 15:** `spike/ported/` still holds the old schema modules because the rest of the spike imports them; delete with the directory. Decide whether the watermark indexes return.
- **Task 22:** the `markRung` non-HOT cost.

### Addendum, 2026-10-14 (found by task 16's regression run)

The migrator had a race under parallel starters: after waiting for the advisory lock, `readRecorded` and `refuseForeignTables` used
`to_regclass`, which answers from a stale catalog name cache, so a starter that waited mistook the lock holder's finished schema for
a foreign one (`SchemaVersionError`, 36 of 40 runs of the ten-way stress). Fixed in task 16 with `relationExists` (a `pg_class` read
in `src/schema/migrate.ts`); the deterministic test is `test/schema.migrate.race.test.ts`. The "four processes" test of this task
did not catch it on its own because it only fails under load. Details: the gate document, task 16 section, item (h).
