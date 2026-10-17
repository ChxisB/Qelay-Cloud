# 60 — Workflow store on Postgres

**Status:** done locally (PG 18, emulators only; PG 16 snapshot and EXPLAIN owed) · **Depends on:** 50 · **Phase:** 5

## Goal

A Postgres-backed workflow store, replacing upstream's SQLite-only `WorkflowStore`, with the same semantics: durable execution records, child tracking, signals, wait expiry, recovery and listing.

## Scope

In: the store interface extracted from upstream, the Postgres implementation, migrations, concurrency fencing, tests and model-harness coverage.
Out: the engine and SDK surface (61), the Control API and panel (62).

## Reference

`../qelay/src/client/workflow/store.ts` (299 lines, concrete class on `bun:sqlite`) plus `storeCodec.ts`, `storeExecutionCodec.ts`, `storeListing.ts`, `storeMaintenance.ts`, `storeSignals.ts`, `storeWaitExpiry.ts`, `executionFence.ts`, `executionTypes.ts`, `recovery.ts`.
Model tests: `../qelay/test/model-based/workflow-model*.ts`, `workflow-commands.ts`, `workflow-invariants.ts`, `workflow-child-invariants.ts`, `workflow-rollback-invariants.ts`.

## Steps

1. **Extract an interface** `WorkflowStorePort` from the public methods of upstream's `WorkflowStore` (`upsert`, `get`, `updateState`, `childrenByName`, `listActiveByName`, `listRecoverable`, signals, wait expiry, listing, maintenance). It lives in `core`; the engine depends on the port, never on a concrete store.
2. **Schema** (new migration): `qcloud_workflow_executions` (id, name, state, definition hash, input, output, error, version, timestamps, parent execution), `qcloud_workflow_steps` or equivalent, `qcloud_workflow_signals`, wait-expiry indexes, and the listing indexes upstream's queries need. Mirror upstream's SQLite columns, then adapt types (timestamps as BIGINT ms like the rest, payloads as msgpackr BYTEA).
3. **Fencing:** port `executionFence.ts` semantics onto `version` compare-and-set, so two engine instances cannot both advance one execution; stale writers receive a typed error and stop.
4. **Signals and waits:** deliver and consume signals transactionally; wait expiry scanned with `FOR UPDATE SKIP LOCKED` from the tick (task 20 gains a step in task 61).
5. **Recovery:** `listRecoverable` returns executions whose last progress is older than a threshold or whose owner lease expired; resume is idempotent.
6. **Listing and maintenance:** paginated listing by state and name, retention of terminal executions in bounded batches.
7. **Tests:** a contract suite run against a fake in-memory store and the Postgres store; port upstream's workflow store tests; a concurrency test with several engine instances racing on one execution.
8. **Model harness:** adapt `workflow-model-harness.ts` to drive the Postgres store through the port; keep upstream's invariants (children, rollback and general).

## Acceptance

