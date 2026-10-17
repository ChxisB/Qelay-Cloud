# Task 19: SDK, Worker and QueueEvents (2026-10-14)

**Done locally, on PostgreSQL 18.6, the in-memory transport and the Pub/Sub emulator, not on the Docker PG 16 of CI.** `packages/sdk` now has the
consumer side: a `Worker` that turns bells into claimed, heartbeated, completed or failed jobs, and a `QueueEvents` that reads the journal from a
cursor. The model harness also runs with real `Worker`s. The user told me to defer Docker-backed runs until every task is done, which departs from
CLAUDE.md's `QCLOUD_REQUIRE_DB=1` rule (the runs here set it against the local PG 18); that run is owed at the end. No real cloud resource was used.

**Changed files**

- `packages/sdk/src/` (new, 14 files): `worker`, `workerClaim`, `jobRunner`, `workerJob`, `workerOptions`, `workerHooks`, `workerRegistry`,
  `workerDrain`, `workerShutdown`, `queueEvents`, `queueEventTypes`, `typedEmitter`, `timing`, `errorText`. `runtime.ts` and `index.ts` edited.
- `packages/sdk/test/` (new, 47 tests in 8 files, plus 2 in `queue.compat`): `worker.{flow,slots,lease,close,crash,locked}.test.ts`,
  `events.{stream,resume}.test.ts`, `workerSupport.ts`, `childLines.ts`, `crashWorker.ts`.
- `packages/store-postgres/src/postgresStore.ts`: `leaseMs` is a readable property. `packages/store-postgres/test/claim.locked.test.ts` (new, 3 tests).
- `packages/core/src/errors.ts`: `OutcomeUnknownError` (`OUTCOME_UNKNOWN`).
- `test/model/`: `bridgeTransport.ts`, `workers.ts`, `workers.test.ts` (new); `world.ts`, `commands-jobs.ts`, `run.ts`, `targets.ts`,
  `postgresTarget.ts`, `store-model.test.ts` (edited) for the `postgres-workers` target.
- Docs: `docs/compat.md` (every `Worker` and `QueueEvents` name classified), `docs/PORTING.md` (four rows), `docs/spikes/06-phase0-gate.md`
  (section "The Worker and QueueEvents (task 19)", items (a) to (h), and a dated amendment), the task 19 file, `CURRENT.md`.

**Decisions** (details in the task's Result and the gate document)

- The worker keeps its own slots; a busy worker asks for no bell; a bell with no slot is nacked (250 ms), a failed claim too (1,000 ms); a bell
  is acknowledged after the claim attempt, never after the job; the claim is by queue, not by the bell's job id.
- The processor is `(job, { signal })`. A lease that cannot be confirmed is treated as lost at the last confirmed beat's start plus the lease
  length; a lost job's outcome is dropped, never written.
- `close({ graceMs, timeout })` returns within the grace plus two timeouts even with a silent database; jobs still running are released with no
  failure counted.
- `QueueEvents` polls one pooled statement per read (no connection of its own); `completed` has no `returnvalue`, `delayed` no `delay`.
- Listeners are isolated, and an `error` with no listener is logged, not thrown.

**Bugs the tests found (fixed)**

- **A bell can find its own job locked by the `markRung` that followed its ring**, so the claim came back empty and the job waited for the tick.
  Found as a flaky full-suite run (about one in three to six). The worker now makes one recheck after 25 ms when the empty claim's bell names a
  job still `waiting` or `prioritized`; pinned by `claim.locked.test.ts` and `worker.locked.test.ts`. Eight full `./packages/sdk` runs after the
  fix were clean.
- The group-limits test was timing-dependent; it is deterministic now.
- `worker.ts` was over the 300-line cap; `settleBell` and the retry constants moved to `workerClaim.ts`.
- The handling of stalls, of a throwing listener and of an `error` event with no listener had bugs that the events and worker tests found; fixed.
- `queue.compat.test.ts` first counted `EventEmitter`'s inherited methods as Worker methods; the walk now stops at `EventEmitter.prototype`.
- In the model bridge, a violation inside a worker's claim would have been logged and swallowed by the worker; the spy records it and the
  harness rethrows it (pinned by a scripted test). A ring fault could leak from one command to the next; it is reset after each finish.

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (403 files within the 300-line cap).
- `bun test ./test/model` on PG 18 (`QCLOUD_REQUIRE_DB=1`): 17 pass, also with `QCLOUD_MODEL_TARGET=postgres-workers QCLOUD_MODEL_RUNS=400
  QCLOUD_MODEL_COMMANDS=80`.
- `bun test ./packages ./test` on PG 18 with the Pub/Sub emulator: 1,521 pass, 60 skip, 1 todo, 1 fail (the `fleet` spike's "at the cap,
  direct" test, which needs the Docker role limit).
- The SIGKILL crash test (two kills, one completion, `attempts` 2), the silent-database `close` bound, the lost-lease tests and the
  resume-under-concurrent-writers test pass.

**Not done / not verified**

- Docker PG 16 with `QCLOUD_REQUIRE_DB=1`, PgBouncer, TLS, ElasticMQ, `bun run test:model` on every compose profile, the `fleet` spike (and its
  failing "at the cap, direct" test), the PG 16 DDL snapshot and the `EXPLAIN` recheck.
- The Worker has not run over the Pub/Sub or NOTIFY-based local transport; the model harness uses a fault-injected stand-in transport, not the
  real ones, and leaves the `crash` command to `worker.crash.test.ts`.
- Crash recovery in the tests is a direct `recoverExpired()` call; the in-process tick is task 20.
- A processor that blocks the event loop for longer than `lockDuration` loses its lease by design; only shorter blocks are tested.

**Next:** task 20, the in-process maintenance tick. It joins the shutdown order, keeps a test for a job whose first claim lost the `markRung`
race, decides whether a store-side mitigation is wanted, and removes `spike/db-access/`.
