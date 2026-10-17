# Task 61: Workflow Engine in the SDK (2026-10-16)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator and ElasticMQ.** The workflow engine runs as ordinary queue jobs on any transport, with its state in
the task 60 store and its two background duties (end a wait, take a dead engine's run) in the maintenance tick. Docker, PG 16 and a real cloud were not
used (see **Owed**). Nothing was applied, pushed or published. No migration: the store contract did not change.

**Changed files**

- `packages/sdk/src/workflow/` (41 files, about 4,400 lines, all new): `Engine`, admission rule, `RunStorage` (one serialising writer per run, version
  CAS), executor and runners (step, retries, parallel, map, for-each, loops, `waitFor`, sub-workflow), compensation and unwind plan, recovery, `Workflow`,
  `defineWorkflow`, definition guard, events, injected `Clock`.
- `packages/core/src/`: `WorkflowStorePort.now()`, `RecoverableOptions.states`, and the memory reference for both.
- `packages/store-postgres/src/store/`: the same two additions on the Postgres store (`workflowApi.ts`, `workflowList.ts`; no schema change).
- `packages/maintenance/src/`: `workflowSweep.ts` (due waits, recoverable runs, bounded by `QCLOUD_WORKFLOW_BATCH`), wired into `runTick`; `cli.ts` usage
  text.
- `packages/sdk/test/`: `workflow.{flow,retry,wait,rollback,sub,crash,compat}.test.ts`, `workflowSupport.ts`, `crashFlow.ts`, `crashEngine.ts`.
- `packages/maintenance/test/workflow.sweep.test.ts`, `test/workflow/tickFormat.test.ts`.
- `test/model/wfengine/` (the real-engine model: spec, commands, harness, invariants I1 to I12).
- `test/scenarios/`: `workflowStack.ts`, `scenarios.workflows.ts` (5 scenarios), `all.ts`, `stack.ts` (`workflows` option), `scenario.ts` (`suite`),
  `scenarios.test.ts` (`QCLOUD_SCENARIO_SUITE`); `scripts/test-transport.ts` (`--suite=`).
- `scripts/workflowBoundary.ts`, `scripts/check-workflow-boundary.ts`, `test/architecture/workflowBoundary.test.ts`, `package.json` (`architecture`).
- `docs/compat.md` ("Workflow engine"), `docs/limits.md` (4 env rows, "how late a workflow wait ends"), `docs/PORTING.md` (12 rows),
  `docs/spikes/06-phase0-gate.md` (the task 61 amendment).
- `.claude/.planning/v1.0.0/{61-workflow-engine-sdk,CURRENT}.md`.

**Checked** (what was true, with the tests that show it)

- *Order and bodies:* steps, parallel, map, for-each, loops and a sub-workflow run in order, each body once (`workflow.flow`, scenario 1).
- *Retries and idempotency:* a retried step carries a new attempt, a duplicate job is dropped by the admission rule, and no step runs twice with the same
  `(execution, step, attempt)` (`workflow.retry`, `workflow.crash`).
- *Waits:* a signal opens a gate; a timed gate ends on the tick, not on a timer; a signal that arrives first beats the timeout (`workflow.wait`, scenario 2).
- *Rollback:* a failing step rolls back earlier ones in reverse order, once each; a pivot ends rollback; a stuck handler parks the run for an operator
  (`workflow.rollback`, scenario 3).
- *A killed engine:* a child process is killed with SIGKILL between two steps, mid-step and mid-compensation; the tick hands the run to another engine and
  it resumes exactly once; handlers that had stored their outcome never run again (`workflow.crash`, scenarios 4 and 5).
- *Sub-workflows:* child outcome reaches the parent; a child that outlives its timeout parks the parent in `compensation-stuck` (`workflow.sub`).
- *The model:* the real engine on Postgres under generated graphs and operator histories (signals, restarts, live `recover()`, `recover()` into an unwind,
  resume, abandon) holds I1 to I12 and the liveness gate.
- *The tick step:* due waits and recoverable runs are claimed once, bounded by the batch, and the job it publishes has the SDK's exact shape (13 sweep
  tests, 2 format tests).
- *Boundary:* no `bun:sqlite`, TCP client or `Qelay` class in workflow code (3 tests, `bun run architecture`).
- *Compat:* every upstream `Engine`, `Workflow`, `EngineOptions` name is in `docs/compat.md` with a status the guard accepts (5 tests).

