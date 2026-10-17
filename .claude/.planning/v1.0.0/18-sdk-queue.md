# 18 — SDK: Queue (producer)

**Status:** done · **Depends on:** 12, 16 · **Phase:** 1

## Goal

The producer side of `qelay-cloud`: a `Queue` class with the Qelay/BullMQ-shaped API subset from D6, so existing producers can switch with an import and a connection change.

## Scope

In: `Queue` methods, option mapping, ringing after commit, the connection options, typed errors, tests, an API-compatibility table.
Out: `Worker` and `QueueEvents` (task 19), `FlowProducer` (task 50), and everything D6 excludes.

## Reference

`../qelay/src/client/queue/` (`queue.ts`, `operations/`, `helpers.ts`, `dlq*.ts`, `rateLimit.ts`), `../qelay/src/client/types/` (`options.ts`, `job.ts`).

## Gate decisions (task 06)

Binding, and small: the settled interfaces (task 10) change only how step 4 reads. Evidence:
[docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

- `enqueue` returns the rings; the SDK rings and then calls `markRung` per bell. The store never rings, and no
  absolute time crosses the boundary (relative `deliverAfterMs` only).
- A connection option for the direct `listenUrl` (task 16) and a pooler mode (task 11) pass through to the store and
  the local transport. The SDK does not interpret them.
- The repair path is the **tick**, not a "sweep" (DESIGN.md section 3).

## Steps

1. **Connection options:** `{ databaseUrl | database, transport, namespace }`. The Qelay `host`/`port`/`embedded` options are rejected with a clear error pointing at the migration guide.
2. **Methods (D6):** `add`, `addBulk`, `getJob`, `getJobs`, `getJobCounts`, `getJobByCustomId`, `pause`, `resume`, `isPaused`, `drain`, `clean`, `obliterate` (these three obey the panel's fail-closed rules),
   `removeJob`, `promote`, `updateData`, `changePriority`, `changeDelay`, `setRateLimit`/`clearRateLimit`, `setConcurrency`/`clearConcurrency`, DLQ reads, `close`.
3. **Option mapping:** supported subset per task 10; `UnsupportedOptionError` at call time for anything else. No silent ignoring.
4. **Ring after commit:** `add`/`addBulk` call `store.enqueue`, which returns the rings (`{ bell, dueInMs }`) for the jobs that need one; then `transport.ring(items)` with the relative delay; then `store.markRung` for exactly the items whose `RingResult` was `ok`. A ring failure, whole or partial, is logged, counted in a metric and swallowed; the enqueue still succeeds (invariant 3), and the unrung jobs wait for the tick. A delay longer than the transport's `maxDeliverDelayMs` is not an error: the job stays unrung until the tick rings it inside the window.
5. **Idempotent add:** dedup and custom-ID outcomes return the existing job with a `duplicated` marker, matching Qelay.
6. **Job proxy:** returned `Job` objects expose the instance methods Qelay's do for the supported subset (`updateProgress`, `log`, `getState`, `remove`, `promote`), implemented through the store.
7. **API compatibility table** in `docs/compat.md`: each Qelay `Queue` method as supported / supported with differences / not supported, with the reason.
8. Tests (local transport + Postgres): every method; ring-failure injection with the memory transport; dedup and custom-ID races through the public API; unsupported options throw.

## Acceptance

- A Qelay example producer (`../qelay/examples`) runs unchanged apart from import and connection options.
- Ring failure injection, including a half-failed batch, never fails an `add`, and the job is picked up by the tick (task 20 owns the tick; here assert `rung_at` stays null for exactly the bells that failed).
- `docs/compat.md` covers every `Queue` method in Qelay's `queue.ts`, none left unclassified.
- No Qelay TCP/embedded code is imported anywhere in the package.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/sdk --grep queue
```

## Risks / notes

- Being "close" to Qelay's API is a trap if differences are silent. The compat table and typed errors are the mitigation; keep them current.
- `getJobs` and `getJobCounts` on large queues need index-backed, paginated reads (task 15). Do not add unbounded variants.

## Result

**Done locally, on PostgreSQL 18.6 and the in-memory transport, not on the Docker PG 16 of CI.** The user told me to defer Docker-backed
runs until every task is done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule (the runs here set it, against the
local PG 18); the PG 16, PgBouncer, TLS, `bun run test:model` and DDL-snapshot runs are owed at the end. No real cloud resource was used.
Details of the findings: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "The Queue SDK and the store's control
facet (task 18)", items (a) to (g), and a dated amendment.

**Built**

- **The store half** (`packages/store-postgres/src/store/`), which the producer API needed and the store did not have: `jobDetails.ts` (one job
  in full, and up to 1,000 by id), `jobEdits.ts` (`updateData`, `changeDelay`, `updateProgress`), `progress.ts` (`normalizeProgress`),
  `pendingClean.ts` (`drain`, `cleanPending`), `queueControl.ts` (`remove`, `obliterate`), `remove.ts`, `controlApi.ts` (the `store.control`
  facet), and migration v3 (`progress`, `progress_message`; the journal's `progress` and `obliterated` events). `FlowProtectedError`
  and `JobStateError` are new in `@qelay-cloud/core`. Tests: `control.{details,edits,remove,obliterate,drain}` and
  `progress.normalize` (53 tests), plus rows in `schema.planned.ts` and `schema.indexes.test.ts` for the new query paths.
- **`packages/sdk/src/`** (13 files, each under 300 lines): `options.ts` and `runtime.ts` (the connection options and the owned or borrowed
  store), `ring.ts` (the ring after commit), `add.ts`, `job.ts` and `jobOps.ts` (`Job` and what it does by id), `read.ts`, `admin.ts`,
  `config.ts`, and the class chain `queueJobs.ts` → `queueReads.ts` → `queue.ts`.
- **Tests** (`packages/sdk/test/`, 98 tests in 8 files): `queue.options` (15), `queue.add` (13), `queue.ring` (9), `queue.jobs` (17),
  `queue.reads` (11), `queue.admin` (23), `queue.replay` (6), `queue.compat` (4), over a `FlakyTransport` and a recording logger and metrics sink.
- **Docs:** `docs/compat.md` (every method of Qelay's `Queue`, the connection options, `Job`, the job options), `docs/PORTING.md` (ten rows),
  the gate document.

**Design problems found and how they were handled**

- **Job ids are unique per namespace, not per queue.** The SDK scopes every id-based call to its own queue and refuses a custom id that a live
  job of another queue holds. The store still replaces a *finished* job of the same id in another queue (`plan.ts`); **not fixed here**,
  recorded in the gate document, item (a), with the two ways to close it. This is a store finding, not a change to the design.
- **`attemptsMade` is 0 while a job runs and after a clean completion.** The store counts failed and stalled attempts only, as Qelay does.
  The test that expected 1 was wrong and was corrected (item (b)).
- **The producer API needed a store facet that did not exist.** The task plan lists `removeJob`, `updateData`, `changeDelay`, `drain`,
  `clean`, `obliterate`, progress and one-job reads; none was in the store after task 15. They were built first (the store half) with
  their own tests. Migration v3 is the only schema change, and it adds only a defaulted column and a nullable one.
- **A ring failure in `promote` or `changeDelay` has the same rule as in `add`:** the change is committed, the failure is logged and
  counted, and the tick rings the job.

**Decisions on the gate's open points**

- No Qelay `host`, `port`, `connection`, `embedded`, `dataPath`, `autoBatch` or `prefixKey`; each is refused with a reason that points at
  `docs/compat.md`. `defaultJobOptions` is kept. `databaseUrl` or `database` passes straight to the store (pooler mode and the direct
  `listenUrl` included); the SDK reads none of it.
- Every method is async, with the `*Async` names of the upstream TCP client as one-line twins.
- `getJobs` takes an options object, `end` exclusive, default 100, at most 1,000 per page; `-1` and `asc` throw. `getJobCounts` shows
  the paused view. There is no unbounded read.
- The stall config takes `maxStalls` only and the DLQ config `maxEntries` and `maxAge` only; any other key throws.
- The plan's method names (`removeJob`, `promote`, `updateData`, `changePriority`, `changeDelay`, `setConcurrency`, `clearConcurrency`,
  `setRateLimit`, `clearRateLimit`) exist as aliases of Qelay's names, so neither spelling fails.
- `close()` closes a store the queue opened and leaves a `store` passed in, and the transport, to the caller.

**Acceptance**

- *A Qelay example producer runs unchanged apart from import and connection options.* **Partly, as far as it can today.**
  `queue.replay.test.ts` replays the producer calls of `examples/mqtt-bridge` (`add` with `{ attempts: 5 }`, then `close`, including a
  broker outage) and of `examples/postgres-multibroker` (two queue objects on one queue, the same custom id added by both at once, the
  global limits) through the public API. The example scripts themselves were **not** run: they also use `Worker`, `QueueEvents` and
  `FlowProducer` (tasks 19 and 50). The multibroker example passes `{ durable: true }`; this `Queue` refuses it by name, and a test asserts the
  reason. That is the one place a producer needs a change beyond import and connection.
- *Ring failure injection, including a half-failed batch, never fails an `add`, and `rung_at` stays null for exactly the failed bells.*
  **Done.** `queue.ring.test.ts`: a throwing ring, a half-failed batch (four custom ids, the broker refuses `j1` as `rejected` and `j3` as
  `unreachable`: `rung_at` is set for `j0` and `j2` only), a delay beyond the window, a batch split by `maxRingBatch` with one chunk failing, a store that cannot record the
  rung bells, a broken logger and metrics sink, and a duplicate that is never rung. The tick itself is task 20.
- *`docs/compat.md` covers every `Queue` method, none left unclassified.* **Done and enforced:** `queue.compat.test.ts` carries the 134
  public names of Qelay's class chain and fails when one, or a public method of this `Queue`, is missing from the file. I checked it
  fails by renaming two entries.
- *No Qelay TCP or embedded code is imported anywhere in the package.* **Done:** a source scan in `queue.options.test.ts` reads every
  `src/*.ts` and fails on an import of `qelay` or `@qelay/`, of `net`, `tls`, `dgram` or `http` (with or without `node:`), or of a path ending
  in `client` or `embedded`; `package.json` depends on `core` and `store-postgres` only.

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (374 files within the 300-line cap).
- `bun test ./packages/sdk` with `QCLOUD_REQUIRE_DB=1` on PG 18.6: 98 pass, 0 fail.
- The store control tests and `schema.indexes.test.ts`: 122 pass, 0 fail. The whole of `store-postgres`, `core`, `transport-local`,
  `transport-gcp` and `sdk` together ran 1,384 pass, 21 skip, 0 fail before the last tests of this task were added.

**Not done / not verified**

- The Docker PG 16 run with `QCLOUD_REQUIRE_DB=1`, PgBouncer, TLS, ElasticMQ, `bun run test:model` and the `fleet` spike. `test:model`
  matters here: `drain`, `clean`, `obliterate`, `remove` and the edits are new transitions of the store.
- The DDL snapshot and the `EXPLAIN` plans were produced on PG 18; the PG 16 regeneration and the plan recheck (the group-state delete
  plan asserts `qcloud_group_state_rotation_idx`) are owed.
- The panel's destructive buttons stay closed until task 31 (confirm field, `expectedVersion`, operator role).
- DLQ retry, groups, schedulers, deduplication-key calls, `getMetrics` and the rest of the "Not supported" list are recorded, not built.

**Next:** task 19 (SDK `Worker` and `QueueEvents`). It rings after `complete` and `fail` as `add` does, takes its concurrency slot before the
handler's first `await`, builds its store with the worker's lease length, and reads the journal's `progress` events.

