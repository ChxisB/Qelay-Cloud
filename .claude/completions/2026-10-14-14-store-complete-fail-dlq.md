# Task 14: Store: complete, fail, retry, DLQ, recovery (2026-10-14)

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** `PostgresStore` now has `complete` and `fail`, and the public
non-interface methods `recoverExpired`, `expirePending`, `purgeExpiredDlq`, `listDlqPage`, `dlqStats` and `purgeDlq`. `tick`,
`promote`, `changePriority` and `cancel` still reject with `NotImplementedError` (task 15). The user told me to defer Docker-backed
runs until every task is done, which departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; that run is owed at the end.

**Changed files**

- `packages/store-postgres/src/store/`: `backoff`, `retryState`, `policies`, `remove`, `metrics`, `jobRow`, `dlq`, `settle`, `complete`,
  `fail`, `recovery`, `expiry` (new); `context`, `events`, `reads` (duplicate `listDlq` removed) edited.
- `packages/store-postgres/src/`: `postgresStore.ts` (wiring, options `jitter`, `random`, `maxMetricBuckets`, `onTerminal`), `index.ts`
  (new exports).
- `packages/store-postgres/test/`: `finishHelpers.ts`, `fail.backoff`, `complete.{basic,atomic}`, `fail.{retry,terminal}`,
  `dlq.limits`, `recovery.{expired,policy,ttl}` (129 tests); `enqueue.basic.test.ts` expects only the methods still pending.
- `test/model/`: `command.ts` (`recover`), `commands-ops.ts` (`RecoverCommand`), `commands.ts`, `run.ts` (`recover` is left out of the
  default command set), `postgresTarget.ts` (runs `complete`, `fail`, `recover`).
- Docs: `docs/PORTING.md` (twelve rows and a Store (task 14) note), `docs/spikes/06-phase0-gate.md` (new "Complete, fail, DLQ and
  recovery (task 14)" section), the task file and `CURRENT.md`.

**Decisions** (details in the task's Result and the gate document)

- A lost lease returns `{ ok: false, rings: [] }`, not a typed `LeaseLostError`: the interface has no such error, and it makes a retry
  after an unknown outcome safe.
- `settleAttempt` is the one place that counts an attempt, clears `rung_at`, keeps the history and writes the DLQ entry, for `fail` and
  for recovery. A ring is returned only when the backoff fits `ringWindowMs`.
- Every write is fenced by token and an unexpired lease under a row lock, and bumps `version`. Events, metrics and the terminal hook are
  in the transaction; any of them failing rolls the whole change back.
- Recovery is a public store method and a Postgres-only harness command until the tick (task 15) calls it.
- Departures from upstream: an unrecoverable failure records `explicit_fail`; the DLQ limit is enforced in the failing transaction
  (with a documented overshoot of one burst under concurrency); jitter is off by default with an injected `random`; DLQ age is
  `completed_at + maxAge`; the attempt history is capped at 20 records and error text is sanitized.
- DLQ retry is not implemented (fail-closed), as the gate decided. Flow-parent promotion is the `onTerminal` seam for task 50.

**Bugs the tests found (fixed)**

None in the store. The tests found wrong expectations of mine (a lease length, a `SKIP LOCKED` expectation in the complete-versus-recovery
race, a strict DLQ limit under concurrency, the boolean `heartbeat`, version arithmetic, the log insert columns), all corrected in the
tests. One stale test from task 13 (`enqueue.basic`, which expected `complete` and `fail` to be unimplemented) was updated.

**Checked** (PostgreSQL 18.6, TCP only)

- typecheck, oxlint, oxfmt and the 300-line check clean (257 files).
- The 9 new files: 129 pass, 0 fail. `bun test packages/store-postgres --grep "complete|fail|dlq|recovery|backoff|retry|ttl"`: 209 pass,
  56 skip.
- `bun run test:model`: 9 pass. Postgres deep run (`QCLOUD_REQUIRE_DB=1 QCLOUD_MODEL_TARGET=postgres QCLOUD_MODEL_RUNS=500
  QCLOUD_MODEL_COMMANDS=150`, 33 s): pass.
- Full `bun test`: 678 pass, 72 skip, 2 fail on the first run: the stale `enqueue.basic` test (fixed, 18 pass) and the macOS `fleet`
  spike (recorded in task 11). The full run was not repeated after the one-test fix.
- Mutation check: recovery that does not count an attempt fails both Postgres model runs with the history enqueue, claim, expireLease,
  recover (`I4.attemptsCounted`). The file was restored and diffed against the saved copy.

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer (including the never-run `connection.pooled`), TLS Postgres, the Pub/Sub
  emulator and ElasticMQ.
- The tick (task 15): recovery inside a tick and the lease-plus-two-intervals bound are not run end to end.
- The cost of the DLQ trim at 10,000 entries and of recovery under load (task 22).
- The stall limit is not in the model (the attempt limit fires first).
- Flow-parent promotion, flow-failure application, repeat successors and cron-lease protection (tasks 15 and 50).
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 15 (store: delay, cron, events, logs, metrics, workers).
