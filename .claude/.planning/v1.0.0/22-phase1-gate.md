# 22 — Phase 1 gate: core on GCP end to end

**Status:** done locally (GCP run not made: needs D9; your sign-off, step 8, not obtained) · **Depends on:** 17, 18, 19, 20, 21 · **Phase:** 1

## Goal

Prove Phase 1 as a user would meet it: an application enqueues, processes, retries, delays, schedules and dead-letters jobs on GCP, and the same behaviour holds on the local transport. Close the phase with evidence.

## Scope

In: an example app, an end-to-end scenario suite, a load and index check, a deep model run, the limits write-up.
Out: the panel (Phase 2) and AWS.

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), including its "Not proven
and needs D9" list.

- **Delay precision is the first table in `docs/limits.md`**, per hosting mode (condition 3 of the go): tick-only on
  Pub/Sub (mean about 30 s, max about 60 s, never early), the in-process tick (the numbers task 20 measured),
  the local transport's poll interval, and SQS's 900 s window. Say plainly that seconds-level delay, retry backoff
  and rate-limit resumption need an always-on worker running the in-process tick, and that a scale-to-zero push
  handler gets one minute. Rate-limited queues, retry backoff and lease recovery run at tick speed.
- **The real-run gaps are listed in `docs/limits.md`**, each as "proven on" / "not run": the spike's list (Cloud SQL
  and RDS TLS, IAM auth, HA failover, RDS Proxy pinning including `nextval`; Pub/Sub retry backoff, dead-lettering
  under IAM, throughput and streaming pull across restarts; SQS stale-handle deletes, duplicates, `Failed[]`, counts
  and request cost; Cloud Tasks and Cloud Scheduler precision). Step 5 (D9) closes what it can, and the rest stays
  listed as not run.
- **Condition 1 closes here, if it has not already:** `bun run test:model` passes on the Postgres store, standard
  and deep. If tasks 12-14 left a gap, this task is not done.
- **The spike directories are gone** (`packages/store-postgres/spike/`): `db-access/` by tasks 11 and 20,
  `doorbell/` by tasks 17, 20 and 40 (task 17 deleted what its scenarios used; `store`, `ring`, `sweep` and
  `invariants` stay for `db-access/` and `doorbell-aws/`, and the last of those two removes them), `doorbell-aws/` by task 40 (or, if AWS is not yet done, recorded as the one remaining
  owner), and then `ported/`, `harness.ts`, `claimOnce.test.ts`, `leaseRecovery.test.ts` and `crashingClaimer.ts`,
  which the last of those spikes still imports through `harness.ts`. Task 15 could not empty `ported/` as planned (it
  deleted the two files nothing imported); whichever of 17, 20 and 40 removes the last importing spike empties it. `docs/PORTING.md` rows point at the final paths. A grep for `spike/` in
  `src` and `test` is part of the Verify.
- **The load check runs with the in-process tick on and off**, and records the per-queue ring cap's effect on a
  100k-job backlog (doorbells per tick), so the cap's default is chosen from data.
- **Local transport numbers come from task 16** ([gate doc](../../../docs/spikes/06-phase0-gate.md), "The local transport"):
  delay, retry and visibility precision is the poll interval (default 1,000 ms, jitter plus or minus 20 %); the doorbell probe is
  one index probe per kind of job and reads no heap row (PG 18.6 only: re-check the plan on PG 16); a notification reaches every
  listener of the channel, which the load check should include (listeners times bells). Record these in `docs/limits.md`.
