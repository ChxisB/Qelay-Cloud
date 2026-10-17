# 06 — Phase 0 gate: go/no-go and design update

**Status:** done (go-ahead given 2026-10-14) · **Depends on:** 01, 02, 03, 04, 05 · **Phase:** 0

## Goal

Decide, with evidence, whether to proceed with the doorbell model (DESIGN.md D5) and the port approach, and fold the spike
findings back into `DESIGN.md` before any Phase 1 code is written.

## Scope

In: review of spike write-ups, a decision, edits to `DESIGN.md`, disposal of spike code, and any re-planning of tasks 10-22.
Out: new features.

## Steps

1. Read the five spike results and list, per DESIGN.md risk, whether it was confirmed, reduced or made worse:
   broker coupling (01), invariants under fault injection (02/03/04), interface fit across clouds (04), connection pressure (05), delay precision (03/05).
2. **Decide D5.** Proceed with Postgres-authoritative plus doorbell, or change course. If a spike showed the doorbell adds more
   failure modes than it removes, the alternative is **Postgres-only polling workers** with the cloud queue added later as an optimisation. Say which and why.
3. **Decide port vs rewrite** for each store module group, per task 01.
4. **Settle the interfaces:** update the `DeliveryTransport` and `StateStore` sketches with the changes from 03, 04 and 05.
5. **Settle D1 and D2** (worker hosting, doorbell granularity) with data, and record any change to the defaults in `CURRENT.md`.
6. Edit `DESIGN.md`: mark decisions confirmed or changed, correct the feature mapping, and update the risk list with what the spikes showed.
7. Re-plan: adjust tasks 10-22 (scope, order, dependencies) if the design changed. Record what changed at the top of `CURRENT.md`.
8. Dispose of spike code: promote what is reusable into `packages/*` under the real task that owns it, delete the rest, keep write-ups in `docs/spikes/`.
9. **Get the user's explicit go-ahead** to start Phase 1. Do not start Phase 1 on your own.

## Acceptance

