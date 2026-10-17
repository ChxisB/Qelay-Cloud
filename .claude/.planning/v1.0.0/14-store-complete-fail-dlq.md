# 14 — Store: complete, fail, retry, DLQ, recovery

**Status:** done · **Depends on:** 13 · **Phase:** 1

## Goal

`StateStore.complete` and `fail`, plus stall recovery and TTL expiry: every job reaches a terminal state exactly once,
retries are bounded, exhausted jobs land in the DLQ exactly once, and a crashed worker's job is recovered with its attempt counted.

## Scope

In: completion, failure, retry with backoff, DLQ write and read/purge, lease-expiry recovery, TTL expiry, event writes in the same transaction.
Out: flow-parent promotion (task 50; leave a transactional hook), operator DLQ retry semantics (Control API decides, task 32).

## Reference

`../qelay/src/infrastructure/persistence/postgres/`: `completionLifecycle.ts`, `completionOutcome.ts`, `completionQueries.ts`, `completionEvents.ts`, `batchCompletion.ts`,
`outcomes.ts`, `terminal.ts`, `dlqLifecycle.ts`, `dlqMaintenance.ts`, `dlqRetryPlan.ts`, `recovery.ts`, `expiry.ts`, `lifetimeMetrics.ts`; `../qelay/src/domain/types/dlq.ts`, `stall.ts`.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), spikes 03 and 04 (fault scenarios).

- **Counting rule:** an attempt is counted when it ends without success, on `fail` and on lease recovery. `claim`
  does not count it (task 13). Invariant 5 (retries are bounded) holds under this rule; test the boundary where
  recovery and `fail` race on the last allowed attempt.
- **Every retry and every recovery clears `rung_at`** and returns the ring for the job, with `dueInMs` equal to the
  backoff measured on the database clock. A retried job must never keep the `rung_at` of its previous bell.
- **Recovery belongs to the tick alone.** A later doorbell claims nothing while a dead worker's row is `active`, so
  nothing but the tick can recover it. Worst case until the job runs again is the lease plus two tick intervals,
  because recovery leaves the job `delayed` by its backoff. State this bound in the tests and in the Result.
- **Backoff jitter uses the injected randomness**, not `Math.random`, so a model run is replayable. Jitter stays off
  by default.
- **Every write is guarded by lease token or `version`**, so an `OperationDeadlineError` (outcome unknown) can be
  retried or dropped by the caller with no double effect. Add a test that applies the same `complete` twice and one
  that applies `complete` after recovery took the lease.
- **The doorbell DLQ is not the job DLQ.** Failed jobs live in `qcloud_*` tables and are handled here. A poison
  doorbell in the cloud queue's dead-letter queue is a metric and is never replayed (the tick re-rings every
  claimable job anyway); nothing in this task reads that queue.
- **Store-level DLQ retry (step 7):** task 06 did not agree to it. The default is **not implemented**: DLQ retry
  stays fail-closed, as in the panel today. Reopening it needs the `version` precondition and an entry in this
  task's Result and in task 32.
- **Model harness on the real store is a done-criterion** (condition 1 of the go), including `crash` with the fake
  `Clock` and fault-injected doorbells.

## Steps

