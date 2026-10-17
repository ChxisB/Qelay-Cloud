# 50 — FlowProducer: parent/child flows

**Status:** done locally (PostgreSQL 18, Pub/Sub emulator and ElasticMQ only; PG 16 and Docker runs are owed) · **Depends on:** 22 · **Phase:** 4

## Goal

Flows on Postgres dependency tables: a parent job that waits for its children, with correct handling of child failure, removal and cancellation, behaving the same on every transport.

## Scope

In: `FlowProducer`, store support for dependencies and `waiting-children`, parent promotion, failure policies, flow reads for the inspector, tests and model-harness coverage.
Out: the Control API endpoints and panel pages (task 51); the Workflow Engine (Phase 5).

## Reference

Client: `../qelay/src/client/flow.ts` and its siblings `flowAtomic.ts`, `flowPlan.ts`, `flowPush.ts`, `flowReader.ts`, `flowOptions.ts`, `flowResults.ts`, `flowTypes.ts`, `flowJob*.ts`.
Postgres: `../qelay/src/infrastructure/persistence/postgres/{dependencyPromotion,dependencyDestruction,flowFailures}.ts`.
Model test: `../qelay/test/model-based/flow-producer-model.test.ts` with `flow-commands.ts`.

## Steps

1. **Store:** `addFlow(tree)` writes the parent and all children in **one transaction** (parent in `waiting-children`; children `waiting`/`delayed`/`prioritized`), with the dependency rows in `qcloud_dependencies` and `qcloud_flow_failures`. Support nested flows and depth and size limits (reject beyond them).
2. **Ring after commit:** only claimable children are rung; the parent is rung when promoted. A parent never receives a doorbell while it has unfinished children.
3. **Promotion:** when the last child completes, the parent moves to `waiting`/`prioritized`/`delayed` in the **same transaction** as that child's completion (extend task 14's hook), sets `rung_at = NULL`, and the tick or the completing worker rings it. Idempotent under concurrent completions of the last two children.
4. **Failure policies:** port Qelay's options (`failParentOnFailure`, `ignoreDependencyOnFailure`, `removeDependencyOnFailure`, `continueParentOnFailure`) with their exact semantics, recording failed children in `qcloud_flow_failures` so the parent's processor can read them (`getFailedChildrenValues`, `getDependencies`).
5. **Operator interactions:** removing or cancelling a child, retrying a failed child, promoting or removing a parent, all keep the dependency tables consistent; define each outcome and test it.
6. **SDK:** `FlowProducer.add` and `addBulk`; `Job.getChildrenValues`, `getDependencies`, `getFailedChildrenValues` for processors.
7. **Model harness:** port the flow model from upstream: random trees, random completions and failures, crashes and operator actions; invariants: a parent runs only after all non-ignored children are terminal; a parent runs at most once; no orphaned dependency rows.
8. **Document** the supported options in `docs/compat.md` and the differences from Qelay's flows.

## Acceptance

