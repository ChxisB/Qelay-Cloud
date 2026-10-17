# 62 — Workflows: Control API and panel

**Status:** done locally · **Depends on:** 61, 34 · **Phase:** 5

## Goal

Make workflow executions visible and operable in the panel: list and inspect executions, see step state and history, send signals, cancel, and trigger or retry rollback safely.

## Scope

In: Control API workflow endpoints, the `features.workflows` capability, the panel's Workflows page, links from the Job Inspector to the owning execution.
Out: authoring workflow definitions in the UI (definitions live in code).

## Reference

Panel: `src/pages/control/Workflows*`, `src/features/workflows`, `agent/workflow`; its API calls in `src/lib/bq/`.

## Steps

1. **Endpoints:** `GET /workflows` (definitions known to deployed workers and executions, filtered by state and name, paginated), `GET /workflows/executions/:id` (state, steps, history, input/output with truncation markers, errors, children, compensation status), and actions: `signal`, `cancel`, `rollback` and `retry-compensation` where the engine supports them. Use the panel's existing paths and shapes.
2. **Safety:** each action is fenced by the execution `version` (409 on mismatch), requires the `operator` role, and is audited. Destructive ones (cancel, rollback) need the confirmation field. Reject actions on terminal executions with a clear error.
3. **Definitions:** how the panel learns a workflow's shape without running code: workers register definition metadata (name, version, step graph, hash) in a `qcloud_workflow_definitions` table at start; the API reads it. Show a warning when running executions use a definition hash no worker currently serves.
4. **Capability:** `features.workflows` is true when the workflow store is migrated and at least the engine is enabled; the panel hides the page otherwise (task 34).
5. **Panel:** Workflows page works against the new endpoints (execution list, step timeline and graph, signal and cancel dialogs, rollback view); remove reliance on the Qelay-server-only workflow agent code.
6. **Large executions:** step history is paginated; for-each and map fan-outs show aggregate counts with drill-down, not thousands of rows at once.
7. **Tests:** API contract tests; behaviour tests per action including stale-version rejection; panel component tests; an e2e: start a workflow, send a signal, cancel another, force a failing step and watch rollback.

## Acceptance