**Run** (PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ 1.7.1; `caffeinate` around the long runs)

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run architecture` clean.
- `bun test packages/sdk --grep workflow`: 48 pass, 0 fail (flow 10, retry 6, wait 8, rollback 6, sub 8, crash 5, compat 5). The seven files run three times
  in a row: 48 pass each time.
- `bun run test:model`: 31 pass, 0 fail, 80 s.
- `bun run test:scenarios --suite=workflows --transport=local,gcp-emulator,aws-emulator`: 20 pass, 0 fail, 17.9 s (5 scenarios on memory, Postgres,
  Pub/Sub emulator and ElasticMQ; earlier runs were stable three times).
- Full gate with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1`: 4828 pass, 29 skip (the PgBouncer and TLS Postgres suites, Docker only), 1 todo, 0 fail; 4858 tests in 473 files, 979.8 s. An
  earlier run of this gate failed once, on the compat status guard (see **Found and fixed**), and was rerun after the fix.

**Measured**

- A timed wait ends at the first tick after its deadline plus the transport's delivery; the scenarios use a 150 ms tick. `docs/limits.md` derives the bound
  for the production tick (`QCLOUD_WORKFLOW_WAIT_LEASE_MS` 30 s is the lease, not the delay).
- Nothing else was timed. There is no throughput figure for the engine; do not quote one.

**Decisions**

- Every node is a job on one engine queue (`QCLOUD_WORKFLOW_QUEUE`, default `__wf:steps`); `currentNodeIndex` is the cursor.
- A timeout is a deadline column owned by the tick, never a process timer (matches task 13's rule and task 60's store).
- A running node heartbeats its run every `heartbeatMs`; the tick takes a silent run after `idleMs` (300 s). This reverses task 60's note that recovery
  by idleness needs no heartbeat.
- The tick takes `running`, `compensating` and `failed` runs. It skips `waiting` runs on purpose.
- A definition that differs from the one a live run started under is refused at `register` (`WorkflowDefinitionMismatchError`); `register` and the read
  methods are async.
- Additions to upstream's surface: `cancel`, `startWorkflow`, `listExecutions`, `defineWorkflow(name, { revision? })`, an injected `Clock`.

**Found and fixed**

- The version fence made a run's own parallel steps fail against each other; fixed with the serialising `RunStorage` (copies `version` back after each write).
- The first model runs reported a child "never published". The harness never ran `store.tick`; it runs the real `runTick` now. The property behind it is
  real and is recorded in the spike.
- A scenario polled with a new `Engine` per poll; each had a worker and stole bells. It reads the store without a worker now (`runReader`).
- PORTING and compat claims written from memory were wrong in four places (the `defineWorkflow` change, the simulated clock, the fence generation, "no
  invariant was weakened"). Each was checked against upstream and corrected.
- `docs/compat.md` used two statuses (`Added`, `Later`) that the existing guard rejects; the rows now use `New` and `Not supported`.

**Owed**

- The Docker-backed gate; the PG 16 recheck of the store queries the engine uses (no new DDL).
- Real Pub/Sub and SQS runs of the workflow scenarios (D9).
- Task 62: decide the open gap (a `waiting` run with a recorded signal whose resume was never published is repaired only by `engine.recover()`): the tick
  takes such runs through a cheap indexed predicate, or the operator surface offers `recover`.
- Three upstream model invariants are relaxed (a `failed` run may lack `rollbackStatus` until it settles; a `running` map record is accepted while its node
  is current; a map transform may run once per engine generation). They are named in `docs/PORTING.md` and the spike. The user should confirm they are
  acceptable.
- Upstream's whole workflow test suite was not ported, only the scenarios that bear on the engine's semantics.
- The maintenance sweep repeats the job name and payload shape of the SDK because `maintenance` may not import it; `tickFormat.test.ts` is the guard.
- A sub-workflow node polls its child inside the parent's job and holds a worker slot; `concurrency` bounds how many wait at once.
- The `Bun.SQL` null-in-typed-array hazard and `UPDATE … FROM (subquery LIMIT)` shapes were not swept repo-wide.
- Compensation handlers are at-least-once across a crash (the outcome is stored after the handler's effect); handlers need idempotency keys.
