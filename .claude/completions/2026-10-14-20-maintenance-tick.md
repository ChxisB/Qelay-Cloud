# Task 20: Maintenance tick (2026-10-14)

**Done locally, on PostgreSQL 18.6, the in-memory and local transports and the Pub/Sub emulator, not on the Docker PG 16 of CI.** `packages/maintenance`
is the repair-and-schedule loop: one idempotent tick (recovery, crons, promotion, ringing, expiry, retention), run by an HTTP endpoint, a CLI or an
opt-in in-process loop whose leader is a lease row on the database clock. The user told me to defer Docker-backed runs until every task is done; the
runs here set `QCLOUD_REQUIRE_DB=1` against the local PG 18. No real cloud resource was used.

**Changed files**

- `packages/maintenance/src/` (new, 12 files, 1,237 lines): `tick`, `ring`, `config`, `loop`, `http`, `auth`, `cli`, `bin`, `env`, `redact`,
  `telemetry`, `index`.
- `packages/maintenance/test/` (new, 175 tests in 14 files): `config`, `ring`, `tick`, `concurrent`, `loop`, `auth`, `http`, `env`, `redact`, `cli`,
  `chaos` (+ `chaos.ts`), `lateness` (+ `lateness.ts`), `election` (+ `loopChild.ts`), `pooled`, `support.ts`. `scripts/measure-tick-lateness.ts`.
- `packages/store-postgres/`: migration v4 `tick state` (`src/schema/ddl/tickState.ts`, `qcloud_tick_state`), `src/store/tickState.ts` and the four
  `store.maintenance` methods (`acquireTickLease`, `releaseTickLease`, `recordTick`, `tickStatus`), `test/tick.state.test.ts`,
  `test/schema.snapshot.txt` regenerated, `test/schema.planned.ts` (a row for the lease read; the operator rows moved to the new
  `schema.planned.operator.ts`), `src/store/storeContext.ts` (the options and the context building moved out of `postgresStore.ts`; same exports).
- `packages/sdk/src/workerClaim.ts` and `worker.ts`: `claimForBell` rechecks once when the queue has any job waiting; `BellClaim` lost `jobId`.
  `packages/sdk/test/worker.locked.test.ts` has the failing-first test.
- `packages/store-postgres/test/connection.pooled.test.ts`: a 4-store, 200-job claim/complete test through the pooler.
- `test/support/pgbouncer/` (PgBouncer and TLS assets, moved out of the spike); `docker-compose.test.yml`, `.gitignore` and `connection.tls.test.ts`
  repointed.
- Deleted: `packages/store-postgres/spike/db-access/` (whole), `spike/doorbell/{ring,sweep}.ts`, the two `scripts/_debug-*.ts` files.
- Docs: `DESIGN.md` section 3, `docs/compat.md`, `docs/PORTING.md` (disposal text), `docs/spikes/05-db-access-and-delay.md`,
  `docs/spikes/06-phase0-gate.md` (section "The tick as built (task 20)", items (a) to (h), the amended task-19 item (a), the disposal table, a dated
  amendment), `CLAUDE.md` (the maintenance suites and their durations), the task 20 file, `CURRENT.md` (18 of 42).

**Measured** (real `TickLoop`, real timers, database clock at both ends; the full table and the chaos figures are in the task's Result)

- Lateness at window 0: mean 270-292 ms and p95 479-513 ms at a 500 ms interval; mean 1,080-1,113 ms and p95 1,950-1,956 ms at 2,000 ms. With a
  window of three intervals: mean 6-8 ms. No ring was ever early. A tick pass costs 12-34 ms.
- Chaos (half the rings lost, workers killed): worst gap without a bell due 1,717-1,743 ms against a bound of 2,250 ms; 3,222 against 3,750; 697
  against 1,200. A control run with no ticks fails the bound.
- Election, three processes: takeover about one lease after `SIGKILL`; within about one or two intervals after a graceful stop; a late joiner never
  takes a live leader's lease.

**Bug found by the lateness runs (fixed, test first)**

- A bell is fungible, so task 19's recheck (only when the bell's own job was still waiting) was too narrow: another claim could take the bell's job
  while a different waiting job was locked by `markRung`, and that job waited a full re-ring. Invariant 3 held; it was a latency hole. The recheck is
  now keyed on the queue. Not a design deviation; recorded in the gate document, item (c).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (429 files within the 300-line cap; two files that had
  reached 303 and 304 lines were split, not trimmed).
- `bun test ./packages/maintenance`: 174 pass, 1 skip (`pooled.test.ts`, no PgBouncer). `bun run test:model`: 17 pass.
- `bun test ./packages ./test` on PG 18 with the Pub/Sub emulator, `QCLOUD_REQUIRE_DB=1`: 1,705 pass, 54 skip, 1 todo, 0 fail.

**Owed at the end of the plan (not run here)**

- PgBouncer: `maintenance/pooled.test.ts` and the new pooled claim test have never run against it.
- PG 16, TLS, ElasticMQ, and the regeneration of `schema.snapshot.txt` and the EXPLAIN recheck on PG 16.
- Task 22: `docs/limits.md` must quote the lateness numbers and list every `QCLOUD_TICK_*` variable (`qcloud-tick --help` points to it).
- The election test's overlap during a takeover is not a test of its own; the four-concurrent-tick cases carry the same assertions.
- The 1,165 ms outlier in one lateness run is undiagnosed (cold connections are the likely cause; 12 further runs did not reproduce it).