- The e2e passes: start, signal, cancel, and failure with rollback.
- Actions on a stale `version` return 409 and change nothing; actions on terminal executions are rejected.
- A 10,000-item for-each execution renders with aggregate counts and pagination.
- Every workflow mutation is audited, with no payloads in the audit rows.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/control-api packages/panel --grep workflow
bun run test:e2e --grep workflow
```

## Risks / notes

- Showing execution input and output can expose sensitive data. Apply the same size caps and truncation as the job inspector, and note in the docs that the panel shows payloads to every `viewer`.
- If task 73 cuts workflows from v1.0.0, this task's work stays on a branch and the capability stays off.

## Result

**Done locally (2026-10-16), on PostgreSQL 18.6, the Pub/Sub emulator, ElasticMQ and Chromium and WebKit.** Nothing was applied, pushed or published; no
real cloud, Docker, PG 16 or Firefox (it cannot launch inside this sandbox: a 180 s `browserType.launch` timeout, the same as tasks 51 and 52).
Completion record: [.claude/completions/2026-10-16-62-workflows-control-api-and-panel.md](../../completions/2026-10-16-62-workflows-control-api-and-panel.md).

What exists:

- **Control API:** `GET /workflows` (definitions with `served` and live counts, executions filtered by state and name, paginated), `GET /workflows/executions/:id`
  (state, definition graph, first page of steps with for-each aggregate counts, children, compensation, payloads cut at 1,024 B in a list and 256 KiB in a detail
  with the job inspector's truncation marker), `GET /workflows/executions/:id/steps` (`iterationOf`, `status`, `name`, `limit`, `offset`), and
  `POST /workflows/executions/:id/actions` with `signal`, `cancel`, `retry-compensation`, `abandon-compensation` and `recover`. "Rollback" is `cancel` for a live
  run and `retry-compensation` for a stuck rollback. `docs/openapi.yaml` describes all of it (a test compares routes and spec).
- **Safety:** `operator` role; `expectedVersion` required (409 `version_conflict` with `expectedVersion` and `actualVersion`); `cancel` and
  `abandon-compensation` need `confirm` equal to the run id (400 `confirmation_required`); a terminal run is 409 `execution_terminal`; every mutation is one
  audit row `POST /workflows/executions/:id/actions` with target `id=<id> workflowAction=<name>` and no event, payload or reason.
- **Definitions:** workers announce `(name, hash, revision, graph)` every `announceMs` into `qcloud_workflow_definitions` (migration 10). The list marks a definition
  served when a worker announced it within `QCLOUD_API_WORKFLOW_SERVED_MS` (120 s) and warns (`unserved_definition`) when live runs use a hash nobody serves
  (migration 11 is the partial index behind that count).
- **Capability:** `features.workflows` is true from migration 10 on unless `QCLOUD_API_WORKFLOWS=false`; the panel hides the page and the Job Inspector link otherwise.
- **Panel:** the Workflows page (overview of definitions, filtered paginated list, URL state), execution detail (summary, steps timeline with for-each counts
  and a paged, status-filtered drill-down, definition graph, payloads), signal form, typed-confirmation dialogs, rollback view; a link from a workflow job in
  the Job Inspector to its run; a demo-mode backend. No Qelay-server-only agent code is used.
- **Closed the task 61 gap:** the tick skips `waiting` runs on purpose; `recover` (one run) repairs a waiting run whose awaited signal is recorded but whose resume job was lost.

Acceptance:

- *The e2e passes:* `workflows.e2e.ts` has six tests (signal to completion; cancel with typed confirmation and rollback; failing step with rollback; stuck
  rollback retried after repair; viewer sees no buttons, a forced action is 403, a stale version is 409 and nothing moved; a 10,000-item for-each). 6 of 6 on
  Chromium and on WebKit; the whole Chromium suite is 35 of 35.
- *Stale `version` and terminal runs:* all five actions are refused at a stale version with nothing changed, and a terminal run is refused with `execution_terminal`
  (`workflows.actions.test.ts`, the e2e). The fence is a compare-and-set for `cancel` and `recover` and a read check for the other three; `docs/limits.md` section 13 says so.
- *10,000-item for-each:* the detail carries one entry with `{ iterations, byStatus }` made by the Control API from the run's step records; iterations come 25 per page through `iterationOf`
  with an optional status filter (the response is bounded, the read is the whole run: measured: 10,000 iterations are 1.1 MB stored and a 5 ms read, 50,000 are 5.6 MB and 20 ms) (`workflows.fanout.test.ts`, panel `workflow-steps`, the e2e).
- *Audit:* one row per mutation, no payload; the e2e reads the rows back and checks that an input value is not in them.

Run: `bun run typecheck`, `lint`, `format:check`, `architecture` clean; `bun test packages/control-api packages/panel --grep workflow`: 88 pass (48 + 40);
`bun run test:e2e --grep workflow` (the Playwright specs through the same runner): Chromium and WebKit 6 of 6; `bun run test:model`: 31 pass. Full gate (DB, Pub/Sub emulator and ElasticMQ required): 4,917 pass, 29 skip (Docker-only suites), 1 fail, which was the
loopback-binding policy test after the `runtime.ts` split; it was fixed and the file, both packages and the static checks rerun clean (details in the completion record).

Design findings (also in `docs/spikes/06-phase0-gate.md`, 2026-10-16 task 62): the Control API cannot run a step, so an action is a claim and a publish (a failed
publish leaves a claimed run that the tick republishes after `QCLOUD_WORKFLOW_IDLE_MS`, up to five minutes); the fence is two different guarantees; the store lost a
`signal_wait` when a run was cancelled or recovered while parked (`restoreSignalWait`, found by a failing contract test first); the panel shows payloads to every `viewer`.

Owed: the Docker-backed gate and the PG 16 snapshot and EXPLAIN for migrations 10 and 11; Firefox and the CI `e2e` job; real Pub/Sub and SQS runs (D9); the
independent review of payload exposure belongs to task 72.
