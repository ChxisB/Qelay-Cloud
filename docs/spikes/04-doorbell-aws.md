# Spike 04: the doorbell on SQS

- **Task:** [04](../../.claude/.planning/v1.0.0/04-spike-doorbell-aws.md), run on 2026-10-13.
- **Spike code:** `packages/store-postgres/spike/doorbell-aws/`, on top of the task 01 port and reusing task 03's ledger,
  invariants and store helpers. **Removed in task 40** (2026-10-15): the transport became
  [`packages/transport-aws`](../../packages/transport-aws/), the scenarios are its `test/` files (`delivery`, `crash`,
  `delay`, `outage`, `cost`) and `test/contract/sqs.test.ts`, the ledger and checker are `test/support/doorbell/`, and
  the fidelity tool is [`scripts/sqs-fidelity.ts`](../../scripts/sqs-fidelity.ts). File links below name the spike's
  files as they were; read them in the git history or in those places. D2 is answered for the emulator's request count
  in [docs/limits.md](../limits.md) section 11.
- **Environment:** ElasticMQ 1.7.1 (`softwaremill/elasticmq-native`, `sqs-limits = strict`, opt-in `sqs` profile in
  `docker-compose.test.yml`), Postgres 16 from the same file, `@aws-sdk/client-sqs` 3.1140.0 under Bun 1.4.2.
  SQS limits were read from the AWS SQS Developer Guide (quotas and API reference) on 2026-10-13.
  **No real AWS account was used** (D9). The spike client only talks to a loopback endpoint with dummy credentials.

## Verdict

**The doorbell model holds on SQS.** No job was lost or run twice in any scenario: dropped and half-dropped publishes,
duplicate bells, crashes on either side of the delete, expired visibility timeouts, paused and rate-limited queues,
delayed bells, failing jobs, database outages and malformed bodies. Postgres decided every outcome.

