# Task 60: Postgres WorkflowStore (2026-10-16)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator and ElasticMQ.** The workflow persistence port, an in-memory reference, the Postgres store
(migration 9) and the tests that hold them together are built. Docker, PG 16 and a real cloud were not used (see **Owed**). Nothing was applied,
pushed or published.

**Changed files**

- `packages/core/src/`: `workflowTypes.ts`, `workflowStore.ts` (`WorkflowStorePort`), `workflowRules.ts`, `workflowMemory.ts`,
  `workflowMemoryRows.ts` (all new), `errors.ts` (`ExecutionStaleError`, `ExecutionExistsError`, `SignalRejectedError`), `index.ts`.
- `packages/store-postgres/`:
  - schema: `src/schema/ddl/workflows.ts` (new), `src/schema/migrations.ts` (migration 9 `'workflows'`), `test/schema.snapshot.txt`,
    `test/schema.planned.workflow.ts` (new, 12 rows), `test/schema.planned.ts`, `test/schema.indexes.test.ts` (seeds 12,000 runs and 3,000 archived,
    `QCLOUD_PRINT_PLANS` prints the plans).
  - store: `src/store/workflow{Crud,Signals,List,Retention,Rows,Api}.ts` (new), `src/store/postgresStore.ts` (`workflows`), `src/errors.ts`
    (`ExecutionTooLargeError`), `src/index.ts`.
  - tests: `test/workflow.contract.test.ts`, `test/workflow.races.test.ts` (8), `test/workflow.limits.test.ts` (7).
- `test/support/workflow/{fixtures,crud,signals,waits,lists,retention,index}.ts` (the contract suite, 67 tests, run by both stores),
  `test/workflow/memory.test.ts`.
- `test/model/workflow/{world,compare,op,queries,commands,planted,run,workflow.test}.ts` (the differential model, 6 tests).
- `docs/PORTING.md` (ten rows), `docs/spikes/06-phase0-gate.md` (the task 60 amendment).
- `.claude/.planning/v1.0.0/{60-workflow-store,CURRENT}.md`.

**Checked** (what was true, with the tests that show it)

- *Both stores answer alike:* the 67-test contract (save, get, update, remove, findChild, signals, parking, waits, listing, recovery, retention,
  archive) passes on `MemoryWorkflowStore` and on Postgres.
- *Two engines on one run:* in 1,000 rounds exactly one `update` landed and the other was `ExecutionStaleError` with `actual = 1`; the stored run
  holds the winner's step only.
- *A signal is never lost or doubled:* a signal recorded while the engine writes its step survives (100 rounds); four callers delivering one signal
  to a parked run give exactly one resume and three `duplicate` refusals (200); a signal against a timeout ends resumed or failed, never both and
  never neither (200).
- *Claims and retention:* four claimers at once get disjoint sets that add up to exactly what exists; four archivers take each run once; cleanup
  racing archive never puts a run in both tables; retention racing recovery keeps the run or is refused as stale (100).
- *Limits:* a column over 16 MiB is refused with nothing written (on save, update, signal and timeout); two namespaces on one schema do not see,
  change or clean each other; Date, Map, Set, Error, bigint, `undefined`, an own `__proto__` key and nesting round-trip, and the prototype is not polluted.
- *The model:* the Postgres store and the reference, one history on one virtual clock; WF1 state, WF2 outcome, WF3 signals, WF4 version, WF5 archive
  only grows. It finds each of the five planted bugs.
- *The indexes:* all 12 queries plan on the intended index (109 index tests pass; plans in the task Result).
- No `bun:sqlite` in any file the task added (grep).
- Mutation checks: the race and limit tests were run against sources changed on purpose, seen to fail, and the sources restored from backups
  (verified with `diff`).

**Run** (PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ 1.7.1; the lid open and the Mac on battery)

- `bun run typecheck`, `bun run lint` (no errors), `bun run format:check`, `bun run architecture` clean. One lint error found and fixed at the end:
  `default-param-last` on `cleanup` and `archive` in `workflowApi.ts` (the default now applies inside the call).
- `bun test packages/store-postgres --grep workflow`: 100 pass, 0 fail. `bun test test/workflow`: 179 pass (the in-memory contract is 67 of them).
- `bun run test:model`: 28 pass, 0 fail, 43 s. A deep run of the workflow model (2,000 runs of 100 commands) passes.
- Full gate with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1`: 4733 pass, 29 skip (the PgBouncer and TLS Postgres suites, Docker only), 1 todo, 0 fail, 462 files, 977 s. The first run of this gate was invalid: the host disk filled up (ENOSPC) and Postgres could not create files; it was rerun after freeing space

**Measured** (PG 18.6, 1,000,000 runs, `EXPLAIN (ANALYZE, BUFFERS)`)

- List page 0.04 ms; list one state 0.08 ms; recovery one state 0.65 ms; recovery best of a range per state 2.5 ms; retention pick 0.82 ms;
  findChild 0.02 ms; claimDueWaits 0.19 ms. `listActive` for a workflow with about 200,000 runs: 101 ms, unbounded as upstream's is.
- Seeding 1,000,000 runs took 44 s.

**Decisions**

- Signals stay a column of the run row (as upstream); no `output` column.
- `update` is a version compare-and-set. This is a behaviour change from upstream's blind write; the engine must handle `ExecutionStaleError`.
- A wait's deadline is a column and a scanner owns it by a lease under `SKIP LOCKED`, so no process holds a timer.
- Recovery is by idleness (`idleMs`, 0 = no cutoff), not by an owner lease.
- Retention is one statement that re-checks state and age, so it cannot race recovery into a half-moved run.
- An id can be archived, saved again and archived again; live and archive rows may coexist. The invariant is that the archive only grows.
- The port is async (upstream's was synchronous), which ripples into the engine in task 61.

**Found and fixed**

- `UPDATE … FROM (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) due` re-evaluated its subquery and `claimDueWaits({ limit: 2 })` returned three rows. A failing contract
  test came first; the fix is `WITH due AS MATERIALIZED (…) UPDATE … FROM due`. The other `SKIP LOCKED` sites were not audited for this shape.
- The model's first invariant ("an id is never in both tables") was wrong by design; it is now "the archive only grows".
- `parkForSignal` threw synchronously for a bad deadline; it rejects now.
- `commands.ts` of the model was 301 lines; split into `op.ts`, `queries.ts` and `commands.ts` for the 300-line check.

**Owed**

- The Docker-backed gate and the PG 16 DDL snapshot and EXPLAIN recheck for migrations 6, 7, 8 and 9.
- A sweep of the repo for `UPDATE … FROM (subquery LIMIT)` shapes, and for the `Bun.SQL` null-in-typed-array hazard (found in task 52; not swept).
- Task 61: handle `ExecutionStaleError`; copy `version` back after `expireWait`; choose `idleMs` against the longest node; decide how often to call
  `listActive`; build the engine-level model over the whole engine (upstream's `workflow-model*`).
- Open design points for the user: the `failure_reason` column is not capped; each encoded column is capped at 16 MiB; the codec no longer preserves
  cyclic references; `getArchivedCount` is a full count; `findChild` returns the oldest child.
- A killed test run leaves its `qcloud_t_*` schema behind in the scratch Postgres at 55442 (64 were dropped after the invalid gate run; harmless, drop them with the instance).
