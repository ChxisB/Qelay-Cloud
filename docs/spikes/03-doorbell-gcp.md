# Spike 03: the doorbell on Pub/Sub

- **Task:** [03](../../.claude/.planning/v1.0.0/03-spike-doorbell-gcp.md), run on 2026-10-13.
- **Spike code:** `packages/store-postgres/spike/doorbell/`, on top of the task 01 port. **Task 17 removed most of it**: the
  scenarios, the worker, the Pub/Sub helpers and `tools/` are gone, and the scenarios run as
  [`packages/transport-gcp/test/`](../../packages/transport-gcp/test/) against `PostgresStore` and `PubSubTransport`. Five files stay
  (`store`, `ring`, `sweep`, `invariants`, `invariants.test`) for the later spikes that import them. The file table below describes the
  spike as it was run; the links in this write-up to the removed files no longer resolve. What the two tools established is
  kept as regression tests: the emulator facts in `receive.test.ts` and `ring.test.ts`, the granularity result in this document.
- **Environment:** the Pub/Sub emulator from gcloud 555 (`pubsub-emulator` component, on the host), Postgres 16 from
  `docker-compose.test.yml`, `@google-cloud/pubsub` 6.1.0 under Bun 1.4.2. **No real GCP project was used** (D9).

## Verdict

**The doorbell model holds on Pub/Sub.** No job was lost or run twice in any scenario. That covers dropped publishes,
duplicate deliveries, crashes on either side of the ack, expired ack deadlines, and paused and rate-limited queues.
Postgres decided every outcome. The message only woke a worker.

Three things need a design change before Phase 1. Each is small, and none argues for dropping the doorbell:

