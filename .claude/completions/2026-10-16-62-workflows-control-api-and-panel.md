# Task 62: Workflows: Control API and panel (2026-10-16)

**Done locally, on PostgreSQL 18, the Pub/Sub emulator, ElasticMQ and Chromium and WebKit.** An operator can find a workflow run in the panel, read its steps,
graph, payloads and rollback, and signal, cancel, recover or retry the rollback of it behind a version fence, the `operator` role, a typed confirmation for
the destructive ones, and one audit row. Docker, PG 16, Firefox and a real cloud were not used (see **Owed**). Nothing was applied, pushed or published.
Two migrations (10 and 11) were added; both only add a table or an index.

**Changed files**

- `packages/control-api/src/`: `jobs/workflow{Rules,Compensation,View,Actions,Schemas,Steps}.ts` (state rules, rollback facts, wire views, the five actions as
  claim plus publish, schemas, steps and for-each paging), `routes/workflows.ts` (list, detail, steps, actions), `routes/capabilities.ts`
  (`features.workflows`), `runtime/settings.ts` (`QCLOUD_WORKFLOW_QUEUE`, `QCLOUD_WORKFLOW_IDLE_MS`, `QCLOUD_API_WORKFLOW_SERVED_MS`, `QCLOUD_API_WORKFLOWS`),
  `runtime/main.ts` (doc).
- `packages/control-api/test/`: `workflowFixture.ts`, `workflows.{read,actions,recover,failure,fanout}.test.ts`, `capabilities.workflows.test.ts`,
  `runtime.settings.workflows.test.ts`, `openapi.workflows.test.ts`; `docs/openapi.yaml`.
- `packages/core/src/`: `workflowGraph.ts`, `workflowJob.ts` (the `wf:step` job and queue name the Control API publishes), the loop-name helpers
  (`<step>:<n>`), `workflowStore.ts` (definitions registry, `liveDefinitions`, `summaries({ id })`, `restoreSignalWait`), `workflowMemory*.ts` (the memory reference).
- `packages/store-postgres/src/`: migration 10 `qcloud_workflow_definitions` (`schema/ddl/workflowDefinitions.ts`), migration 11 the partial index
  `qcloud_workflow_executions_live_idx` (`schema/ddl/workflowLive.ts`), `store/workflowApi.ts`, `schema/migrations.ts`, `index.ts`; `test/schema.snapshot.txt`
  regenerated, a row in `schema.indexes.test.ts`, `schema.planned.workflow.ts`, `schema.versions.test.ts`.
- `packages/sdk/src/workflow/`: the engine announces its definitions every `announceMs` (`engine.ts`, `engineTypes.ts`, `executorLifecycle.ts`); `packages/maintenance/src/workflowSweep.ts`
  uses the shared job shape; `packages/sdk/test/workflow.definitions.test.ts`.
- `test/support/workflow/{signals,insight}.ts` (`signals.ts` holds the contract test that found the signal-wait bug), `test/model/workflow/commands.ts`, `test/workflow/tickFormat.test.ts`.
- `packages/panel/src/features/workflows/` (domain, application, infrastructure, ui: about 35 files), `pages/control/Workflows.tsx`,
  `pages/control/job/JobWorkflowLink.tsx` (mounted in the Job Inspector), `lib/capabilities/model.ts`, `lib/demo/workflow{Data,s}.ts`.
- `packages/panel/test/workflow{.helpers,-actions,-connection,-demo,-job-link,-page,-steps,-url-state}.test.ts(x)`.
- `packages/panel/e2e/`: `workflows.e2e.ts` (6 tests), `workflowHost.ts` (the application that owns two definitions), `panelServer.ts` (static serving split out of
  `runtime.ts` for the 300-line rule), `runtime.ts`, `seeds.ts` (`seedFanOutRun`), `control-api.e2e.ts` and `dashboard.e2e.ts` (workflows is an available page now).
- `docs/compat.md` (route row, "Operating workflows from the Control API and the panel"), `docs/limits.md` (env rows, section 13), `docs/PORTING.md`,
  `DESIGN.md` (section 8, Phase 5 row), `docs/spikes/06-phase0-gate.md` (the task 62 amendment).
- `.claude/.planning/v1.0.0/{62-workflows-control-api-and-panel,CURRENT}.md`.

**Checked** (what was true, with the tests that show it)

- *Reading:* the list pages and filters runs by state and name and tells served from unserved definitions; the detail carries the graph, the first page of steps,
  children and compensation; payloads are cut at 1,024 B in a list and 256 KiB in a detail with a marker (`workflows.read`).