- The workflow model test passes against the Postgres store at the standard and deep run counts.
- Two engine instances racing to advance one execution never both succeed (test, 1,000 repetitions).
- No `bun:sqlite` import remains in the ported code or its dependencies.
- Every query used by listing and recovery is backed by an index (plans recorded in the Result).
- `docs/PORTING.md` lists the ported modules.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres --grep workflow
bun run test:model
```

## Risks / notes

- This is the most uncertain estimate in the plan: upstream's engine is about 40 modules with intricate rollback and compensation rules. If the port stalls, apply the cut in task 73 (ship v1.0.0 without workflows) rather than shipping something half-correct.
- Keep the port faithful first. Behaviour changes belong in a separate, reviewed step.

## Result

**Done locally on PG 18.6. Nothing was applied and no real cloud was contacted.** The engine's persistence port exists, an in-memory reference and a
Postgres store implement it, and one contract suite, a race suite, a limits suite and a differential model hold the two together. Every Acceptance
line is true; what ran is under "Run" and what did not under "Not run". Design decisions are in the task 60 amendment to
[docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md); the long form is
[.claude/completions/2026-10-16-60-workflow-store.md](../../completions/2026-10-16-60-workflow-store.md).

**Built**

- **Port** (`packages/core/src/workflow{Types,Store,Rules,Memory,MemoryRows}.ts`): `WorkflowStorePort`, async, extracted from upstream's concrete `WorkflowStore`;
  the rules both stores share (`workflowRules.ts`); `MemoryWorkflowStore(clock)` as the reference. Errors: `ExecutionStaleError`, `ExecutionExistsError`,
  `SignalRejectedError`.
- **Schema:** migration 9 `qcloud_workflow_executions` and `qcloud_workflow_executions_archive`; two new tables, so an old worker is untouched. Values are
  codec-encoded `BYTEA`; the wait (`wait_event`, `wait_deadline`, `wait_lease_until`) and `version` are real columns.
- **Store** (`packages/store-postgres/src/store/workflow{Crud,Signals,List,Retention,Rows,Api}.ts`): `save`, `get`, `update` (version compare-and-set),
  `remove`, `findChild`, `recordSignal`, `parkForSignal`, `restoreSignalWait`, `claimDueWaits` (`FOR UPDATE SKIP LOCKED` over a durable deadline with a
  lease), `expireWait`, `list`, `listActive`, `listRecoverable`, `cleanup`, `archive`, `getArchivedCount`. `PostgresStore.workflows` composes them.
- **Fencing:** `update` writes only when `version` is the one the caller read, so of two engines that read one run exactly one write lands and the other
  gets `ExecutionStaleError` carrying the version it found.

**Acceptance**

- *The workflow model test passes at the standard and deep run counts:* `test/model/workflow/` (the Postgres store against the reference on one virtual
  clock, five checks WF1 to WF5, 5 planted bugs it must find) passes in `bun run test:model` and in a 2,000-run by 100-command deep run.
- *Two engines racing to advance one run never both succeed:* `workflow.races.test.ts`, 1,000 rounds, exactly one update lands, the other is a stale
  refusal reporting `actual = 1`, and the stored run holds the winner's step only. The same file races signals, a signal against a timeout, four claimers,
  and retention against recovery.
- *No `bun:sqlite` import remains:* none in the new files; the store is `Bun.SQL`.
- *Every query is backed by an index:* 12 workflow rows in `schema.planned.workflow.ts`, checked by `schema.indexes.test.ts` (109 pass). Plans on 12,000
  runs plus 3,000 archived (cost, then the node):

  | Query | Plan |
  | --- | --- |
  | get, update, remove | Index Only Scan `pkey`, cost 8.3 |
  | list: newest first | Limit > Index Only Scan `created_idx`, 8.6 |
  | list: one workflow | Limit > Index Only Scan `name_idx`, 13.9 |
  | list: one state | Limit > Index Only Scan `state_idx`, 30 |
  | list: one workflow and state | Limit > Index Only Scan `name_state_idx`, 76 |
  | listActive | Sort > Bitmap Heap Scan > Bitmap Index Scan `name_state_idx`, 495 |
  | recovery, one state | Limit > Index Only Scan `progress_idx`, 185 |
  | recovery, best of a range per state | Limit > Sort > Nested Loop > Function Scan > Limit > Index Scan `progress_idx` |
  | retention | Limit > Sort > Nested Loop > Function Scan > Limit > Sort > Bitmap Heap Scan > Bitmap Index Scan `progress_idx`, 463 |
  | findChild | Limit > Index Only Scan `child_idx`, 8.3 |
  | claimDueWaits | Limit > LockRows > Index Scan `wait_idx`, 11.9 |
  | getArchivedCount | Aggregate > Bitmap Heap Scan > Bitmap Index Scan `archive_pkey` |

  The recovery statement's estimated cost (45,380, one range per state through a lateral) is high because the planner prices the lateral for every
  state; it was measured (below) rather than trusted.
- *`docs/PORTING.md` lists the ported modules:* ten rows, from the types to the model.

**Measured** (PG 18.6, one machine, 1,000,000 runs seeded in 44 s with `EXPLAIN (ANALYZE, BUFFERS)`)

| Query | Execution |
| --- | --- |
| list, newest first, a page | 0.04 ms |
| list, one state | 0.08 ms |
| recovery, one state, to the limit | 0.65 ms |
| recovery, the best of a range per state | 2.5 ms |
| retention pick | 0.82 ms |
| findChild | 0.02 ms |
| claimDueWaits | 0.19 ms |
| listActive for one workflow with about 200,000 runs | 101 ms (unbounded, as upstream's is) |

Every bounded query is under 3 ms. `listActive` returns every live run of one workflow, so it grows with them; task 61 decides how often the engine calls it.

**Run** (PG 18.6, Pub/Sub emulator, ElasticMQ 1.7.1)

- `bun run typecheck`, `bun run lint` (no errors), `bun run format:check` and `bun run architecture` are clean.
- `bun test packages/store-postgres --grep workflow`: 100 pass. `bun test test/workflow`: the in-memory contract, 67 tests, in a group of 179 that match the path.
  The same 67-test contract passes on the Postgres store (`workflow.contract.test.ts`).
- `bun run test:model`: 28 pass, 0 fail (43 s), including the 6 workflow tests.
- Races (8) and limits (7): pass, and were mutation-checked (a rule changed in the source, the test seen to fail, the source restored and the diff checked).
- The full gate with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1`: 4733 pass, 29 skip (PgBouncer and TLS suites, Docker only), 1 todo, 0 fail, 462 files, 977 s.
  An earlier run of the gate was invalid (the host disk filled up, ENOSPC) and was rerun after freeing space.

