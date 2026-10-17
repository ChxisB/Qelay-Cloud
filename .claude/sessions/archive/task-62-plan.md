# Task 62 working plan (session file, never auto-load)

Design (decided 2026-10-16, after task 61):
- The Control API holds no workflow definitions and runs no engine. An operator action is CLAIM + PUBLISH:
  a version-checked write on the run (409 on stale), then a `wf:step` job on the engine queue that a worker
  holding the definition executes. Same shape as the tick's `take()` in packages/maintenance/src/workflowSweep.ts.
- Actions: signal | cancel | retry-compensation | abandon-compensation | recover (single run; also closes task 61's
  "waiting run with a recorded signal" gap). "rollback" of a live run = cancel.
- Step job format moves to core (`workflowJob.ts`): job name, default queue, StepJobData (+ new `operator` field).
  sdk, maintenance and control-api import it; tickFormat test re-pointed.
- Definitions registry: migration 10 `qcloud_workflow_definitions` (namespace, name, hash, revision, graph JSON, first/last seen).
  Engine.register upserts + refreshes `last_seen_at`; API reads; "served" = last seen within TTL.
- List = scalar projection (no steps decode) + counts by state; detail = paginated steps, fan-out aggregates, truncated payloads.
- Capability `features.workflows` = jobs deps present AND workflow tables migrated AND not turned off.
- Panel: replace agent-based workflow repo with Control API repo (like flows in task 51). Archive browsing not supported (store has no archive read).

Stages (tick off):
 A1 core workflowJob.ts + re-point sdk/maintenance + tickFormat         [x]
 A2 migration 10 + store defs API + memory + contract + snapshot + index rows [x]
 A3 store summaries/countByState + contract + index rows                 [x]
 A4a sdk: operator step jobs (executorOperatorJob.ts + workflow.operator.test.ts) [x]
 A4b engine registers defs + refresh timer                              [x]
 B0 liveDefinitions() + migration 11 partial index + contract + planned row [x]
 B  control-api: workflowModel.ts, routes, capability, audit, openapi, tests [x] (incl. settings, openapi, version pin; restoreSignalWait fix)
 C  panel: domain/app/infra/ui, demo data, tests                         [x] (1350 panel tests pass)
 D  e2e + docs (compat, limits, DESIGN.md?) + Result + completion + spike + gate [x]