- *The fence:* a stale `expectedVersion` is 409 `version_conflict` with `expectedVersion` and `actualVersion` and nothing changes, for `cancel`, `signal`, `recover`
  (`workflows.actions`) and `retry-compensation` and `abandon-compensation` (`workflows.recover`); two operators on one version: one wins, the other is 409, one job goes out.
- *Terminal runs* are 409 `execution_terminal` whatever the version; an action that does not apply to the state says what does (`workflows.actions`).
- *Confirmation:* `cancel` and `abandon-compensation` without `confirm` equal to the run id are 400 `confirmation_required` and change nothing.
- *Audit:* one row per action naming `workflowAction=<name>`, none carrying an event, a payload or a reason, including the refusals of a viewer (`workflows.failure`, e2e).
- *Failure of the publish:* the claim stays and the answer is 503 `publish_failed { claimed: true }`; a signal whose publish failed is recorded and `recover` resumes it.
- *The tick's gap:* a parked run whose signal is recorded but never resumed is recovered at once; one that is still waiting is not (`workflows.recover`).
- *Large runs:* a 10,000-item for-each returns a detail with counts only, and iterations 25 at a time with a status filter (`workflows.fanout`, panel `workflow-steps`, e2e).
- *Capability:* off below migration 10 and with `QCLOUD_API_WORKFLOWS=false`; the panel hides the page and the link (`capabilities.workflows`, panel `workflow-connection`).
- *Migrations:* version 10 and 11 are in the planned snapshot; the live index serves `liveDefinitions()` (`schema.indexes`, `schema.versions`).
- *Store contract:* a signal recorded for a run that was cancelled or recovered while parked is judged awaited again (`test/support/workflow/signals.ts`, both stores).
- *Panel:* 40 tests for the page, URL state, actions, steps, payload truncation, the connection and the demo backend.
- *Browser:* six specs: signal to completion, cancel with typed confirmation, a failing step with rollback, a stuck rollback retried after repair, a viewer, a stale
  version and a forced action, and a 10,000-item for-each.

**Run** (PG 18.6 at 55442, Pub/Sub emulator, ElasticMQ 1.7.1; `caffeinate` around the long runs)