**Not run (owed)**

- Docker: PG 16, PgBouncer, TLS Postgres, the ElasticMQ compose image. The PG 16 schema snapshot and the EXPLAIN recheck for migration 9 (and 6, 7, 8)
  are owed with the Docker-backed gate.
- No real cloud. Nothing here needs one.

**Found and fixed**

- `claimDueWaits({ limit: 2 })` returned three rows. `UPDATE … FROM (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) due` can re-evaluate the subquery, so the
  limit and the lock were not honoured. Fixed with `WITH due AS MATERIALIZED (…) UPDATE … FROM due`, under a failing contract test first. **The repo's other
  `SKIP LOCKED` sites were not audited for this shape.**
- The model's first fifth check ("an id is never in both tables") was wrong: an id may be archived, saved again and archived again by design. It is now
  "the archive only grows" (WF5).
- `parkForSignal` threw synchronously for a deadline that is not a whole number; it is an async function now and rejects.

**Decisions and deviations** (each is in the spike amendment)

- Signals stay a column of the run row, as upstream has them; the `output` column the plan sketched was not built (the run's last step holds it).
- The owner lease of step 5 became `idleMs` on `listRecoverable` (0 = no cutoff). A lease would need a heartbeat from the engine; recovery by idleness
  needs none, and the version compare-and-set makes a second resumer harmless.
- `update` is a version compare-and-set, where upstream's was a blind write. This is a behaviour change from upstream; the engine (task 61) must handle
  `ExecutionStaleError` and copy `version` back after `expireWait`.
- The engine-level model (upstream's `workflow-model*` over the whole engine) is task 61's, because the engine is not ported yet. A store-level differential
  model was built here instead.
- The port is async; upstream's was synchronous, so the async ripples into the engine.
- Each encoded column is capped at 16 MiB (`ExecutionTooLargeError`); `failure_reason` is not. The codec no longer preserves cyclic references.
- `getArchivedCount` is a full count of the namespace's archive. `findChild` returns the oldest child.