- `DESIGN.md` reflects the spike results and states plainly which decisions changed.
- A written go/no-go with the evidence for each risk.
- Tasks 10-22 are still accurate, or updated.
- Spike code is promoted or deleted; `docs/PORTING.md` is current.
- The user has confirmed the decision.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture && bun test
git diff --stat DESIGN.md .claude/.planning
```

## Risks / notes

- The temptation is to proceed because spikes mostly worked. The gate exists to catch the case where they mostly worked but one failure mode, such as lost doorbells under pause, is unsolved.
- If the answer is "change course", stop and re-plan with the user rather than editing tasks quietly.

## Inputs recorded by earlier tasks

From task 01 ([docs/spikes/01-postgres-port.md](../../../docs/spikes/01-postgres-port.md)):

- **Invariant 2 wording.** DESIGN.md says "Compare-and-set on `version`". The spike shows the lease holder is fenced by `lease_token` plus an unexpired `lease_until`, under a row lock. `version` compare-and-set is the guard for writers without a lease. Clarify the wording in DESIGN.md; no design change.
- **Task 13 corrections:**
  - step 2 says claim increments `attempts`, but upstream counts them on fail and recovery (recommendation: keep upstream's semantics);
  - `sessionLimits.ts` is not a broker module (keep it, in task 11).
- **Task 11 decision input.** Keep the event-journal commit sequencer: it orders events for concurrent writers, and the cloud model has more of them.
- **Spike disposal.** Promote `packages/store-postgres/spike/ported/` per the write-up's module plan. Delete the harness and tools, or keep `tools/port.ts` for upstream syncs.

From task 02 (Result in [02-store-model-harness.md](02-store-model-harness.md)):

- **Model test coverage (step 1, invariants under fault injection).**
  - The harness checks invariants 1-5 under dropped, duplicated and late doorbells, worker crashes and lease expiry.
  - It catches five planted bugs with histories of 6 commands or fewer.
  - It has run **only against a fake in-memory store**. DESIGN.md Phase 0 (a) also expects it to run against the
    ported Postgres code. Decide whether that is needed before Phase 1, or stays with tasks 11-15 as planned.
- **StateStore sketch (step 4).**
  - Time comes from an injected clock, so `tick()` takes no `now`. The Postgres store needs a clock seam in place of
    `databaseNow(tx)` to run under the harness.
  - Mutations that make a job claimable (enqueue, fail-retry, promote, tick) return the doorbells to ring, and the caller rings them.
  - The provisional interface is `test/model/store.ts`. Its transition table (`test/model/model.ts`) is input for task 10.
- **Re-ring contract.**
  - The tick re-rings every claimable job in an unpaused queue whose last ring is at least `reRingAfterMs` old.
  - That threshold must not exceed the tick interval.
  - Without it, a dropped publish leaves a job stuck forever.
  - Record it in DESIGN.md's tick section.
- **Deterministic retries.** Upstream's backoff jitter (`Math.random`) makes model runs unreplayable. Tasks 13 and 14
  need injectable randomness or a deterministic backoff option.
- **Generated job ids** must sort in creation order (UUIDv7), because LIFO order is checked by creation.

From task 03 ([docs/spikes/03-doorbell-gcp.md](../../../docs/spikes/03-doorbell-gcp.md)):

- **The doorbell model holds on Pub/Sub (emulator only).** These scenarios lost or double-ran no jobs:
  - dropped publish;
  - duplicate delivery;
  - a crash before or after the ack;
  - an expired ack deadline;
  - paused and rate-limited queues.

  The real-project run (step 8) was not run (D9).
- **Tick-speed paths (design change).** Three paths wait for the tick:
  - rate-limited queues;
  - retry backoff;
  - lease recovery.

  With a 1-minute tick, a queue limited to 10 jobs/s runs about 10 per minute. Decide among the spike's fixes:
  - the claim returns when capacity frees, and the worker holds the doorbell un-acked until then;
  - the failing worker rings at `run_at`;
  - an in-handler tick loop (about 55 s per invocation, due-scan every 5 s).
- **Only the tick recovers a crashed job.** A later doorbell claims nothing while the dead worker's lease row is
  `active`. Correct "the sweep or a later doorbell recovers" in DESIGN.md and task 13.
  - The worst case is lease plus 2 tick intervals, because recovery leaves the job `delayed` by its backoff.
- **D2: per job, recommended.** On the emulator:
  - per-queue doorbells drained a 10k backlog 1.5-1.75× faster;
  - under steady load the modes were the same (p50 30-37 ms);
  - letting a per-job doorbell claim several jobs gained nothing.

  Per-job doorbells keep the subscription backlog equal to the unclaimed jobs, for autoscaling. Revisit if a real
  load test shows claim transactions are the bottleneck. D2 says spikes 03 and 04 confirm it, but task 04's steps
  do not measure granularity. Decide whether 04 runs `tools/doorbellGranularity.ts`'s modes on SQS, or D2 closes on
  03's data.
- **Two re-ring limits for the tick (task 20).**
  - Cap re-rings per queue. Without the cap, a backlog re-rings one doorbell per job on every tick.
  - Give a null `rung_at` a grace period, or write it in the insert transaction, so the tick does not re-ring jobs
    whose publish is still in flight.
- **`rung_at` on return to claimable** (tasks 11, 13, 20). Retry, recovery, resume and promotion must null `rung_at`
  or return the doorbells to ring.
- **Doorbell DLQ is a metric.** Nack on a database error. A malformed doorbell goes to the DLQ. Alert on the DLQ, never
  replay it: the tick re-rings every claimable job anyway.
- **Cloud Tasks relay: not needed for v1.0.0.** Not prototyped.
- **Emulator gaps need a real run** before Phase 1 sign-off, or as Phase 1 risk:
  - retry backoff (the emulator's is not exponential);
  - best-effort dead-lettering under real IAM;
  - throughput;
  - streaming pull across Cloud Run restarts.

  CI does not run the emulator, so the doorbell suites skip there.
- **Spike disposal.** `packages/store-postgres/spike/doorbell/` moves to `transport-gcp` (task 17) or is deleted. The
  root `@google-cloud/pubsub` devDependency (pinned 6.1.0) moves with it. The opt-in `pubsub` compose service is
  untested.

From task 04 ([docs/spikes/04-doorbell-aws.md](../../../docs/spikes/04-doorbell-aws.md)):

- **The doorbell model holds on SQS (ElasticMQ only).** No scenario lost or double-ran a job: dropped and half-dropped
  publishes, duplicate bells, a crash before or after the delete, an expired visibility timeout, paused and rate-limited
  queues, delayed bells, failing jobs, database outages and malformed bodies. The real-account run (step 6) was not run (D9).
- **The `DeliveryTransport` sketch needs six changes** (step 4 of this task). The spike's `transport.ts` is the proposal:
  1. `ring` returns a result per bell (`SendMessageBatch` half-succeeds);
  2. a relative `deliverAfterMs`, rounded up, refused above `maxDeliverDelayMs`;
  3. `capabilities` adds `maxRingBatch`, `attemptCount` and `retryGranularityMs`, and drops `ordering`;
  4. `subscribe(handler, { capacity })` is demand-driven, with `refresh()` and `close()`;
  5. the handler gets a `Delivery` with `ack()`, `nack(retryInMs)` and `attempt`, and the transport holds the bell while
     the handler runs;
  6. `stats()` carries `source`, `observedAt` and `maxStalenessMs`, with `null` for unknowns (SQS has no age in queue attributes).
- **Open point for task 10:** one cloud queue that carries bells for every Qelay queue (the spike), or one per Qelay
  queue (the sketch's `subscribe(queue, ...)`). The spike does not settle it.
- **Retry backoff at tick speed is cloud-specific.** On SQS the failing worker rings the retry for `run_at`, using
  `capabilities.maxDeliverDelayMs`. Task 03's three tick-speed paths still hold on Pub/Sub, where that value is 0. The
  same worker code adapts to both.
- **Bells are fungible.** A bell's `jobId` is a hint and the claim takes the next job in queue order, so `rung_at`
  counts bells, not jobs. **The tick's age threshold bounds invariant 3**, not the null check. `rung_at` should mean
  "a doorbell is deliverable at this time" (now, or `run_at` for a delayed bell), set only for the bells the broker took.
  Record this in DESIGN.md's tick section.
- **Delay limit.** SQS holds a bell for at most 900 s. The tick pre-rings jobs whose `run_at` is inside the window, which
  is clamped to the transport's limit and should be at least one tick interval plus the worst tick lateness.
- **D2 was not measured on SQS.** Recommendation: per job. Decide whether to close D2 on 03's data or add a load test
  on real SQS (task 40 or 41).
- **DLQ is a metric on SQS too.** Nack on a database error with a backoff, and a malformed bell goes to the DLQ. A long
  outage dead-letters bells (with 1 s doubling to 30 s and `maxReceiveCount` 5, after about 30 s). That is harmless
  because the tick re-rings every claimable job. Alert on the DLQ, never replay it, and set its retention to the 14 day
  maximum (AWS counts it from the original enqueue time).
- **Invariant checker.** `doorbell/invariants.ts` now accepts a job that fails and retries (one settle per claim, in
  order). The model harness (task 02) is unchanged.
- **Emulator gaps need a real run** before Phase 1 sign-off, or as Phase 1 risk: stale-handle deletes, broker-side
  duplicates, attribute-count lag, `Failed[]` from a real partial failure, receive counts and short polling, and request
  cost at the per-job rate. CI does not run ElasticMQ, so the emulator suites skip there.
- **Spike disposal.** `packages/store-postgres/spike/doorbell-aws/` moves to `transport-aws` (task 40), with
  `faults.ts` and the scenario list as input to task 41, or is deleted. The root `@aws-sdk/client-sqs` devDependency
  (pinned 3.1140.0) moves with it. The `sqs` compose profile is ElasticMQ and works.

From task 05 ([docs/spikes/05-db-access-and-delay.md](../../../docs/spikes/05-db-access-and-delay.md)):

- **Connection pressure is bounded, and the risk is reduced.** `direct = sum(count x (pool + listen)) + 6`, default
  per-process pool **2**, worker `concurrency` not in it. 10 / 50 / 200 worker processes need 32 / 112 / 412 direct
  connections, or 26 behind a pooler. Measured on real processes, direct and through PgBouncer. Direct, the cap is a hard
  `53300` failure, not a queue. Put the product (max instances x pool) in the Terraform plan (task 21).
- **A transaction-mode pooler works with three configuration rules** (measured on PgBouncer 1.26): `prepare: false` (or
  `max_prepared_statements > 0`); no `statement_timeout`, `lock_timeout` or idle-in-transaction startup parameters
  (rejected); schema and timeouts on the role with `ALTER ROLE ... SET`, because `search_path` as a startup parameter is
  not applied reliably. The ported code uses only transaction-level advisory locks and `NOTIFY` inside transactions.
  `LISTEN` fails silently through a pooler, so `QueueEvents` and the `local` transport need a direct `listenUrl`.
  DESIGN.md section 7 should say the Cloud SQL connector is a tunnel, not a pooler.
- **Pooler per cloud.** Direct with pool 2 by default; add a pooler above about 80% of `max_connections`. Cloud SQL managed
  pooling is **Enterprise Plus only** (documented), so other editions need a shared PgBouncer. RDS Proxy pins on
  `nextval` (documented), which grouped-job admission calls, and what it does with `prepare: false` is not verified.
  Decide whether task 12 keeps the sequence or uses `qcloud_queue_state.group_sequence`.
- **Driver finding (design input for tasks 17 and 19).** `Bun.SQL` 1.4.2 has no bound on a silent connection: a query on
  it never settles, `cancel()` and `statement_timeout` do not help, and `close()` without a timeout hangs. The SDK needs a
  per-operation deadline wrapper (the spike's `ResilientPool`), `maxLifetime`, `idleTimeout` and `close({ timeout })`.
  A deadline is "outcome unknown", safe because writes are lease- or token-guarded. Resets and refusals recover by
  themselves, with one retry for a query sent in the same instant as a reset.
- **TLS and auth.** The driver default is plaintext. The SDK must pass `tls: { ca }`. `password` as a function is called
  per connection (IAM tokens). Cloud Run's `/cloudsql` socket works through `path`; libpq's `?host=/dir` is silently read as
  TCP. Cloud SQL's server certificate against hostname verification was not verified.
- **Delay and tick: no Cloud Tasks relay in v1.0.0; opt-in in-process tick.** Keep the 1-minute Cloud Scheduler tick. An
  in-process tick on always-on workers, leader by **lease row** with the database clock (not a session advisory lock:
  two holders behind a pooler), gives lateness of about half the interval plus 100 ms, never early, and takeover after a
  crash within the lease length. It fixes task 03's three tick-speed paths (delay, retry backoff, rate limits) at once.
  The tick must stay safe to run concurrently: the lease is an efficiency device.
- **D1 interaction.** Seconds-level delay precision exists only with always-on workers. With scale-to-zero push
  handlers it is 1 minute, or the Cloud Tasks relay (documented: 30-day schedule, 500 tasks per second per queue, $0.40
  per million operations after 1 million free). Close D1 knowing this.
- **Not run (D9)** and needed before Phase 1 sign-off or as Phase 1 risk: Cloud SQL and RDS over TLS with IAM auth, HA
  failover timing (reset or stall), managed pooling, RDS Proxy pinning, the Cloud SQL certificate check, a measured fleet
  on a real instance, Cloud Tasks precision and Cloud Scheduler jitter.
- **Spike disposal.** `packages/store-postgres/spike/db-access/`: promote `budget.ts` (config validation, task 19),
  `resilient.ts` (task 19) and the lease row from `tick.ts` (task 20); keep the PgBouncer-backed tests as a compatibility
  suite if CI can run the `pgbouncer` and `tls` profiles, otherwise delete. The `pgbouncer` and `tls` compose profiles work.

## Result

Steps 1-8 done locally on 2026-10-13 and 2026-10-14. **Step 9 (2026-10-14):** the user answered the gate with "Let's
continue through the v1.0.0 remaining tasks", which is taken as the go-ahead to start Phase 1. They did not answer the
four open questions, so the plan as written applies: condition 1 stays inside tasks 11-14 (no separate harness task),
"disposal by owner" stands for the spike code, and Phase 1 sign-off treats the D9 items as recorded risks. Any of
those can still be reversed; say so and the owning task changes. Write-up: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md).

**Verdict: go, with three conditions.** D5 is confirmed (Postgres authoritative, cloud queue as a doorbell, ported
engine). The design needed nine corrections; none argues for another architecture.

1. **The model harness has not run against the real store.** Only the fake in-memory store. Tasks 12-14 own it, and
   tasks 13 and 14 are not done until `bun run test:model` passes on Postgres with the clock seam from task 11.
2. **No result came from a real broker or a real cloud database.** Everything cloud-side is an emulator, a stand-in or
   documentation (D9). Task 22 runs the scenario suite on a real project or records it as not run.
3. **Delay precision is a product limit.** Seconds-level delay, retry backoff and rate-limit resumption on GCP need an
   always-on worker with the in-process tick. A scale-to-zero push handler gets one minute. `docs/limits.md` (task 22)
   says so first.

**What was decided**

- **D5:** proceed. **Port vs rewrite:** port; the two rewrites are `runtime` (becomes the tick, task 20) and the `store`
  facade.
- **Interfaces settled** in DESIGN.md section 5: `DeliveryTransport` (per-item `RingResult`, relative delay, demand-driven
  `subscribe`, `Delivery` with `ack`/`nack`, one cloud queue per Qelay queue, DLQ as a metric) and `StateStore` (injected
  `Clock`, rings returned by mutations, `markRung` per bell, claim does not count an attempt, `tick(budget)`).
- **D1:** always-on pull workers stay the default. **D2:** per job, closed on Pub/Sub data; SQS is open until task 41
  runs a load test on real SQS (D9).
- **Event journal kept; `sessionLimits` kept; `attempts` counted on fail and recovery, as upstream.**
- **Nine design corrections** applied to DESIGN.md (listed in the write-up): invariant 2 names the lease token as the
  fence; invariant 3 is a bound; only the tick recovers a crashed worker's job; the tick contract; no Cloud Tasks
  relay; the two interface sketches; the Cloud SQL connector is a tunnel, not a pooler; DLQ is a metric; tick-speed
  paths without the in-process tick.

**Re-plan (step 7).** Tasks 10-22, 40 and 41 each gained a "Gate decisions (task 06)" section that is binding, and
a few plainly wrong steps were corrected in place (task 13 step 2). Tasks 35 and 37 got a wording change only
("sweep" to "tick"). Task 18 was not on the original list of affected tasks and was touched for the ring handshake.
No task was added, removed or reordered. The summary is at the top of `CURRENT.md`.

**Spike code (step 8).** Disposal is by owner, not by promotion now: the owning tasks exist and their packages are
skeletons, and a module promoted without its task's tests and review is code nobody has read. The table is in the
write-up and each Phase 1 task names what it takes. Deleted at the gate: `spike/tools/measure.ts` (no importers; its
output is recorded in spike 01). `docs/PORTING.md` header updated; rows move with files. **This reads "promoted or
deleted" in the acceptance as "assigned and scheduled", which the user may not agree with.**

**Bugs found and fixed:** none in shipped code. The gate corrected its own draft: the `nextval`/`group_sequence`
decision was first assigned to task 13 and belongs to task 12 (grouped admission); a half-day estimate and an
undefined `RungReport` type were removed from the drafts.

**Changed files**

- `DESIGN.md`; `docs/spikes/06-phase0-gate.md` (new); `docs/PORTING.md`; `docs/spikes/01-postgres-port.md` (two
  wording fixes).
- `.claude/.planning/v1.0.0/`: `CURRENT.md`, tasks 10-22, 35, 37, 40, 41.
- `packages/store-postgres/spike/tools/measure.ts`: deleted. `port.ts`: comment updated.

**Verified**

- Gate with Postgres, ElasticMQ, the Pub/Sub emulator, PgBouncer and TLS all required (`QCLOUD_REQUIRE_*=1`):
  typecheck, oxlint, oxfmt on 163 files, architecture (143 TypeScript files, all at most 300 lines) and `bun test`:
  88 pass, 0 fail, 18 files, about 185 s. Run on 2026-10-13, after the code deletion and before the final markdown
  edits of 2026-10-14; `format:check` was re-run after those.
- Tick figures re-measured at the gate (two runs, quoted as ranges): 500 ms interval mean 343-348 ms, p95 554-562 ms,
  max 577-592 ms; 2,000 ms interval mean 1,186-1,190 ms, max 2,065-2,079 ms; a tick costs about 7 ms; takeover about
  the lease length.
- `git diff --stat DESIGN.md .claude/.planning` could not show a diff: the repository has no commits and everything is
  untracked (`git status --short` is all `??`), so there is nothing to diff against.
- `bun run test:model` not run: no queue semantics changed in code, only in the plan.

**What was and was not run**

- **Created in a cloud account: nothing. Removed: nothing to remove.** No `gcloud`, `aws` or `terraform` call.
- Not run (D9): every item in the write-up's "Not proven and needs D9" list: Cloud SQL and RDS over TLS with IAM and
  failover, managed pooling, RDS Proxy pinning with `nextval` and `prepare: false`, Pub/Sub backoff, dead-lettering
  under real IAM, throughput and the official client under Bun against the real service, SQS stale handles,
  duplicates and `Failed[]`, Cloud Tasks and Cloud Scheduler precision.
- The model harness on the real Postgres store (condition 1): not run, scheduled in tasks 12-14.
- The deletion of `measure.ts` cannot be undone from git, because nothing is committed.
- Nothing committed or pushed.

**Open for the user**

- The explicit go-ahead to start Phase 1 (task 10), or a change of course.
- Whether to close condition 1 first with a separate "model harness on Postgres" task ahead of 10, or keep it inside
  tasks 11-14 as planned (the plan as written). The separate task delays the start of Phase 1 by its own length.
- Whether "disposal by owner" satisfies the acceptance, or the spike code should be promoted or deleted now.
- Whether the Phase 1 sign-off needs a real-cloud run (D9) or those items stay as recorded Phase 1 risks.
