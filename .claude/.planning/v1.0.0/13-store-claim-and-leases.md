# 13 — Store: claim, leases, limits

**Status:** done · **Depends on:** 12 · **Phase:** 1

## Goal

`StateStore.claim` and `heartbeat`: take the next best job(s) for a queue under a lease, honouring priority, FIFO/LIFO, groups, pause, rate limits and concurrency limits, with the lease token as the only fence.

## Scope

In: claim selection, batched claims, lease acquire/renew/release, queue pause, rate limit and concurrency limit enforcement, tests.
Out: completion and failure (task 14).

## Reference

`../qelay/src/infrastructure/persistence/postgres/`: `claims.ts`, `claimBatch.ts`, `claimSelection.ts`, `groupClaims.ts`, `groups.ts`, `leaseStore.ts`,
`leaseRenewal.ts`, `leaseRelease.ts`, `leaseDeadline.ts`, `rateLimit.ts`, `policies.ts`, `queueLifecycle.ts`, `transactionRetry.ts`, `advisoryLocks.ts`.
Drop `brokerSessions.ts` and the session-scoped parts. **`sessionLimits.ts` stays** (it validates timeout values; task 11
owns it). The fence is the `lease_token` with an unexpired `lease_until`, checked under the row lock; `version` guards
writers that hold no lease (task 01 decision, as restated in DESIGN.md section 3, invariant 2).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