- **Pub/Sub numbers come from task 17** ([gate doc](../../../docs/spikes/06-phase0-gate.md), "The Pub/Sub transport"):
  record in `docs/limits.md` that delay, retry backoff and rate-limit resumption run at tick speed; that `inFlight` is
  unknown and `delayed` is 0 in `stats`; and that `stats` lag by about 5 minutes plus the cache. Two things only the
  real-project run (D9) can show, and the load check must not assume: that a busy worker holds at most `maxHeld` bells
  (the emulator ignores flow control, so the hoarding test is a `test.todo`), and the service's retry backoff and
  dead-letter timing (the emulator's backoff is not exponential). The Cloud Monitoring metric names and filter in
  `packages/transport-gcp/src/monitoring.ts` were checked against a stub only.
- **D2 stays "per job" on Pub/Sub data.** Do not widen the claim from Pub/Sub to SQS.

## Steps

1. **Example app** `examples/orders/`: a producer, a worker, a cron-driven job, a delayed job and a job that always fails into the DLQ. It runs on the local transport with `docker compose`, and on GCP with the task 21 infrastructure.
2. **Scenario suite** (same code, both transports): enqueue and complete; retry with backoff then success; exhaust retries into the DLQ; delay of seconds and of hours; cron every minute for ten minutes with no missed or doubled run; pause/resume; priority order; worker `kill -9` and recovery; publish failure repaired by the tick; duplicate doorbell.
3. **Deep model run:** `QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150 bun run test:model`, retaining seeds if anything fails.
4. **Load and plan check** on the test Postgres: 100k jobs across 5 queues, 16 workers. Record throughput, claim latency (p50/p99), lock contention on rate-limit rows, and `EXPLAIN` plans for the claim and the tick's `dueForRing` queries. Compare against Qelay's own Postgres numbers as a sanity reference (`../qelay/bench/`).
5. **GCP run (needs D9):** the scenario suite against a real environment from task 21, including the worker restart and a Cloud SQL maintenance-style reconnect. Record results and cleanup.
6. **Limits write-up** in `docs/limits.md`: delay precision per hosting mode first (see Gate decisions), the 1-minute cron floor, the maximum payload, the connection budget and its formula, the pooler rules, what is not supported (D6), the known emulator gaps, and the not-run list.
7. Update `DESIGN.md` status and mark which parts of the design were proven.
8. **User review:** present the results and get explicit approval before Phase 2 begins.

## Acceptance

- The scenario suite is green on the local transport; and on GCP if D9 allowed, or the GCP run is marked not run.
- The deep model run is green.
- No lost or double-run job across the load test (a reconciliation query checks totals).
- `docs/limits.md` exists, opens with the delay-precision table, states the real numbers measured here, and lists what was not run.
- `packages/store-postgres/spike/` no longer exists (or the one remaining owner is named), and `bun run test:model` is green on the Postgres store.
- The user has signed off.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
bun run test:model
bun run test:scenarios            # defined by this task
test ! -e packages/store-postgres/spike || echo "spike directories remain: name the owner in the Result"
```

## Risks / notes

- A passing suite on the emulator is not evidence about the real service for redelivery and dead-lettering. Say which results came from which.
- If load results show claim contention on the rate-limit row or the counts query, fix it here (counters with reconciliation, partitioning of hot rows) rather than carry it into the panel work.

## Result

**Done on the local stacks. Not run on GCP (step 5 needs D9), and the user sign-off (step 8, the last Acceptance line) was not obtained
separately:** work continued under the standing instruction to go through every task, so Phase 2 is conditional on your review of the
gate document ("The Phase 1 gate (task 22)" in `docs/spikes/06-phase0-gate.md`). No real cloud resource was touched: no `terraform apply`,
no `gcloud` or `aws` command.

**Delivered**

- **Example** `examples/orders/` (README, `src/{runtime,jobs,schedule,migrate,producer,worker,demo}.ts`, `orders.test.ts`,
  `docker-compose.yml`): orders added in bulk, a delayed reminder, a cron-driven report, a charge that always fails into the DLQ, a worker
  with the optional in-process tick. `bun run examples/orders/src/demo.ts` against local PG 18 ran 5 orders, 1 reminder (6 ms late), 3
  reports and 3 charge tries, then the charge sat in the DLQ with `max_attempts_exceeded`; `orders.test.ts` runs the same code in `bun test`.
  The demo counts every job in its namespace, so a second run on a used database fails its check (the error now says so). Its
  docker compose file and the GCP path were **not run**.
- **Scenario suite** `test/scenarios/`: 12 scenarios on 3 stacks (in-memory, Postgres, Pub/Sub emulator), 36 tests, `bun run test:scenarios`
  (about 70-97 s). Enqueue and complete; retry with backoff then success; exhausted retries into the DLQ; a delay of seconds and of hours;
  a cron every 250 ms ten times on two tick loops, and every minute for ten minutes with the clock pulled forward; pause and resume;
  priority order; a worker killed and recovered; a lost publish repaired by the tick; a duplicate doorbell. The Pub/Sub stack is the
  emulator.
- **Deep model run:** `QCLOUD_MODEL_RUNS=500 QCLOUD_MODEL_COMMANDS=150`: green on the fake, on Postgres and on Postgres with workers
  (before the two retention fixes below, which do not touch queue semantics). The standard `bun run test:model` was rerun after them:
  17 tests green. Condition 1 of the gate is closed on PostgreSQL 18.
- **Load and plan check** `scripts/load-{check,drain,backlog,lib,local}.ts`: 100,000 jobs over 5 queues and 16 workers with the tick off,
  every 5 s and every 1 s; a 100,000-job backlog nobody rang (the ring cap's effect); one hot queue with and without a rate limit;
  `EXPLAIN (ANALYZE, BUFFERS)` of every claim, ring and promotion query; the local transport's fan-out. **Every drain reconciled: rows =
  jobs, each ran once, none twice, all completed, 0 failed tick beats.** Figures are in `docs/limits.md` section 3; the headline is
  3,130-3,295 jobs/s with no tick, 1,632-2,090 with it (finding (a) below), 3,054-3,102 on a hot queue against 1,313-1,361 with a rate
  limit that never binds. The ring cap's default (100, `maxItems` 200) repairs a lost 100k backlog at 500 bells per pass, 1,000 s at a 5 s
  interval: a safe floor, and a slow repair of a catastrophe; the data says raise it only if you accept the cost (0.3 ms per extra bell).
- **`docs/limits.md`**: opens with the delay-precision table per hosting mode, says plainly that seconds-level delay, retry backoff and
  rate-limit resumption need an always-on worker running the in-process tick, and lists "proven on" and "not run" for every area (section 8).
- **`DESIGN.md`** status, the Phase 1 row, risks and the connection-budget line; the gate document gained a section and an amendment.

**Fixed here** (each with a failing test first, plan rows in `schema.planned.ts`, `docs/PORTING.md` rows updated; no schema change, no migration)

- `pruneEventCommits` scanned every live commit envelope on every tick pass; it now examines a bounded round-robin window (new
  `eventCommitPrune.ts`).
- The retention fold (`retainedCount`) joined unfolded counts to the rows it had locked and was planned as a nested loop on a table with no
  statistics: 790 million join-filter rows and 32 s for 40,000 counts, over the 10 s deadline. It now deletes by key.
- A flaky assertion in the cron scenario (a 150 ms minimum between jobs; the loop's catch-up after a stall legitimately gives 134 ms) is
  now 50 ms, with the reasoning in the comment. A test fix, not a product fix.
- Doc corrections: DESIGN.md and `docs/limits.md` said `QueueEvents` holds a LISTEN connection; it polls and holds none (task 19), and two
  comments in `budget.ts` said the same. Four scenario files were not formatted.

**Design findings, not changed: yours to decide** (details in the gate document, items (a) to (i))

1. **The tick re-rings a deep healthy backlog every interval** (1.5-2 tick bells per job, a third to a half of the throughput on a 100k
   drain, no job lost). The risk note told this task to fix contention here; this one is a tick-contract change (task 20), so it is recorded
   and left. Options: let only first rings repeat within a run, or live with it and use the 60 s Cloud Scheduler interval.
2. **An exact rate limit or global concurrency limit serializes claims on its queue's row** (2.3 times slower on a hot queue). The task's
   risk note suggested partitioned counters; a partitioned counter only approximates the limit, so it was left, with "spread hot work over
   queues" in the docs.
3. **Serialization the port brought with it:** every event-writing commit of a namespace passes one advisory lock, and completions of one
   queue serialize on its metrics rows. Local figures only; a managed database's commit time makes both worse (an expectation, not measured).
4. **Retention lags a burst** (300,000 events and 200,000 envelopes after a 100k drain, against a cap of 10,000 per queue), then recovers.
   Raise `QCLOUD_TICK_MAX_ITEMS` if the storage matters.
5. **Carried from task 18:** a finished job's custom id is replaced by an `enqueue` in another queue. Decide before 1.0.

**What was not run**

- **GCP:** the scenario suite against a real environment, the worker restart, a Cloud SQL maintenance-style reconnect (step 5, D9), and
  everything under "Needs D9". `docs/limits.md` section 8 lists each.
- **Docker-backed suites:** PostgreSQL 16, PgBouncer (`connection.pooled`, `maintenance/pooled`), the TLS Postgres, ElasticMQ and the
  example's `docker-compose.yml`. The gate's 54 skips are these. Owed at the end of the plan, by the standing instruction.
- **The spike directories:** `packages/store-postgres/spike/` remains (93 files), and **task 40 is its owner** (it removes `doorbell-aws/`,
  the last importer of `harness.ts` and `ported/`, and with them `claimOnce.test.ts`, `leaseRecovery.test.ts`, `crashingClaimer.ts` and
  `doorbell/{invariants.test.ts,invariants.ts,store.ts}`). A grep for `spike/` in `src`, `test`, `examples` and `scripts` finds only
  `scripts/port.ts`'s default output path.

**Verified** (local PG 18.6, Bun 1.4.2)

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: clean (453 TypeScript files within 300 lines).
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test`: **1,754 pass, 54 skip, 1 todo, 0 fail** (140 files). A first run had one failure,
  the cron-gap assertion above.
- `bun run test:model`: 17 pass. `bun run test:scenarios`: 36 pass. Both exit 0.
- `bun run scripts/load-check.ts`: 5 of 5 drains reconciled on the final code, plus two more rounds of the two tick drains (all
  reconciled). `bun run scripts/load-local.ts`: exits 0 and prints the fan-out.
