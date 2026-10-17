# 61 — Workflow Engine in the SDK

**Status:** done locally (PG 18, emulators only; real clouds not run: needs D9; PG 16 snapshot not needed, no migration) · **Depends on:** 60, 19, 20 · **Phase:** 5

## Goal

Port the Workflow Engine so that workflow steps run as ordinary queue jobs through the SDK, on any transport, with the engine state in the Postgres workflow store.

## Scope

In: the engine, executor, runners (map, for-each, sub-workflow, wait-for), compensation and rollback, recovery, the tick step for wait expiry, the SDK surface, tests and the compat table.
Out: Control API and panel (task 62).

## Reference

`../qelay/src/client/workflow/`: `engine.ts`, `executor*.ts`, `runner*.ts`, `forEachRunner.ts`, `mapRunner.ts`, `subWorkflowRunner.ts`, `waitFor.ts`, `loops.ts`, `compensat*.ts`, `rollbackControl.ts`, `unwindPlan.ts`, `recovery.ts`, `admission.ts`, `definitionGuard.ts`, `emitter.ts`, `eventTypes.ts`, `workflow.ts`, `workflowDecisions.ts`, `stepTypes.ts`, `types.ts`.

## Steps

1. **Port the engine** against `WorkflowStorePort` and the SDK's `Queue`/`Worker`/`FlowProducer`. Remove every dependency on the Qelay TCP client, `bun:sqlite` and the `Qelay` high-level class.
2. **Execution on queues:** each step becomes a job on an engine queue; the engine's executor is itself a worker that advances executions after a step finishes. Steps are idempotent by `(execution id, step id, attempt)` so a duplicate doorbell or a retried step cannot double-advance.
3. **Wait expiry and recovery in the tick:** add steps to `runTick` for expiring waits and resuming recoverable executions. Both are idempotent and bounded.
4. **Compensation and rollback:** port the unwind plan and compensation pass exactly; keep upstream's invariants and run the rollback model tests.
5. **Time:** all timers come from the store's clock where they affect durable state (matching task 13's rule).
6. **SDK surface:** `Workflow`, `defineWorkflow`, `startWorkflow`, `signal`, `getExecution`, `cancel`; document each in `docs/compat.md`, with every unsupported upstream feature listed.
7. **Crash tests:** kill the engine worker between steps and mid-step; the execution resumes exactly once; compensation runs once after a crash during rollback.
8. **Multi-transport:** run the workflow scenarios on local, Pub/Sub emulator and SQS emulator (task 41's runner).

## Acceptance

- The workflow model test and the upstream-derived scenarios pass on all three transports.
- A crash between any two steps leads to exactly one resume and no step executed twice with the same attempt.
- Rollback after a crash during compensation completes exactly once.
- No import of `bun:sqlite`, the Qelay TCP client or the `Qelay` class in the workflow code (architecture rule).
- `docs/compat.md` lists every upstream workflow feature as supported, supported with differences, or not supported.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/sdk --grep workflow
bun run test:model
bun run test:scenarios --suite=workflows --transport=local,gcp-emulator,aws-emulator
```

## Risks / notes

- Largest single port in the plan. Time-box it; at the time-box, record progress and let the user decide between continuing and the task 73 cut.
- Delays inside workflows (timers, waits) inherit the transport's delay limits through the tick; document the resulting precision.
- Do not paper over a failing upstream invariant by weakening it. A real divergence is a design finding (rules in `CURRENT.md`).

## Result

**Done locally**, on PostgreSQL 18.6, the Pub/Sub emulator and ElasticMQ 1.7.1. Docker, PG 16 and the real clouds were not used. Nothing was applied,
pushed or published. Details: [.claude/completions/2026-10-16-61-workflow-engine.md](../../completions/2026-10-16-61-workflow-engine.md).

- **Built:** `packages/sdk/src/workflow/` (41 files, about 4,400 lines): the `Engine` (every node a `wf:step` job on `__wf:steps`, admission rule, per-run
  serialising writer with a version CAS, heartbeat), the executor and runners (steps, retries, parallel, map, for-each, loops, `waitFor`, sub-workflows),
  compensation and rollback (unwind plan ported), recovery, `Workflow`, `defineWorkflow`. `packages/maintenance/src/workflowSweep.ts` is the tick step
  (due waits, recoverable runs). `QCLOUD_WORKFLOW_{QUEUE,BATCH,IDLE_MS,WAIT_LEASE_MS}` in `docs/limits.md`.
- **Acceptance:**
  - *Model and scenarios on all three transports:* `test/model/wfengine` (real engine on Postgres, upstream's invariants I1 to I12) and
    `test:scenarios --suite=workflows` (5 scenarios) pass on memory, Postgres, Pub/Sub emulator and ElasticMQ (20 of 20).
  - *Crash between steps:* `workflow.crash.test.ts` and scenario 4: engine killed after `a` completes, a second one resumes, each body ran once, attempts
    `[1,1,1]`.
  - *Rollback crash:* scenario 5 and `workflow.crash.test.ts`: engine killed at `compensation:started`, the handlers run once each afterwards.
  - *Architecture:* `scripts/check-workflow-boundary.ts` (`bun run architecture`) forbids `bun:sqlite`, the TCP client and the `Qelay` class in workflow code.
  - *Compat:* `docs/compat.md` "Workflow engine" lists every upstream `Engine`, `Workflow`, `EngineOptions` name and the others; `workflow.compat.test.ts`
    fails when one is missing.
- **Verify as run:** typecheck, lint, format:check, architecture clean; `bun test packages/sdk --grep workflow` 48 pass; `bun run test:model` 31 pass;
  `test:scenarios --suite=workflows --transport=local,gcp-emulator,aws-emulator` 20 pass; the full gate (DB, Pub/Sub emulator and ElasticMQ required) 4828 pass, 29 skip (Docker-only suites), 0 fail.
- **Design findings** (also in `docs/spikes/06-phase0-gate.md`): the version fence made a run's own parallel steps stale each other (serialising
  `RunStorage`); a timed wait ends late by the tick interval plus delivery, and never without a tick; a heartbeat is needed (reverses task 60's note);
  the tick skips `waiting` runs, so waiting-with-signal recovery is only `engine.recover()` (open gap, for task 62); after a crash a job is picked up only
  by the tick's re-ring; definition mismatch is refused; sub-workflow polling holds a worker slot; compensation handlers are at-least-once across a crash;
  **three upstream model invariants are relaxed** (failed-without-`rollbackStatus` until settled, a running map record while its node is current, a map
  transform once per engine generation).
- **Not run:** Docker-backed suites, PG 16, real Pub/Sub or SQS (D9). Upstream's whole workflow test suite was not ported, only the scenarios that bear
  on the engine's semantics.