- `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run architecture` clean (1,451 files within the 300-line limit).
- `bun test packages/control-api packages/panel --grep workflow`: 88 pass, 0 fail (control-api 48, panel 40). The whole of both packages: 1,998 pass, 0 fail.
- `bun run test:e2e`: Chromium, the whole suite, 35 passed (1.3 min); the workflow specs on WebKit, 6 passed (21 s). Firefox: the browser did not start (see **Owed**).
- `bun run test:model`: 31 pass, 0 fail, 77.8 s.
- Full gate with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1`: 4,917 pass, 29 skip (the PgBouncer and TLS Postgres suites, Docker only), 1 todo, **1 fail**;
  4,948 tests in 480 files, 992 s. The failure was `browser-e2e-policy` (see **Found and fixed**); after the fix that file passes, the static checks are clean again and
  `packages/control-api` and `packages/panel` pass whole. The gate was not run a third time end to end. A first gate run was stopped by me when the disk filled (see
  **Found and fixed**).

**Measured**

- The read cost of a for-each, one request at a time, on a laptop with Postgres on loopback (median of 7, `GET` through the Control API): 1,000 iterations = 107 KB of stored
  steps, detail 1 ms; 10,000 = 1.1 MB, detail 5 ms, page of 25 4 ms; 50,000 = 5.6 MB, detail 20 ms, page 18 ms. The responses stay at 1.2 KB (detail) and 6 KB (page of 25).
  These are not throughput figures; do not quote one. The run list reads no steps (0 ms at all three sizes).

**Decisions**

- The Control API holds no definitions and runs no engine, so an action is a **claim** (a version-checked write) plus a **publish** (a `wf:step` job a worker that
  holds the definition executes). A lost publish is repaired by the tick after `QCLOUD_WORKFLOW_IDLE_MS` (five minutes by default).
- The version fence is a compare-and-set for `cancel` and `recover` and a read check for `signal`, `retry-compensation` and `abandon-compensation` (the store
  locks the row or the engine claims the unwind). `docs/limits.md` section 13 says so.
- The tick keeps skipping `waiting` runs. The gap it leaves is closed by `recover` on one run, which acts at once only when the awaited signal is recorded.
- "Rollback" in the panel is `cancel` for a live run and `retry-compensation` for a stuck one; `abandon-compensation` is behind the same typed confirmation as cancel.
- Definitions are a table filled by workers, not code the API loads. A first-seen hash prunes that name's old rows (last seen over 30 days ago and beyond the 20
  newest), so the table does not grow with every deploy. `features.workflows` is true from migration 10 on.
- The panel shows payloads to every `viewer`; they are cut by size, not hidden. `QCLOUD_API_WORKFLOWS=false` hides the whole page.
- A definition no worker serves is listed with a warning, and its actions are still offered (the job waits on the queue until a worker has the definition).
- **A for-each is read as a whole run.** The counts and the pages are made by the Control API from the run's step records, so a request loads the whole run: the
  response is bounded, the read grows with the iterations. A per-iteration table or engine-kept counts would be the next step for runs of hundreds of thousands;
  the plan did not ask for it (`docs/limits.md` section 13, the spike).
- The e2e workflow worker runs only while the workflow specs do, because a workflow engine is a worker and shows in the worker registry.

**Found and fixed**

- The store forgot a run's `signal_wait` when it was cancelled or recovered while parked, so a later signal was judged "not awaited". A failing contract test
  came first (`test/support/workflow/signals.ts`); `restoreSignalWait` fixed it for both stores.
- Docs claims written from memory were wrong in five places (`workflow_progressing` applies only to `recover`; the panel does not hide actions for an unserved
  definition; "re-sending is refused by the version"; the migration that opens the capability; a line in `docs/limits.md`). Each was checked against the code.
- The always-on e2e workflow worker made two older specs fail (they expect no worker); it now starts lazily and stops after the workflow specs.
- A spec that reloaded the page lost the bearer token (held in memory by design); it waits for the page's own refresh instead.
- `runtime.ts` of the e2e stack passed 300 lines; the static server moved to `panelServer.ts`.
- `browser-e2e-policy` scans the e2e stack for `hostname:` bindings and read only `runtime.ts`; after the split it saw 2 of the 4 and failed. It reads `runtime.ts` and
  `panelServer.ts` now and still requires every binding to be the loopback constant. (Found by the gate, not by the earlier targeted runs.)
- I had written "computed in the database" for the for-each counts in the Result, `docs/limits.md` and the spike. The counts come from the Control API's pass over the
  loaded record. Found while checking the claims against the code, measured, and the three places corrected before closing.
- A stale version for `retry-compensation` and `abandon-compensation` was claimed but had no test; `workflows.recover.test.ts` has one now.
- The disk filled during the first gate run (the system volume was at 100% with 1.4 GiB free; the Bash tool could not even write its output). Most of it is other
  projects' temp data. What was mine: the scratch Postgres' WAL (1 GB at the default `max_wal_size`) and 36 test schemas left by earlier killed runs. I stopped the gate,
  dropped those schemas, set `max_wal_size` to 192 MB and `min_wal_size` to 32 MB on the scratch Postgres (not a repo file) and ran the gate again. Nothing outside
  the scratchpad and that Postgres was deleted.
- Panel tests failed on the German number format ("10.000"); they use `formatNumber`.

**Owed**

- The Docker-backed gate; the PG 16 snapshot regeneration and EXPLAIN recheck for migrations 10 and 11 (the live-definitions count and the definitions upsert).
- The disk of this machine is close to full (2.4 GiB free before, 9 GiB after the cleanup, of 460 GiB, most of it not from this project); a long run can fail on `ENOSPC`.
- A for-each is read whole on each request (see **Decisions**); a per-iteration table or kept counts if runs beyond about 50,000 iterations are expected.
- Firefox: the browser did not start in this sandbox (`browserType.launch` timed out after 180 s, the same as tasks 51 and 52). The CI `e2e` job was never run.
- Real Pub/Sub and SQS runs of an operator action (D9): the claim-and-publish path ran against the memory transport in the e2e and the emulators in the unit suites only.
- Task 72: the panel shows execution input, output and signal payloads to every `viewer`; the security review should decide whether a stronger default is wanted.
- A publish that fails after a claim leaves a run for up to five minutes; an operator-facing "republish" shortcut was not built (the tick does it).
- Upstream's archive, maintenance and runtime panel pages are not carried (there is no SQLite archive; retention is the tick's).
- Carried from task 61: three upstream model invariants are relaxed and need the user's confirmation; the Docker gate; compensation handlers are at-least-once.