**The `DeliveryTransport` sketch in DESIGN.md section 5 does not survive as written.** It needs six changes, found by
SQS and then checked against what task 03 saw on Pub/Sub. None argues against the doorbell, and each is small. They are
listed in [Interface changes](#interface-changes) and the spike's
`transport.ts` is the proposal in code:

1. `ring` reports a result **per bell**, because a batch publish can half succeed.
2. The delay is **relative** (`deliverAfterMs`), rounded **up**, and refused above `capabilities.maxDeliverDelayMs`.
3. `capabilities` gains `maxRingBatch`, `attemptCount` and `retryGranularityMs`. `ordering` can go.
4. `subscribe` is **demand-driven**: the worker says how many jobs it can start, not a fixed concurrency.
5. The handler gets a `Delivery` with `ack()`, `nack(retryInMs)` and the attempt count, and the transport holds the
   doorbell while the handler runs.
6. `stats()` says where its numbers come from and how stale they are, and returns `null` for what a broker cannot say.

**Two findings change other tasks, not the interface:**

- **Retry backoff does not have to run at tick speed on AWS.** Task 03 found that on Pub/Sub a failed job waits for
  the tick, because Pub/Sub has no per-message delay. SQS can hold a bell for 15 minutes, so the worker that fails a
  job rings its retry for `run_at` (`ringRetry`). The same worker code does the right thing on both clouds, because the
  choice follows `capabilities.maxDeliverDelayMs`: on Pub/Sub it is 0 and the retry falls to the tick.
- **Bells are fungible, so `rung_at` counts bells, not jobs.** A bell's `jobId` is a hint. The claim takes the next job in
  queue order. When a publish half fails, the jobs left waiting are not necessarily the ones whose bells failed. What
  bounds invariant 3 is the tick's **age threshold**, not the null check. See [Findings](#findings-for-other-tasks).

**D2 (per-job or per-queue doorbells) was not measured on SQS.** Task 04's steps do not ask for it, and ElasticMQ
throughput says nothing about SQS. See [D2](#d2-not-measured-on-sqs).

## What was built

| File | Role |
|---|---|
| `transport.ts` | The proposed interface: `Bell`, `RingResult`, `Delivery`, `Subscription`, `TransportCapabilities`, `TransportStats`, `parseBell`. |
| `sqsTransport.ts` | The SQS adapter. `ring` chunks by 10 and reads `Failed[]` per entry. `subscribe` is a long-poll loop that asks for `min(10, capacity - inFlight)`, with a `ChangeMessageVisibility` heartbeat every third of the visibility timeout. `nack` sets the visibility timeout itself. `stats` reads queue attributes. |
| `sqs.ts` | Loopback-only client, `describeSqs` guard (skips with a warning unless `QCLOUD_REQUIRE_SQS=1`), and a per-test topology: standard queue plus DLQ with a redrive policy, no FIFO. |
| `ring.ts` | `enqueueAndRing` (commit, then ring, then set `rung_at` for the bells taken), and `ringRetry`. |
| `sweep.ts` | The tick reduced to the doorbell: lease recovery, a re-ring for claimable jobs whose `rung_at` is null or old, and a delayed pre-ring for jobs due inside the window. |
| `worker.ts` | A worker on any `DeliveryTransport`. Claim once per bell, ack after the claim attempt, run the job under a lease heartbeat, ring the retry of a failed job. |
| `faults.ts` | Transport wrappers: `FailingTransport`, `PartialTransport`, `DuplicatingTransport`, `LimitedDelayTransport`. They wrap any transport. |
| `scenario.ts`, `wait.ts`, `crashingWorker.ts`, `lines.ts` | Per-test queue and DLQ, polling helpers, and a worker process the crash tests SIGKILL. |
| `tools/sqsFidelity.ts` | Probes what ElasticMQ does against what the AWS docs say. |

The spike also changed one file from task 03: the ledger and checker in
`doorbell/invariants.ts`. See
[Invariants](#invariants-and-one-checker-change).

### Ack after the claim

Same answer as task 03: the worker deletes the bell once its **claim attempt** has returned, whether it found a job or
not, and never waits for the job. The lease protects the job. The heartbeat on the bell covers only the claim attempt.

SQS makes the cost of the alternative concrete. A bell held until the job ends would need `ChangeMessageVisibility`
calls for as long as the job runs, and SQS caps the total extension at 12 hours from the first receive. A bell
deleted after the claim has no such limit, and a crash after the delete loses only the wake-up, which the tick restores.

### Demand-driven receive

`ReceiveMessage` is pull with a count, so the worker can ask for exactly what it can use. Asking for more than the free
slots would hide the surplus bells for a visibility timeout from idle workers, and would hide the backlog from an
autoscaler. The transport therefore asks for `min(10, capacity() - inFlight)`, where `capacity()` is the worker's free job
slots and `inFlight` is deliveries handed out and not yet settled.

The accounting has one trap, found while writing the crash tests. A slot taken when the handler **starts**, plus the
transport's own `inFlight` subtraction, counts the same delivery twice, and a slow claim then blocks the next bell. The
fix: a slot is taken only after a claim returns a job, so a delivery in flight already counts against capacity and an
empty claim never holds a slot.

## Fault scenarios

27 tests are selected by the task's Verify command. All pass: 23 need Postgres and ElasticMQ, and 4 use a stub client
and need neither. The 22 emulator tests that existed first ran three times in a row with no failure (about 56 s per run).
The 5 added afterwards ran in the full gate and in the Verify run. Each test has its own queue and DLQ, and each worker
has its own connection pool and transport, as separate processes would.

Every emulator test checks task 02's invariants: `I1.noLoss`, `I2.singleLiveLease`, `I2.staleTokenRejected`,
`I3.nothingStuck`, `I4.attemptsCounted`, `I4.attemptsBounded`, `I5.dlqExactlyOnce`, and the ledger check `CLAIM.ledger`.

| # | Scenario | File | What it shows |
|---|---|---|---|
| base | 50 jobs, 2 workers | `delivery.test.ts` | 50 claims, 0 empty, 5 `SendMessageBatch` calls for 50 bells, receives that return several bells, nothing dead-lettered. |
| 2a | Publish throws after the commit | `delivery.test.ts` | Jobs stay `waiting` with `rung_at` null and no worker hears of them. One sweep rings all 5, they complete, a second sweep rings nothing. |
| 2a' | A batch publish that half succeeds (bells 3 and 7 of 12 rejected) | `delivery.test.ts` | Ten bells give ten claims, but the two jobs left waiting are **not** the two whose bells failed. `rung_at` is null for exactly the rejected jobs. The tick finds the two that remain, whichever they are. |
| 2b | Every bell sent twice | `delivery.test.ts` | 40 bells, 40 claim attempts, 20 jobs claimed, 20 empty claims. The empty claims were deleted: nothing came back after the visibility timeout. |
| 2c | Crash after the delete (SIGKILL) | `crash.test.ts` | The bell is gone and the live worker hears nothing. The crasher's token is rejected after its lease expires and again after re-claim. The sweep recovers the job (`attempts` 1) and it completes. |
| 2c' | Crash before the delete | `crash.test.ts` | The bell returns after one visibility timeout (`attempt` 2) and claims nothing, because the job is still `active` under the dead worker's lease. The sweep recovers it. |
| 2d | Slow past the visibility timeout, no heartbeat | `crash.test.ts` | A 5 s stall against a 3 s timeout, once before a claim and once between claim and delete. Both bells are redelivered to another worker. Late copies claim nothing, both jobs run once. |
| 2d' | Slow, with the heartbeat | `crash.test.ts` | A 7 s stall against a 3 s timeout: no redelivery, 4 or more `ChangeMessageVisibility` calls. |
| 2e | Paused queue | `delivery.test.ts` | 3 bells are consumed as empty claims. The sweep never rings a paused queue, and after resume rings nothing until `rung_at` is older than the threshold. |
| 2e' | Rate limit 2 per second, 6 jobs | `delivery.test.ts` | The first 6 bells claim 2 jobs. The sweep re-rings the rest. No 1 s window holds more than 2 claims on the database clock. |

As in task 03, a later bell does not recover a crashed worker's job (2c, 2c'). Only the tick's recovery does.

## Delay

SQS accepts `DelaySeconds` 0 to 900 per message, in whole seconds. Step 3 asked what happens at and beyond the limit, so
the tests check both sides, against the transport and the service itself (`delay.test.ts`):

| Test | Result |
|---|---|
| `deliverAfterMs: 1500` | Rung as 2 s. All three bells arrived at or after `run_at` (within 250 ms of clock slack between the database and the emulator) and within about 2 s of it. No empty claims. |
| Exactly 900 s | Accepted. The queue shows one delayed message. |
| 900,001 ms | Refused by the transport as `delay-too-long` for every bell, with nothing sent. |
| `DelaySeconds` 901 sent straight to the service | Rejected (`InvalidParameterValue`). |
| Delay beyond the limit through `enqueueAndRing` (a 1 s limit stands in for 900 s) | The job is **not rung** and counts as `deferred`. Its `rung_at` stays null. |
| The tick with `preRingWindowMs` | Too early: nothing, because the window is clamped to the transport's limit. Inside the window: one delayed bell per job, due at `run_at`. A second sweep rings nothing. The bell arrives at `run_at` and the claim finds the job. |
| A failing job with `backoff: 1500` | The worker rings the retry for `run_at` (`retriesRung` 3 of 3). The second claim came at least 1.5 s after the first, with no tick, and no empty claim. |
| The same, with `ringRetries: false` | The job stays `delayed` and is durable. Only the tick finishes it, late. |

**`rung_at` means "a doorbell is deliverable at this time".** It is now for an immediate bell and `run_at` for a delayed
one, so the tick's pre-ring query is `rung_at IS NULL OR rung_at < run_at`. A job with a bell still on its way is left
alone, and a retry that moves `run_at` past the old bell is rung again. Task 03 set `rung_at` to the ring time, and that
cannot tell a delayed bell from a late one.

**At the boundary** a job due in 15 minutes and 1 second cannot be rung yet. The tick rings it once `run_at` is inside
the window. With a 1-minute tick and a 900 s limit, the window needs to be at least one tick interval plus the worst
tick lateness. The sweep clamps `preRingWindowMs` to the transport's limit, so on SQS a window of 900 s is the natural choice.

## Receive loop

`receive.test.ts`:

| Test | Result |
|---|---|
| 25 bells queued, then a worker with 25 slots starts | The first receive returns 10 (`largestReceive` 10, the SQS limit). All 25 complete. |
| A worker with 2 slots and blocked jobs, 8 bells | It receives 2 and stops. Six bells stay visible (`depth` 6, `inFlight` 0) until a second worker takes them while the first is still full. |
| Long poll of 20 s on an idle queue | A job enqueued mid-poll completes in under 2 s. `close()` returns in under 2 s: the abort ends the poll. |
| Database error with 1 s backoff, 3 bells, 2.6 s | Each bell comes back about once a second, 3 to 9 claim errors in total, nothing dead-lettered. When the database returns, all complete without a tick. |
| Database error with no backoff, `maxReceiveCount` 3, 4 bells | Each bell is delivered 3 times (12 claim errors), then moved to the DLQ. The jobs are untouched, one sweep re-rings all 4, and they complete. The DLQ keeps 4 bells and is only a metric. |
| Two bodies that are not bells | Each is delivered 3 times and then dead-lettered (6 malformed deliveries). Valid bells enqueued beside them complete. |
| A heartbeat after a `nack` | The bell stays hidden for the nack's 8 s. (The test failed before the fix below.) |
| `stats()` | `depth`, `inFlight`, `delayed` and `deadLetterDepth` are right. `oldestAgeMs` is `null`. |

**A bug found by reading and fixed with a test.** A heartbeat tick that landed after a `nack` reset the visibility
timeout to the queue default and undid the retry delay. The test above failed without the fix (the bell was redelivered before
the 6.5 s mark, instead of after 8 s) and passes with it: a settled delivery is no longer heartbeated.

**Request arithmetic.** SQS bills per request, and a batch of 10 is one request. Per bell, the transport makes
about 0.1 send calls, 0.1 to 1 receive calls (fewer when the queue is deep), and 1 delete. `DeleteMessageBatch` would cut
the delete to 0.1. The transport deletes singly, so that is a v1 optimisation for task 40. A queue that is empty most
of the time costs one long poll per worker every 20 s.

## Interface changes

DESIGN.md section 5, against the spike's `transport.ts`:

| # | DESIGN.md sketch | Proposed | What SQS showed |
|---|---|---|---|
| 1 | `ring(bells): Promise<void>` | `ring(bells): Promise<RingResult[]>`, one `{ok}` or `{ok: false, reason: 'delay-too-long' \| 'rejected' \| 'unreachable'}` per bell, in order | `SendMessageBatch` succeeds as a call while single entries fail (`Failed[]`). `rung_at` must be set only for the bells taken, so the caller needs to know which. A void result would hide partial failure (2a'). |
| 2 | `opts.deliverAt` (absolute) | `opts.deliverAfterMs` (relative), rounded up to whole seconds and never down. Above `capabilities.maxDeliverDelayMs` the bell fails with `delay-too-long`. | SQS delays are relative and in whole seconds. An absolute time would make the transport read a clock, and a bell that arrives before `run_at` is an empty claim and a lost wake-up. |
| 3 | `capabilities: { maxDeliverDelayMs, ordering }` | `{ maxDeliverDelayMs, maxRingBatch, attemptCount: 'approximate' \| 'none', retryGranularityMs }`. Drop `ordering`. | The SDK needs the batch size to chunk, whether `attempt` means anything for poison handling, and how fine a `nack` delay can be. Nothing reads `ordering`: neither transport uses ordering keys and Postgres orders the claim. |
| 4 | `subscribe(queue, handler(bell), { concurrency })` | `subscribe(handler, { capacity: () => number }): { refresh(), close() }` | A fixed concurrency forces the transport to hold bells it cannot use. Demand-driven receive leaves the backlog visible and gives it to idle workers. `refresh()` tells the transport a slot freed. |
| 5 | `handler(bell): Promise<void>` | `handler(delivery)` with `delivery: { bell \| null, attempt \| null, ack(), nack(retryInMs?) }`. The transport extends its hold while the handler runs, and a handler that returns without settling nacks. | Ack-after-claim needs an explicit ack. SQS has no queue-level retry backoff, so the retry time must travel with the nack. A body that is not a bell must reach the handler (`bell` null), because only the handler knows to nack it toward the DLQ. |
| 6 | `stats(queue): { depth, oldestAgeMs, deadLetterDepth }` | `stats(): { depth, inFlight, delayed, oldestAgeMs \| null, deadLetterDepth, source, observedAt, maxStalenessMs }` | Queue attributes are approximate and can lag a minute or more. They carry no age at all: that is a CloudWatch metric. The interface has to say "unknown" and show how stale the rest is. |

Open point for task 10: the spike's transport is built for **one cloud queue** that carries bells for every Qelay queue
(the bell names its queue), so `subscribe` has no `queue` argument. DESIGN.md's sketch subscribes per queue. The spike
does not settle which is right. It only shows the worker works without the argument.

### Pub/Sub against SQS

| | Pub/Sub (task 03) | SQS (this spike) | Interface consequence |
|---|---|---|---|
| Per-message delay | None | 0 to 900 s, whole seconds | `maxDeliverDelayMs`, relative delay |
| Publish batch | Up to 1,000 per request | 10 per request, success per entry | `maxRingBatch`, per-bell results |
| Receive | Streaming pull. The server pushes up to a static flow-control limit. | Long poll, up to 10 per call, count chosen per call. 20 s maximum wait. | Demand-driven `capacity()`. On Pub/Sub the transport maps it onto flow control plus task 03's slot semaphore. |
| Holding a delivery | The client library extends the ack deadline up to `maxExtensionTime`. | Explicit `ChangeMessageVisibility`, whole seconds. | The transport's duty, in the handler contract. |
| Retry delay on nack | A subscription-wide retry policy, best effort. The emulator did not follow it. | Per message, set by the consumer on nack. None at queue level. | `nack(retryInMs)`, `retryGranularityMs` |
| Delivery count | `delivery_attempt`, only with a dead-letter policy, and it can reset. | `ApproximateReceiveCount` on every receive, approximate. | `attempt: number \| null`, `attemptCount` |
| Dead-lettering | Dead-letter topic, best effort, needs the service agent's roles. | Redrive policy: a bell is moved once its receive count would exceed `maxReceiveCount`. | The DLQ is a metric on both. Never replay it. |
| Depth and age | Cloud Monitoring metrics with lag. | `GetQueueAttributes`, approximate, can lag a minute or more. Age only in CloudWatch. | `stats()` with `source`, `observedAt`, `maxStalenessMs`, `null` |
| Duplicates | At least once. | At least once (standard queue). | Tested on both with a duplicating transport. |

## D2: not measured on SQS

Task 03's write-up says task 06 decides whether this spike runs the per-job and per-queue modes on SQS. Task 04's steps
do not include it. I did not run it, for two reasons:

- ElasticMQ is a single native process with no quotas. Its throughput says nothing about SQS, and task 03's
  measurement was dominated by claim transactions in Postgres, which is the same here.
- On SQS the doorbell's request cost is per request, not per message. Per-queue doorbells would save less than they
  seem to: 10 bells already travel in one send and one receive.

**Recommendation: keep per-job doorbells on AWS too.** Everything in this spike assumes it, and the worker can claim one
job per bell. Revisit with a load test against real SQS (task 40 or 41), not an emulator.

## Invariants, and one checker change

The ledger in `doorbell/invariants.ts` assumed a job settles once. That holds for crashes and not for a job that
**fails and retries**, which settles once per claim. Tests with a failing job failed the checker with
`I2.staleTokenRejected: settled 2 times`, which was a defect in the checker, not in the transport.

The rule is now: a claim settles at most once, an applied settle's token must belong to one of the job's claims, a
settle under an older claim must have **started before the next claim**, and a completed job's completion is under its
last claim's token. The last two are what still catch a stale holder being accepted.

`doorbell/invariants.test.ts` feeds the checker hand-built ledgers: a legitimate fail-and-retry passes, and a stale
holder applied after the next claim fails. Task 03's suites were re-run against the emulator after the change
and pass.

## ElasticMQ against AWS

Measured with `tools/sqsFidelity.ts` and through the scenarios.

| Behaviour | ElasticMQ 1.7.1 | Real SQS (docs) | Matters for |
|---|---|---|---|
| `DelaySeconds` 900 and 901 | 900 accepted, 901 rejected (`InvalidParameterValue`). | Same. | Delay tests. Faithful. |
| Batch of 11 | `TooManyEntriesInBatchRequest`. | Same. | Faithful. |
| A batch with one bad entry | `Failed` for that entry, the rest succeed. | Docs allow a per-entry failure or a whole-request rejection. | The per-bell result handles both. |
| Redrive, `maxReceiveCount` 3 | 3 deliveries, then the bell is in the DLQ. | 3 deliveries, then the move happens on the receive after. | The same observable. Faithful. |
| Visibility 0 and 1 on nack | Back after 5 ms and 1,018 ms. | Immediately and 1 s. | Nack tests. Faithful. |
| `DelaySeconds` 2 | First receivable after 2,018 ms. | About 2 s, never earlier. | Faithful. |
| Long poll on an empty queue and with an arrival at 500 ms | 2,018 ms empty, and 507 ms with a message. | Same. | Faithful. |
| Queue attribute counts right after a send | Exact and immediate. | Approximate, can lag a minute or more. | `stats()` tests are tighter than AWS allows. The freshness fields are what carry the difference. |
| Delete with a stale receipt handle | Throws `ReceiptHandleIsInvalid` and does not delete. | Can return success without deleting. | The transport never relies on the result. |
| Duplicate delivery of one message | Never happens. | Standard queues are at least once. | 2b duplicates the **bell** at the publisher. A broker-side duplicate of one message has not been exercised. |
| Receiving fewer than asked | Returned 10, 10, 10, 0 from 30. | Fewer per call is allowed, even with messages available. | The `largestReceive` assertion of 10 is tighter than AWS guarantees. |
| `ApproximateReceiveCount` at scale, short polling | Not modelled. | Approximate. Short polling samples a subset of servers. | Worker logic never depends on either. The transport only long polls. |
| DLQ retention | Not modelled. | Counted from the message's **original** enqueue time, so a DLQ with the default retention can expire bells early. | Terraform (task 42): set the DLQ retention to the maximum. |
| 12 hour visibility cap, in-flight quota | Not modelled. | 12 hours total extension from first receive. A documented in-flight limit per standard queue. | Neither applies: bells are deleted right after the claim attempt. |
| IAM, KMS, VPC endpoints, throughput quotas | Not modelled. | Enforced. | Terraform (task 42), sizing. |

**What needs a real account:** 2a to 2d on real SQS (step 6), plus the receive-count and short-poll behaviour, the
dead-lettering move, `Failed[]` from a real partial failure, and request cost at the per-job rate.

## What was and was not run

- **Run:** every scenario above on ElasticMQ and the test Postgres, the fidelity probe, the stub-client tests, and the
  full gate with Postgres, ElasticMQ and the Pub/Sub emulator all required (`QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1
  QCLOUD_REQUIRE_PUBSUB=1`), plus `bun run test:model`.
- **Not run: step 6, the real-account run.** D9 is not granted. No `aws` call, no Terraform, nothing paid, no queue
  outside the emulator.
- **Not measured:** D2 on SQS, throughput, request cost.
- **Not covered:** FIFO queues (excluded by the task), short polling, KMS, a broker-side duplicate of one message.
- **Not exercised by a test at the transport level:** `Failed[]` from a real broker. ElasticMQ returns it for a bad
  entry (the probe shows this), but no bell the transport can send makes it reject one. The parsing is covered by the
  stub-client tests, and the worker's reaction by the fault wrapper in 2a'.

**Verify:** `bun test packages/store-postgres/spike --grep doorbell-aws`, with `QCLOUD_REQUIRE_DB=1
QCLOUD_REQUIRE_SQS=1` and both containers up. Without the emulator the 23 emulator tests are skipped with a warning. The 4
stub-client tests always run. CI does not start ElasticMQ, so CI skips the emulator tests.

## Findings for other tasks

- **Task 06:**
  - The six interface changes above, and the open point about one cloud queue or one per Qelay queue.
  - Task 03's finding that retry backoff runs at tick speed is **specific to clouds without per-message delay**. SQS can
    ring a retry for `run_at`. Pub/Sub still needs the cheap fixes in task 03.
  - D2 was not measured on SQS (above).
  - `rung_at` is "deliverable at", not "rung at", and **the tick's age threshold, not the null check, bounds
    invariant 3**, because bells are fungible.
- **Task 10 (core interfaces):** start from the spike's `transport.ts`, not the DESIGN.md sketch.
- **Task 16 (transport-local):** implement the same interface: per-bell results, a relative delay, `Delivery` with
  `nack(retryInMs)`, a `capacity`-driven subscribe, and `stats()` with nulls.
- **Task 17 (transport-gcp):** `maxDeliverDelayMs` is 0, so a delayed `ring` fails with `delay-too-long`. Flow control
  is static, so `capacity()` maps onto it with task 03's slot semaphore. `nack(retryInMs)` can only approximate the
  subscription's retry policy: report that through `retryGranularityMs`.
- **Task 19 (SDK worker):** ack after the claim. Ring a failed job's retry if `run_at - now` is within
  `maxDeliverDelayMs`, else leave it to the tick. Nack a body that is not a bell, with backoff.
- **Task 20 (tick):**
  - The pre-ring window is clamped to `maxDeliverDelayMs` and must be at least one tick interval plus the worst tick
    lateness.
  - Set `rung_at` to "deliverable at" (now, or `run_at` for a delayed bell), only for the bells the broker took.
  - Re-ring by age. A re-ring of a job whose bell is only waiting in line is harmless but wasteful, so keep task 03's cap
    per queue.
- **Task 40 (transport-aws):**
  - Port `sqsTransport.ts`: long poll 20 s, demand-driven receive, heartbeat, per-message `nack` visibility, `Failed[]`
    per entry, a close that aborts the poll.
  - Use `DeleteMessageBatch` once the delete rate matters.
  - Size `maxReceiveCount` and the backoff together. With 1 s doubling to 30 s, a `maxReceiveCount` of 5 dead-letters a
    bell after about 30 s of database outage (deliveries at about 0, 1, 3, 7 and 15 s, then the move on the next
    receive), and 10 after about 3 minutes. A dead-lettered bell is harmless because the tick
    re-rings every claimable job. **Alert on the DLQ, never replay it.**
  - Move `@aws-sdk/client-sqs` (pinned 3.1140.0, a root devDependency for now) into `transport-aws`.
- **Task 41 (contract suite):** the fault wrappers in `faults.ts` and the scenario list are transport-agnostic and are
  the natural fault set. The `Scenario` class is SQS-bound, but the worker is not.
- **Task 42 (Terraform AWS):** a standard queue plus a DLQ with **14 day retention**, a redrive policy, a visibility
  timeout comfortably above the claim round trip, no FIFO, a default receive wait of 20 s, and IAM for send, receive,
  delete, change visibility and get attributes. Add CloudWatch alarms on DLQ depth and on the oldest message's age.