- The flow model test passes with the standard and deep run counts.
- Concurrent completion of the last two children promotes the parent exactly once (test, 1,000 repetitions).
- Each failure policy has a test showing the parent's resulting state and the recorded failures.
- Operator actions never leave a dependency row pointing at a missing job or a parent stuck in `waiting-children` with no pending children.
- Works on the local transport and on both cloud-transport emulators with injected duplicate doorbells.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres packages/sdk --grep flow
bun run test:model
```

## Risks / notes

- This is the feature that most justified Postgres as the source of truth. Do not shortcut it into per-queue ordering tricks.
- Deep or very wide flows create large transactions; the depth and size limits are a safety feature, so state them in the docs.
- Replay-safety: a flow submitted twice with the same custom IDs must not create two parents. Test it.

## Result

**Done locally. Nothing was applied and no real cloud was contacted.** Flows run on the Postgres dependency tables, behave the same
on the memory, Postgres, Pub/Sub-emulator and ElasticMQ transports, and every Acceptance line is true. What ran is under "Run" and
what did not under "Not run". Design decisions and the checks of upstream's behaviour are in the task 50 amendment to
[docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

**Built**

- **Core** `packages/core/src/flow.ts`: flattening a tree, the four failure policies, the limits (depth 100, 1,000 jobs per flow) and the
  read shapes; `FlowError` (`FLOW_INVALID`); the flow-only options refuse a plain add and point at `FlowProducer`.
- **Store** (`packages/store-postgres`): migration 6 (`on_failure` on `qcloud_dependencies`); `flows.add` writes a flow in one
  transaction (parent `waiting-children`, children `waiting`, `prioritized` or `delayed`); the terminal hook of `completeJob`, a
  terminal `failJob` and a terminal `recoverExpired` settles the parent in the same transaction, under a `FOR UPDATE` lock on the
  parent row; a released parent gets `rung_at = NULL`, a `promoted` event and a ring. Failures are recorded in
  `qcloud_flow_failures`. Reads: `childrenValues`, `dependencies`, `failedChildren`, `ignoredFailures`, `tree` (bounded).
- **Operator actions** each have a defined outcome and a test: cancelling a child releases its edge; cancelling or removing a parent
  deletes its edges and failures and leaves its children as plain jobs; remove, clean, drain, obliterate, DLQ purge and eviction refuse
  a job whose live parent still holds an edge.
- **SDK**: `FlowProducer` (`add`, `addBulk`, `getFlow`, `waitUntilReady`, `close`, `disconnect`), `planFlow` (every flow of a bulk is
  checked before any is written), `Job.getChildrenValues`, `getDependencies`, `getFailedChildrenValues`,
  `getIgnoredChildrenFailures`. A replay with the same custom ids returns the live root with `created: false`.
- **Model harness** `test/model/flow/` (10 files, each under 300 lines): its own `fc.commands` harness against a reference model written
  from the specification, 9 checks, 14 coverage rules asserted at the standard run count, and 4 planted bugs that must be found, with a
  history of 8 commands or fewer, and replayed.
- **Scenarios**: 4 flow scenarios across the 4 transports. **Control API**: `FlowError` is 400 `flow_invalid` (no endpoint before task 51).
- **Docs**: `docs/compat.md` (a `FlowProducer` section), `docs/limits.md`, `docs/PORTING.md` (6 rows, "Adapted from" comments in 8
  files), `docs/transports.md` regenerated.

**Run**

- The gate with Postgres and both emulators up: typecheck, lint, format and architecture clean; `bun test` 4,084 pass, 29 skip, 1 todo,
  0 fail (429 files, 863 s). The 29 skips are the PgBouncer and TLS suites.
- `bun test packages/store-postgres packages/sdk --grep flow`: 103 pass, 20 skip, 0 fail. `bun run test:model`: 22 pass.
- The flow model at the standard count (200 runs of up to 60 commands, about 18 s) and deep (1,000 runs of up to 100, 200 s): no
  difference between the store and the model. 1,000 repetitions of the last two children completing together: one promotion each time.
- The first full run failed (an options message, two exact-change assertions and 235 panel tests after one stalled test); see the
  completion doc. Fixed or not reproduced, and the rerun was clean.

**Not run**

- A flow on a real Pub/Sub or SQS (D9). PG 16, PgBouncer, TLS and compose-image runs (Docker is deferred to the end). The migration 6
  snapshot and the EXPLAIN rows for the flow query paths were generated on PG 18 and are to be redone on PG 16.
- The 1,000-job ceiling was not measured against lock counts (upstream allows 10,000).

**Decisions and differences** (all in the gate amendment and `docs/compat.md`)

- Edges persist after completion and readiness comes from the completion records, as upstream does. Failure precedence is `fail`, then
  `continue`, `ignore`, `remove`; a late failure still records or drops its edge, and a late `fail` does nothing.
- A failed child with no policy keeps its parent waiting until an operator acts. DLQ retry is closed in v1.0.0, so task 51 added the
  flow-scoped answer: `retry-failed` (the child is run again) and `promote` (the parent is released, the failure kept as `ignore`). A child with `removeOnFail` must set a policy; dedup is refused in a flow; a parent cannot be in
  a group; a custom id with `:` is refused.
- A failed parent is written to the DLQ as `explicit_fail` and counts no `failed` metric. `getDependencies` counts a failed no-policy
  child as unprocessed (upstream: processed, null). `addBulk` is per-flow transactions, not atomic across flows.
- A parent released by a cancel or an expiry is rung by the tick, not at once.

**Found and fixed**: a bare array parameter to `sql.unsafe` (use `sql.array`); a null-parent climb in `resolveFlows`; `addBulk` writing
a flow before a later flow's option error; a lost late failure.