- **Claim does not count an attempt.** An attempt is counted when it ends without success: on `fail` and on lease
  recovery (upstream's semantics, and invariant 5 holds under it). The earlier wording of step 2 ("increments
  `attempts`") was wrong and is corrected below.
- **An empty claim is normal, and a doorbell is only a hint.** Bells are fungible: the claim takes the next job in
  queue order, whatever `jobId` the bell carried. The claim must not depend on the hint.
- **A claim never returns a job on the strength of a bell's `jobId`.** Tests include a bell for a job that has
  already completed and a bell for a queue whose head job belongs to another bell.
- **`rung_at` is cleared whenever a job returns to claimable** (resume, window reset, release). Rate-limit,
  pause and group blocks are otherwise repaired by the tick's age threshold, and on Pub/Sub that runs at tick speed.
  Record the measured recovery time of a rate-limited queue in the Result (spike 03: about 10 jobs per minute under a
  1-minute tick, so the in-process tick matters here).
- **Model harness on the real store is a done-criterion.** This task is not done until `bun run test:model` passes on
  the Postgres store with the fake `Clock` from task 11, for the claim, heartbeat, release, pause and limit commands.
  Run the 5,000-job case with the event journal on and record what its lock costs.
- **Renewal, release and recovery bypass the retry wrapper upstream.** Decide whether to wrap them, backed by a test.
  The default is to keep upstream's behaviour.

## Steps

1. Port claim selection (`FOR UPDATE OF job SKIP LOCKED`, ordered by priority DESC, then `run_at`, then `id`, with the LIFO variant and the group-aware variant) and the batch claim.
2. **Lease:** `claim` sets `lease_owner`, a fresh `lease_token`, `lease_until = now + lockDuration`, moves to `active`, bumps `version`. It does **not** increment `attempts` (see Gate decisions). All time comes from the database clock through the injected `Clock` (default: the database's own time, as Qelay's `databaseNow` does), never a worker's.
3. **Heartbeat/renew** extends `lease_until` only if the token and version still match; returns false (→ `LeaseLostError` upstream) otherwise. Port the renewal cap (`lease_renewals`) if Qelay has one.
4. **Release** (graceful shutdown): returns the job to its prior claimable state without counting a failed attempt.
5. **Limits:** queue `paused` blocks claims; rate limit window and count; concurrency limit across all workers of a queue; group concurrency and group pause. Enforcement happens inside the claim transaction.
6. **Re-ring on unblock:** when a claim finds work blocked only by pause, rate limit, or group limits, record that fact so task 20's tick re-rings once the block lifts (set `rung_at = NULL` for the blocked jobs on resume/window reset). The jobs the unblock makes claimable come back as rings with `dueInMs`, like any other mutation.
7. Retry on serialization failure and deadlock using the ported `transactionRetry` behaviour, with a bounded attempt count.
8. Tests and harness: 8 concurrent claimers over 5,000 jobs (each claimed once); priority and LIFO ordering; group exclusivity; pause/resume; rate-limit window rollover; concurrency cap across claimers; stale-token heartbeat rejected; lease expiry visible to claim.
9. Turn on invariants 2 and 3 and the ordering checks in the model harness **for the real Postgres store** (condition 1 of the go), using the fake `Clock`.

## Acceptance

- Over 5,000 jobs and 8 claimers, every job is claimed exactly once and none is skipped.
- A heartbeat or later write with a stale `lease_token` can never succeed.
- Ordering and limits match the reference model across randomised histories (`bun run test:model`), **on the Postgres store, not only the fake**.
- A claim leaves `attempts` unchanged (test), and a bell for a completed job claims nothing.
- Pause, rate limit and concurrency limit are enforced inside the claim transaction (no check-then-act race), proven by a concurrent test.
- No broker or session identifier left in the code (`sessionLimits` excepted); `docs/PORTING.md` updated.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/store-postgres --grep "claim|lease"
bun run test:model
```

## Risks / notes

- Use the database clock everywhere. Worker clock skew silently breaks lease logic otherwise.
- `SKIP LOCKED` can return fewer rows than exist while others are locked; callers must treat an empty claim as "try again on the next doorbell", not "queue empty".
- Rate-limit counters are a hot row. Keep their update inside the claim transaction and measure contention (task 22).

## Result

**Done locally, on PostgreSQL 18.6, not on the Docker PG 16 of CI.** The user told me to defer Docker-backed runs until every task is
done. That departs from CLAUDE.md's "run the gate with `QCLOUD_REQUIRE_DB=1`" rule; the Docker run is owed at the end. Details of
every decision: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), section "Claim, leases and limits (task 13)".

**Built**

- `PostgresStore` now has `claim`, `heartbeat`, `release`, `pause`, `resume`, `setRateLimit` and `setConcurrencyLimit`.
  `complete`, `fail`, `tick`, `promote`, `changePriority` and `cancel` still reject with `NotImplementedError` (tasks 14, 15).
- `packages/store-postgres/src/store/`: `claim`, `claimSelect`, `groupState`, `queueState`, `lease`, `leaseRules`, `limits`, `retry`
  (new); `events`, `context` (`leaseMs`), `prepare` (`identifier`) edited. `DEFAULT_LEASE_MS` (30 s) and `MAX_CLAIM` (1,000) exported.
- Core: `release`, `setRateLimit`, `setConcurrencyLimit`, `ClaimOptions.group` (`GroupPullOptions`), `RateLimit`, the `'release'` cause.
- Harness (`test/model/`): `limits.ts`, `fakeCore.ts` (new; `FakeStore` extends it), the commands `release`, `setRateLimit`,
  `setConcurrencyLimit`, the check `CLAIM.limits`, two planted bugs, and the Postgres target runs the claim and lease commands.
- Tests, `packages/store-postgres/test/`: `claim.{basic,order,pause,rate,concurrency,groups,concurrent,retry,recovery}.test.ts`,
  `lease.{rules,heartbeat,release}.test.ts` (184 tests in these 12 files).

**Design problems found and how they were handled** (none reverses the gate; each is recorded in the gate document)

1. `StateStore` had no `release`, no limit setters and no group pull options: added minimally to core (items a to c).
2. Upstream's single `ORDER BY CASE` for LIFO and FIFO cannot use an index: two queries merged in code (item d).
3. Upstream defect: a group's own limit was ignored for the window refresh and count when the worker passed no default: fixed (j).
4. Rate-limited recovery runs at tick speed, because the tick does not know when the window reopens. Simulated, not measured
   (h). Task 15 owns the fix.
5. The event-journal cost of the 5,000-job case cannot be measured until task 15 (k).

**Decisions on the gate's open points**

- Retry wrapper: heartbeat and release stay single fenced statements, as upstream (e). A claim is replayed once on 40001, 40P01
  and 55P03, with a test that scripts those failures.
- A claim counts no attempt, clears `rung_at`; resume and limit changes clear due bells; release clears its own job's bell.
- Release refuses an expired lease, and heartbeat never shortens a lease and refuses a job past its processing deadline.

**Checked** (PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (235 files within 300 lines) exit 0.
- `bun test packages/store-postgres --grep "claim|lease"`: 212 pass, 0 fail, 56 skip (emulator and PgBouncer suites).
  The 12 new files alone: 184 pass, 0 fail.
- `bun run test:model`: 9 pass (fake store, the 7 planted bugs, Postgres target with 100 runs, seed 20,261,014). A deeper Postgres run
  (`QCLOUD_MODEL_TARGET=postgres QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=100 QCLOUD_MODEL_SEED=77`, 23 s) also passed, on the final code.
- Full `bun test`: 538 pass, 72 skip, 1 fail: the `fleet` cap spike on macOS (`somaxconn`), already recorded in task 11.
- Eight claimers over 5,000 jobs: every job claimed once, 5,000 distinct tokens, none skipped. The 8-test file takes about 1.3 s.
- Concurrent proofs: a concurrency limit of 3 holds against eight claimers, a rate of 10 per window gives 10, and a churn run
  never samples more active jobs than the limit. A mixed run of claims, heartbeats, releases, pauses and limit changes ends consistent
  with no deadlock error.
- Mutation checks, each restored byte for byte: the shared-to-exclusive upgrade removed (the concurrency, rate and group tests
  failed: 24 jobs claimed where 3 are allowed), and, earlier, a claim that ignores a limit, ignores a pause, drops the fence, or counts
  an attempt (the model failed each).

**Not done / not verified**

- Docker, PG 16, `QCLOUD_REQUIRE_DB=1`, PgBouncer, TLS Postgres, the Pub/Sub emulator and ElasticMQ.
- The event-journal cost of the 5,000-job case (the journal is task 15).
- Rate-limited recovery time of the product: only a virtual-clock simulation exists.
- Claim behaviour behind a transaction pooler (`connection.pooled`, never run); contention on the rate-limit hot row (task 22).
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 14 (store: complete, fail, retry, DLQ, recovery).