1. **Complete:** one transaction: verify `lease_token` + `version`, set `completed` with result and `completed_at`, clear the lease, write the event and metric bucket, bump `version`. A stale token returns a typed `LeaseLostError`.
2. **Fail:** count the attempt, then compute retry or terminal. If `attempts < max_attempts` set `delayed` (backoff) or `waiting`, set `rung_at = NULL` and return the ring (with `dueInMs`) so the doorbell is re-rung, and write a `retry` event. Otherwise set `failed` and write the `dlq_entry` blob, once.
3. **Backoff strategies** as Qelay's job options define them (fixed, exponential, custom function name mapping excluded per D6); document and test the exact delay formula, with jitter off by default.
4. **Unrecoverable failure** flag skips remaining retries.
5. **Recovery:** find `active` jobs with `lease_until < now` (`FOR UPDATE SKIP LOCKED`), count the attempt, then retry or DLQ using the same path as `fail`, clearing `rung_at` on a retry. Only the tick calls it (task 20). Port stall configuration (`max stalls`).
6. **TTL expiry** for pending jobs; mark expired per Qelay's rule.
7. **DLQ reads:** list with limit/offset, stats, purge. Keep the panel's fail-closed stance on retry (task 32 decides what the Control API exposes). Task 06 did not agree to a store-level `retryDlqJob`, so it is not implemented here unless the Result records why (see Gate decisions).
8. Turn on all five invariants in the model harness **on the Postgres store**, including the `crash` command and fault-injected doorbells.
9. Add deterministic `repro-model-*` regressions for any failure the harness finds, before fixing it (Qelay's rule).

## Acceptance

- `bun run test:model` passes with all invariants, including `crash`, with the standard and the deep run counts, **against the Postgres store** (the fake store alone does not satisfy this).
- A retried or recovered job always has `rung_at` null and a ring in the result; a recovered job is not claimable before its backoff.
- A job is DLQ'd exactly once even under concurrent `fail` and recovery on the same expired lease.
- Completion with a stale token is rejected in every interleaving the harness generates.
- Retry delay matches the documented formula for each strategy.
- Events and metrics are written in the same transaction as the state change (verified by a forced-rollback test).

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres --grep "complete|fail|dlq|recovery"
bun run test:model
QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model
```

## Risks / notes

- Race: `fail` by the worker and `recovery` by the tick on the same job. Both must be fenced by `version`; test the interleaving explicitly.
- Qelay's DLQ retry is closed in the panel because there is no atomic generation precondition. Do not reopen that silently; the `version` column is the precondition if it is reopened.
- Do not swallow errors in the event/metric writes. If they fail, the state change must roll back.

## Result

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** The user told me to defer Docker-backed runs until every task is
done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; the Docker run is owed at the end. Details of
every decision: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "Complete, fail, DLQ and recovery
(task 14)".

**Built**

- `PostgresStore.complete` and `fail`, and the public non-interface methods `recoverExpired`, `expirePending`, `purgeExpiredDlq`,
  `listDlqPage`, `dlqStats`, `purgeDlq`. `tick`, `promote`, `changePriority` and `cancel` still reject with `NotImplementedError` (task 15).
- `packages/store-postgres/src/store/`: `backoff`, `retryState`, `policies`, `remove`, `metrics`, `jobRow`, `dlq`, `settle`, `complete`,
  `fail`, `recovery`, `expiry` (new); `context` (`backoff`, `maxMetricBuckets`, `onTerminal`), `events` (the retry, stall and failure
  event kinds), `reads` (duplicate `listDlq` removed) edited. New store options `jitter`, `random`, `maxMetricBuckets`, `onTerminal`.
- Harness (`test/model/`): the Postgres-only command `recover`, and the Postgres target now runs `complete`, `fail` and `recover` too.
- Tests, `packages/store-postgres/test/`: `finishHelpers.ts`, `fail.backoff`, `complete.{basic,atomic}`, `fail.{retry,terminal}`,
  `dlq.limits`, `recovery.{expired,policy,ttl}` (129 tests in these 9 files). `enqueue.basic.test.ts` expects the methods that are
  still pending.

**Design problems found and how they were handled** (none reverses the gate; each is recorded in the gate document)

1. Step 1 of this task asked for a typed `LeaseLostError`; the interface returns `Outcome`, so a lost lease is `{ ok: false, rings: [] }`
   (item a).
2. Recovery is the tick's (task 15), and the tick does not exist: recovery, TTL expiry and the DLQ age purge are public methods of the
   store, and a Postgres-only harness command runs recovery. The tick calls them in task 15 (item b).
3. Upstream records `max_attempts_exceeded` for an unrecoverable failure; this store records `explicit_fail` (item c).
4. Upstream trims the DLQ after commit; here the limit is enforced in the failing transaction, with a documented overshoot of one burst
   under concurrency (item i).
5. Upstream decided retry or DLQ in two places; `settleAttempt` is now the one place for `fail` and recovery (item d).

**Decisions on the gate's open points**

- Counting rule: an attempt is counted on `fail` and on recovery, never on claim. Every retry and recovery clears `rung_at` and returns a
  ring with `dueInMs` equal to the backoff, when it fits `ringWindowMs`.
- Jitter is off by default and takes an injected `random`. Every write is fenced by token and unexpired lease under a row lock and bumps
  `version`. Events, metrics and the terminal hook run in the transaction; any of them failing rolls the whole change back.
- DLQ retry is not implemented (fail-closed). The doorbell DLQ is not read.
- Worst case until a recovered job runs again: the lease plus two tick intervals (recovery leaves the job `delayed` by its backoff).

**Acceptance**

- *`bun run test:model` passes, including `crash`, standard and deep, against the Postgres store:* yes. Standard (100 runs, up to 60
  commands, seed 20,261,014) and deep (`QCLOUD_MODEL_TARGET=postgres QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150`, 33 s, random seed)
  both pass with `QCLOUD_REQUIRE_DB=1`. The default `bun run test:model` (fake store, planted bugs) passes. Caveat: "including `crash`"
  means the `crash`, `expireLease` and `recover` commands, not the tick (item b).
- *A retried or recovered job has `rung_at` null and a ring; a recovered job is not claimable before its backoff:* tested for `fail` and
  recovery.
- *A job is DLQ'd once under concurrent `fail` and recovery on the same expired lease:* `recovery.policy` (fail racing recovery on the last
  attempt: one DLQ entry, one metric) and `complete.atomic` (complete racing recovery and racing fail).
- *Stale-token completion is rejected in every interleaving the harness generates:* the `zombie` command runs against the Postgres store.
- *Retry delay matches the formula:* `fail.backoff.test.ts` and the exponential test in `fail.retry`.
- *Events and metrics are in the same transaction as the state change:* forced-rollback tests for `complete`, `fail` and recovery
  (recorder, metric write and hook each throw).

**Checked** (PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (257 files within 300 lines) exit 0.
- `bun test packages/store-postgres --grep "complete|fail|dlq|recovery|backoff|retry|ttl"`: 209 pass, 0 fail, 56 skip (emulator and
  PgBouncer suites). The 9 new files alone: 129 pass.
- Full `bun test` with `QCLOUD_REQUIRE_DB=1`: 678 pass, 72 skip, 2 fail on the first run. One was a stale test I fixed
  (`enqueue.basic`, which expected `complete`/`fail` to be unimplemented: now 18 pass), the other is the `fleet` cap spike on macOS
  (`somaxconn`), already recorded in task 11. The full run was not repeated after the one-test fix.
- Mutation check, restored byte for byte (diffed against a saved copy): recovery that does not count the attempt fails both Postgres model
  runs (the seeded one and the environment-driven one) with a 4-command history (enqueue, claim, expireLease, recover; `I4.attemptsCounted`).
- Concurrency tests: ten `complete`s of one lease give one success; concurrent recovery passes take each job once with exact attempts,
  DLQ entries and metrics.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer (including the never-run `connection.pooled`), TLS Postgres, the Pub/Sub
  emulator and ElasticMQ.
- The tick itself (task 15): recovery as part of a tick, and the lease-plus-two-intervals bound, are argued and unit-tested at the store,
  not run end to end.
- The cost of the DLQ trim at 10,000 entries, and of recovery under load (task 22).
- The stall limit is not in the model (the attempt limit fires first at the model's `maxAttempts`).
- Flow-parent promotion (task 50, through `onTerminal`), flow-failure application, repeat successors and cron-lease protection.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 15 (store: delay, cron, events, logs, metrics, workers). It writes the stall and DLQ configuration and the real event
journal (it must not count the `completed` and `failed` metrics this task writes twice), implements `tick` (it calls `recoverExpired`,
`expirePending` and `purgeExpiredDlq`), `promote`, `changePriority` and `cancel`, and empties `spike/ported/`.