1. **Rate-limited queues and short delays run at tick speed on GCP.** A throttled doorbell is consumed, and only the
   tick rings the job again. With a 1-minute tick, a queue limited to 10 jobs per second runs about 10 jobs per minute.
   Retry backoff (default 1 s) and lease recovery wait for the tick in the same way. See
   [Delay and the tick](#delay-and-the-tick).
2. **A later doorbell does not recover a crashed worker's job.** The claim skips an active row whose lease expired.
   Only the tick's recovery returns it to the queue. The recovered job is then `delayed` by its retry backoff, so a
   second tick rings it.
3. **The tick's re-ring needs two limits.**
   - A cap per queue: under a backlog, the tick re-rings jobs whose doorbells are only waiting in line.
   - A grace period before a null `rung_at` is due: otherwise the tick re-rings jobs whose publish is still in flight.

   See [D2](#d2-per-job-or-per-queue-doorbells).

**D2: keep per-job doorbells.** Per-queue doorbells drained a 10k backlog 1.5-1.75× faster on the emulator. Under steady
load the modes were the same. Per-job doorbells keep the subscription's backlog equal to the unclaimed jobs. Letting a
per-job doorbell claim several jobs gained nothing.

**Cloud Tasks relay: not needed for v1.0.0.** See [Delay and the tick](#delay-and-the-tick).

## What was built

| File | Role |
|---|---|
| `pubsub.ts` | Emulator client, `describePubsub` guard, and a per-test topology: topic, pull subscription (ack deadline 10 s, retry backoff 1-10 s), dead-letter topic after 5 attempts. No ordering keys. |
| `ring.ts` | `enqueueAndRing`: commit first, then publish `{namespace, queue, jobId}`, then set `rung_at`. A failed publish is reported and swallowed. The job is durable, and the sweep finds it. |
| `worker.ts` | Streaming pull with `flowControl.maxMessages = concurrency`. Per doorbell: take a slot, claim, ack, then run the job under a heartbeat. `batchClaims` claims up to the free slots instead of one job. |
| `sweep.ts` | The tick reduced to the doorbell: `recoverExpiredPostgresLeases`, then re-ring claimable jobs in unpaused queues whose `rung_at` is null or older than a threshold, capped per queue. |
| `store.ts` | Adds `rung_at` to `qcloud_jobs` (spike-only `ALTER TABLE`), plus pause, rate-limit and row helpers. |
| `invariants.ts` | A ledger of claims, runs and settles, checked against the database with task 02's invariant names. |
| `scenario.ts` | One test's topology, publisher, workers, ledger and sweep, closed together. |
| `crashingWorker.ts` | A worker process the crash tests SIGKILL before or after the ack. |
| `tools/emulatorFidelity.ts` | Measures what the emulator reproduces, through the REST pull API. |
| `tools/doorbellGranularity.ts` | The D2 measurement. |

### Ack after the claim, and what that implies

The worker acks once its claim attempt has returned, whether it found a job or not. It never waits for the job to
finish, so the message's lifetime does not depend on how long the job runs. The lease protects the job.

That choice has a consequence. Once a doorbell is acked, flow control counts it as done while its job is still running.
Flow control alone would let the worker pull and claim without limit. So the worker keeps its own slot semaphore.
A doorbell waits for a free slot **un-acked**, and the client library keeps extending its deadline while it waits.
The waiting is bounded. In the D2 runs, no worker held more than `concurrency` waiting doorbells (`maxHeld` was 16
at concurrency 16 in each burst).

Nacking a doorbell because the worker is busy would be wrong. It burns a delivery attempt each time, and a busy fleet
would push valid doorbells into the dead-letter topic.

## Fault scenarios

All eight tests pass on the emulator with Postgres up. The suite ran three times in a row with no failures (about
58 s per run). Each test uses its own topic, so redeliveries cannot leak between tests. Workers use their own
connection pools, as separate processes would.

Every test checks the invariants with task 02's names (`test/model/invariants.ts`):

- `I1.noLoss`;
- `I2.singleLiveLease` (runs never overlap, and no lease is left on a settled job);
- `I2.staleTokenRejected` (each claim settles at most once, a settle under an older claim starts before the next claim, and a completion is under the last claim's token);
- `I3.nothingStuck`;
- `I4.attemptsCounted` and `I4.attemptsBounded`;
- `I5.dlqExactlyOnce`;
- a ledger check: the store's `pulled` events equal the claims the workers saw.

| # | Scenario | Test | What it shows |
|---|---|---|---|
| base | 50 jobs, 2 workers | `delivery.test.ts` | 50 claims, 0 empty, nothing dead-lettered. |
| 4a | Publish throws after the commit | `delivery.test.ts` | Jobs stay `waiting` with `rung_at` null and no worker hears of them. One sweep rings all 5 (a null `rung_at` is due at any threshold). They complete, and a second sweep rings nothing. |
| 4b | Every doorbell published twice | `delivery.test.ts` | 40 doorbells, 40 claim attempts, 20 jobs claimed, 20 empty claims. The empty claims were acked: with client-side extension capped at 1 s, nothing came back past the 10 s deadline. Nothing dead-lettered. |
| 4c | Crash after claim and ack (SIGKILL) | `crash.test.ts` | The doorbell is gone and the live worker hears nothing. The crasher's token is rejected after its lease expires, and again once the job is re-claimed under a new token. The sweep recovers the job (`attempts` 1). It is `delayed` by the 1 s backoff, so a later sweep rings it, and it completes. |
| 4c' | Crash after claim, before ack | `crash.test.ts` | The doorbell comes back about 10 s later (`deliveryAttempt` 2) and claims nothing: the job is still `active` under the dead worker's lease. The sweep recovers it, and it completes with `attempts` 1. |
| 4d | Slow worker past its ack deadline | `crash.test.ts` | Worker A stops extending after 1 s and stalls 15 s, once before a claim and once between a claim and its ack. Both doorbells are redelivered. The late copy of each claims nothing, both jobs run once, and nothing is dead-lettered. |
| 4e | Paused queue | `delivery.test.ts` | 3 doorbells are consumed as empty claims. The sweep never rings a paused queue. After resume, it rings nothing until `rung_at` is older than the threshold, then rings all 3. |
| 4e' | Rate limit 2 per second, 6 jobs | `delivery.test.ts` | The first 6 doorbells claim 2 jobs. The sweep (every 300 ms, 500 ms threshold) re-rings the rest. No 1 s window held more than 2 claims, and all 6 complete. |

The task's step 4c says "the sweep **or a later doorbell** recovers the job". Only the sweep does, as 4c' shows.
That is finding 2 in the verdict.

**Verify:** `bun test packages/store-postgres/spike --grep doorbell-gcp` works as written. Bun 1.4.2 accepts `--grep`
as an alias of `-t`. Run it with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1` and the emulator up. Without the
emulator the doorbell suites are skipped with a warning, the same way the database suites behave. CI does not run the
emulator, so CI skips them.

## D2: per-job or per-queue doorbells

**Recommendation: keep per-job doorbells (the D2 default).** Per-queue doorbells drained a backlog faster, but per-job
doorbells were just as fast under steady load. Per-job doorbells also keep the subscription's backlog equal to the
unclaimed jobs. Batch claims gave per-job doorbells nothing, so they are not part of the recommendation.

**Setup** (`tools/doorbellGranularity.ts`):

- 4 workers at concurrency 16, each with its own pool of 2 connections, running a 5 ms job;
- the tick every 1 s, re-ring threshold 10 s, at most 16 re-rings per queue per tick;
- **burst:** 10k jobs enqueued back to back in batches of 500;
- **trickle:** 1,500 jobs in batches of 5 every 100 ms (about 41 jobs/s offered).

Latency runs from the enqueue call to the claim. Three modes:

- `job`: one doorbell per job, one job per claim;
- `job+batch`: one doorbell per job, each claim takes up to the worker's free slots;
- `queue`: one doorbell per enqueue batch, each claim takes up to the free slots, and a full claim rings again
  (`chained`).

| Shape | Mode | Doorbells per job | Claims per job | Empty claims | Chained | Sweep rings | Latency p50 / p95 / p99 / max (ms) | Jobs/s |
|---|---|---|---|---|---|---|---|---|
| burst | job | 1.059 | 1.038 | 380 | 0 | 592 | 24,539 / 43,521 / 45,064 / 45,725 | 210 |
| burst | job+batch | 1.046 | 1.046 | 465 | 0 | 464 | 22,245 / 36,308 / 37,474 / 37,782 | 254 |
| burst | queue | 0.828 | 0.828 | 356 | 7,928 | 336 | 15,800 / 28,707 / 29,925 / 30,277 | 312 |
| trickle | job | 1.007 | 1.007 | 10 | 0 | 10 | 37 / 56 / 110 / 137 | 41 |
| trickle | job+batch | 1.003 | 1.003 | 1,049 | 0 | 5 | 34 / 48 / 76 / 98 | 41 |
| trickle | queue | 0.219 | 0.219 | 25 | 4 | 25 | 30 / 44 / 72 / 125 | 41 |

Every job in every run completed once. The only invariant reports were about 5,010 `CLAIM.ledger` reports in each
burst. They are an artefact: event retention (`maxQueueEvents`, 10k per queue) trims the oldest `pulled` events once a
queue passes about 3.3k jobs, so the ledger check stops being valid. The trickle runs reported nothing.

What the data shows:

- **Run-to-run variance is large.** An earlier two-mode run of the same burst gave 146 jobs/s for `job` and 256 for
  `queue`. Only gaps that held in both runs count. `queue` beat `job` by 1.75× and 1.49×. The gap between `job` and
  `job+batch` (21%) is within the variance.
- **Under a backlog, every mode is bound by claim transactions.** The 2 connections per worker carry every claim,
  heartbeat and completion. `queue` took 0.83 claims per job (1.21 jobs per claim), against about 1.04 for both
  per-job modes. It also sent 22% fewer doorbells than `job`. This run does not separate the effect of fewer transactions from the
  effect of fewer messages. A real job longer than 5 ms makes the claim a smaller share of the work.
- **Batch claims do not batch per-job doorbells.** In the burst, slots free one at a time, so a doorbell waiting for a
  slot claims one job: 9,999 non-empty claims for 10k jobs. In the trickle, the first doorbell of each batch of 5
  claimed all 5. That turned the other four into empty claims (1,049 of 1,505). Either way, the cost stays at one
  claim transaction per doorbell.
- **Under steady load the modes are the same.** Trickle latency was 30-37 ms at p50 and 72-110 ms at p99 in all three
  modes.
- **Per-queue doorbells cost two things.** The subscription's backlog collapses to about one message per queue, so
  backlog-based autoscaling would need a Postgres metric instead. And a full claim must ring again: a worker that dies
  between the claim and that ring leaves the queue to the tick.
- **The tick re-rings doorbells that are only waiting in the backlog.** In the burst, a job whose doorbell is more than
  10 s old is still claimable, so it is due. That gave 336-592 extra doorbells even with the cap of 16 per queue per
  tick. Without the cap, it would be one doorbell per backlogged job on every tick.
- **A null `rung_at` races the publisher.** Every trickle sweep ring (5-25 per run) hit a job between its insert
  commit and `markRung`. A re-ring by age needs a job to wait 10 s, and the slowest trickle job waited 137 ms. These
  rings are harmless, but the production tick should give a fresh job a grace period before a null `rung_at` is due.
  The other option is to write `rung_at` in the insert transaction and let the age threshold catch a failed publish.

**Revisit per-queue doorbells** if a load test on real Pub/Sub (step 8, or task 17) shows claim transactions are the
bottleneck. D2 says spikes 03 and 04 confirm it, but task 04's steps do not measure granularity. Task 06 decides
whether 04 runs this tool's modes on SQS. The worker keeps the `batchClaims` option for that comparison. It defaults
to on only for per-queue doorbells.

## Delay and the tick

**Pub/Sub has no per-message delay.** Checked three ways:

- **Docs** (all last updated 2026-10-09):
  - The [publisher page](https://docs.cloud.google.com/pubsub/docs/publisher) lists data, attributes and an
    ordering key as the publisher's fields. It has nothing for delivery time.
  - The [retry policy page](https://docs.cloud.google.com/pubsub/docs/subscription-retry-policy) says backoff is
    "applied on a best-effort basis". It adds "We don't recommend using this feature to introduce intentional delays
    in message delivery" and "If you need to schedule deliveries, consider using Cloud Tasks".
- **Emulator, REST:** a publish with `deliverAfter`, `deliveryTime` or `scheduleTime` on the message is rejected with
  `400 INVALID_ARGUMENT`. The same publish without the field succeeds.
- **Emulator, `publishTime`:** a future `publishTime` (2027-01-01) is accepted but ignored. The server overwrote it
  with the current time, and the message was pulled at once.

**Without native delay, the tick rings delayed work.** That is already DESIGN.md's plan for delayed jobs (precision
about 1 minute, a documented limitation). This spike shows the same floor applies to three paths that matter more:

| Path | What waits for the tick | Cheap fix, no Cloud Tasks |
|---|---|---|
| Rate-limited queue | Doorbells beyond the window's quota are consumed as empty claims. | When the claim finds no capacity because of a rate or concurrency limit, it returns when capacity next frees (`rate_expires_at`). The worker then holds the doorbell un-acked, with no slot, and claims again at that time. |
| Retry backoff | A failed job is `delayed` by its backoff (default 1 s). | The worker that failed the job rings it when `run_at` arrives, best effort. If that worker dies, the tick is the backstop. |
| Lease recovery | Recovery marks the job `delayed` by its backoff, so a second tick rings it. Worst case is lease + 2 tick intervals. | The tick rings recovered jobs once their backoff passes, for example with a short in-handler loop (below). |

A further option covers all three. Cloud Scheduler calls `/internal/tick` once a minute. The handler can loop for about
55 s, running the due-scan every 5 s. That gives about 5 s precision with no new service. It costs Control API instance
time.

**The Cloud Tasks relay is not needed for v1.0.0.** It would work: tasks can be scheduled up to
[30 days ahead](https://docs.cloud.google.com/tasks/docs/quotas), and an HTTP target may carry an
[OAuth access token for `*.googleapis.com`](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks), which
can call Pub/Sub `topics.publish`. But it adds a second managed service, its IAM, and a 500 tasks/s dispatch limit per
queue. The fixes above cover the cases that need seconds precision. Long user delays keep the tick's precision. The
relay was not prototyped. Revisit it if users need user-set delays more precise than the tick interval.

## Emulator fidelity

Measured with `tools/emulatorFidelity.ts` (REST pull, so client-side lease management hides nothing) and through the
scenarios.

| Behaviour | Emulator | Real Pub/Sub (docs) | Matters for |
|---|---|---|---|
| Dead-letter forwarding | Forwarded after exactly 5 attempts. `deliveryAttempt` went 1 to 5. | Best effort: "after fewer attempts than configured, or after a few more". Needs the Pub/Sub service agent to have publisher and subscriber roles. | DLQ alerts. Terraform (task 21) must grant those roles. |
| `deliveryAttempt` on deadline expiry | Counted (4c' saw 2). | Counted only when a dead-letter policy exists. Can reset to zero. | Redelivery metrics only. Correctness never depends on it. |
| Retry backoff after nack (min 2 s, max 10 s) | Gaps 8 ms, 3.8 s, 4.0 s, 5.0 s: the first redelivery was immediate, and the rest were not exponential. | Exponential per message, best effort, between the configured bounds (defaults 10 s and 600 s). | DB-error nack loops. **Not faithful.** |
| Ack-deadline redelivery (10 s) | 10.02 s. | Same in principle. | 4c', 4d. |
| Order without ordering keys | 1 inversion in 500. | No order guarantee. | Nothing: Postgres orders the claim. |
| Server-side flow control, throughput, quotas | Not modelled. One process, no limits. | Per-region quotas and throughput limits. | Sizing (task 21). |
| IAM, OIDC push auth, CMEK, retention | Not supported ("IAM operations are not supported", messages are kept indefinitely). | Enforced. | Terraform (task 21), push mode after v1.0.0. |
| Exactly-once delivery, `UpdateTopic` | Not used, not supported. | Available. | Nothing: the doorbell does not need them. |

The emulator's [known limitations](https://docs.cloud.google.com/pubsub/docs/emulator) list IAM, `UpdateTopic`,
retention, subscription expiry, BigQuery delivery and SMTs.

**What needs a real project:** 4a-4d on real Pub/Sub with a Cloud Run worker. That would cover:

- the real retry backoff;
- best-effort dead-lettering;
- DLQ forwarding under real IAM;
- throughput at the per-job message rate;
- streaming-pull behaviour across Cloud Run instance restarts.

## What was and was not run

- **Run:** every scenario on the emulator (gcloud 555 `pubsub-emulator` component, `127.0.0.1:58085`) and the test
  Postgres. Also the D2 measurement, the fidelity probe, and the REST delay probes.
- **Not run: step 8, the real-project run.** D9 is not granted. No `gcloud` writes, no Terraform, nothing paid.
- **Installed on the host:** the gcloud `pubsub-emulator` and `beta` components. The emulator container (opt-in
  `pubsub` profile in `docker-compose.test.yml`) is defined but **untested**: the image did not fit in Docker's disk.
- **Not prototyped:** the Cloud Tasks relay.
- **Not covered by 4e:** group-blocked jobs and per-queue concurrency limits. They use the same claim path and the
  same re-ring path as the rate limit.

## Findings for other tasks

- **Task 06:**
  - The D2 recommendation (per job) and the two re-ring limits, above.
  - The three tick-speed paths, above.
  - "A later doorbell recovers" in DESIGN.md and task 13 is wrong: only the tick recovers.
- **Tasks 11, 13, 20: `rung_at` on every return to claimable.** Retry, recovery, resume and promotion must set
  `rung_at` to null, or return the doorbells to ring (task 02's contract). Otherwise a job rung recently and then
  recovered waits a full re-ring threshold.
- **Task 17 (transport-gcp):**
  - Use the slot semaphore and ack-after-claim, as in `worker.ts`.
  - Set `maxExtensionTime` above the longest wait for a slot.
  - Nack on a database error. That burns delivery attempts, so a long outage pushes doorbells to the DLQ. That is
    harmless, because the tick re-rings every claimable job, but the doorbell DLQ is a metric, not a work queue.
    Alert on it, but never replay it.
  - A malformed doorbell is nacked into the DLQ.
  - With per-job doorbells, claim one job per doorbell. Batch claims gained nothing (see D2).
  - Move `@google-cloud/pubsub` (pinned 6.1.0, a root devDependency for now) into `transport-gcp`.
- **Task 20 (tick):**
  - Cap re-rings per queue per tick. Without the cap, a throttled or long backlog re-rings one doorbell per job on
    every tick. Even with a cap of 16, the 10k per-job burst sent 592 sweep re-rings.
  - Give a null `rung_at` a grace period, or write `rung_at` in the insert transaction. Otherwise the tick re-rings
    jobs whose publish is still in flight. Each trickle run had 5-25 such rings.
- **Task 21 (Terraform):** dead-letter topic and subscription, the service agent's publisher and subscriber roles,
  and a retry policy. Use no ordering keys and no exactly-once delivery.
