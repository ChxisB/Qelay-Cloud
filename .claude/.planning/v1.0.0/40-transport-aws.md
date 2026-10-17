# 40 — transport-aws (SQS)

**Status:** done locally (not run on real SQS: needs D9) · **Depends on:** 10, 04, 16 · **Phase:** 3

## Goal

Production `DeliveryTransport` on Amazon SQS (standard queues), following the behaviour proven in spike 04.

## Scope

In: send, long-poll receive, visibility handling, redrive to a dead-letter queue, queue statistics, LocalStack/ElasticMQ support, authentication, tests.
Out: Terraform (task 42). SQS FIFO is not used (no per-message delay; DESIGN.md D2).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), [spike 04](../../../docs/spikes/04-doorbell-aws.md).

- **Start from the spike's `packages/store-postgres/spike/doorbell-aws/transport.ts`** (with `sqs.ts`, `faults.ts` and
  the scenario list), apply the settled `DeliveryTransport` (task 10) and the changes below, and remove the spike
  directory when this task is done. `faults.ts` and the scenario list also feed task 41.
- **One standard queue per Qelay queue per environment.** `subscribe` and `stats` take the queue; `ring` routes by
  `bell.queue`. SQS cannot filter, so a shared queue would hand a worker bells for queues it does not serve. Adding a
  queue is an infrastructure change (task 42).
- **The delay is per item and relative.** `SendMessageBatch` takes a delay per entry, so one batch carries bells with
  different delays. `DelaySeconds` is the relative `deliverAfterMs` **rounded up** to a whole second (never down: an
  early bell is an empty claim and a lost wake-up). An item over 900 s is `delay-too-long`, not clamped; the tick
  only rings inside the window.
- **`ring` returns a result per item.** `SendMessageBatch` half-succeeds: map each `Failed[]` entry to its item
  (`rejected` or `unreachable`), and after the retry budget a failed call makes every item `unreachable`. `markRung`
  is then called for the `ok` items only. It never throws into an enqueue.
- **Capabilities:** `maxDeliverDelayMs` 900,000; `maxRingBatch` 10; `retryGranularityMs` 1,000; `attemptCount`
  `approximate` (receive count). There is no `ordering` capability.
- **Ack after the claim attempt**, deleting by receipt handle. A stale receipt handle on delete is harmless: count it,
  never fail on it. `nack(retryInMs)` is `ChangeMessageVisibility` at one-second granularity.
- **The doorbell DLQ is a metric.** Alert on it and never replay it (the tick re-rings every claimable job). Set its
  retention to the 14-day maximum. `stats` reports its depth.
- **`stats` says where its numbers come from.** `GetQueueAttributes` counts are approximate by SQS's own definition;
  `source`, `observedAt` and `maxStalenessMs` are returned, and a number is `null` when CloudWatch or the call is
  unavailable.
- **D2 (per job or per queue) is not decided for SQS.** It stays per job. The load test on real SQS is task 41's and
  needs D9; this task records the request count per job so cost at the per-job rate can be computed.
- **Emulator is not the service.** ElasticMQ's receive counts, stale-handle deletes and `Failed[]` are not SQS's.
  Every result in the Result says "emulator" or "real".

## Steps

1. **Capabilities:** `maxDeliverDelayMs` 900,000 (15 minutes, the `DelaySeconds` maximum), `maxRingBatch` 10, `retryGranularityMs` 1,000, `attemptCount: 'approximate'`. The tick rings delayed jobs inside this window with a relative `deliverAfterMs`; beyond it, jobs wait in Postgres until they fall inside the window (task 20).
2. **Topology convention:** one standard queue per Qelay queue per environment, one dead-letter queue per environment (or per queue; follow task 04's finding) with 14-day retention, `maxReceiveCount` redrive policy, resource names derived from `namespace` and `queue` with a documented, collision-safe encoding (SQS names allow only alphanumerics, hyphen, underscore, up to 80 characters; hash long names and keep the mapping discoverable).
3. **`ring`:** `SendMessageBatch` in groups of 10 within the size limit, `DelaySeconds` per entry from the relative `deliverAfterMs` rounded up, retry transient errors with backoff and report partial batch failures per item as a `RingResult`; items still failing after the budget are `unreachable`, so `rung_at` stays null for them.
4. **`subscribe`:** long polling (`WaitTimeSeconds` 20) with up to `capacity()` messages (demand-driven; a busy worker receives nothing and `refresh()` re-evaluates), a visibility timeout equal to a short claim window, deletion **after the claim attempt** (not after job completion); `ChangeMessageVisibility` to retry sooner on a handler error; graceful `close` that finishes in-flight receives.
5. **`stats`:** `GetQueueAttributes` for visible, in-flight and delayed counts and the dead-letter queue's depth; an oldest-message age from the `ApproximateAgeOfOldestMessage` CloudWatch metric, with `source`, `observedAt` and `maxStalenessMs`. The counts are approximate by SQS's own definition; mark them as such.
6. **Auth and environments:** the default AWS credential chain; explicit region; a custom endpoint option for LocalStack and ElasticMQ; no credentials in logs.
7. **Bun compatibility:** verify the AWS SDK v3 SQS client under Bun (HTTP handler, long polls, abort on shutdown). Record any workaround.
8. Run the contract suite (task 16) and the fault scenarios from spike 04 as automated tests. List the gaps between LocalStack/ElasticMQ and real SQS in the Result.
9. If D9 allows, run against a real account with throwaway queues, then delete them.

## Acceptance

- The contract suite passes against the SQS emulator, with the same assertions as the local and GCP transports.
- Each spike 04 fault scenario is an automated test and passes.
- Publish failure or a partial batch failure never fails an enqueue; `markRung` is called only for the bells the broker took, and the affected jobs stay unrung for the tick.
- A delay is rounded up to a whole second, never down; an item over 900 s is `delay-too-long`.
- A bell for queue A is never delivered to a subscriber of queue B.
- `packages/store-postgres/spike/doorbell-aws/` no longer exists, and neither does `packages/store-postgres/spike/doorbell/`
  unless `spike/db-access/` (task 20) still imports its `store.ts`, `ring.ts` or `sweep.ts`. Task 17 left `store.ts`,
  `invariants.ts` (with its test), `ring.ts` and `sweep.ts` there because the two later spikes import them. Port the
  `packages/transport-gcp/test/` ledger, scenario and worker helpers (`ledger.ts`, `scenario.ts`, `testWorker.ts`) rather than the spike's.
- `stats()` marks approximate counts and tolerates CloudWatch being unavailable.
- Real-account run done and cleaned up, or marked not run.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/transport-aws test/contract
```

## Risks / notes

- SQS standard queues deliver at least once and may reorder. That is fine by design (the doorbell model tolerates duplicates and reordering); do not add ordering assumptions.
- The 15-minute delay cap means long delays rely on the tick; the Transport page (task 35) must show the effective delay precision.
- Visibility timeout and claim latency interact: if a claim can take longer than the visibility timeout, the doorbell is redelivered, which is harmless but wasteful; measure it.
- SQS bills per request, and the doorbell is one message per job: compute the request count per job from this task's tests and state the monthly cost at 1M jobs in the Result rather than guessing.

## Result

**Done locally, against ElasticMQ 1.7.1 and PostgreSQL 18.6; not run on real Amazon SQS or CloudWatch.** Step 9 (a real
account) was **not run**: D9, the go-ahead for real cloud resources, was not given. Every result below is an
**emulator** result unless it says otherwise, and none is "real". ElasticMQ ran as the JVM jar on the host (the
compose native image and the Docker-backed gate are owed at the end of the plan, as the user asked for tasks 1 by 1
without Docker). Decisions and the gaps are in [docs/limits.md](../../../docs/limits.md) sections 9 and 11 and the
dated amendment of [the gate document](../../../docs/spikes/06-phase0-gate.md).

**Built** (`packages/transport-aws/src/`)

- `transport.ts`: `SqsTransport implements DeliveryTransport`. Capabilities: `maxDeliverDelayMs` 900,000,
  `maxRingBatch` 10, `retryGranularityMs` 1,000, `attemptCount: 'approximate'`, no `ordering`. A missing region is a
  `TransportError` at construction; `QCLOUD_AWS_REGION` is never read from the machine.
- `publisher.ts`: `SendMessageBatch` in groups of 10 within the size limit; `DelaySeconds` per entry from
  `deliverAfterMs` rounded **up**; more than 900,000 ms is `delay-too-long`, never clamped; transient errors retried
  with backoff; each `Failed[]` entry mapped to its own item (`rejected` or `unreachable`); never throws into an
  enqueue.
- `receiver.ts`: long poll of 20 s, demand-driven (asks for what `capacity()` has free), visibility equal to a short
  claim window with a `ChangeMessageVisibility` heartbeat every third of it, delete after the claim attempt, a stale
  handle counted and harmless, `nack(retryInMs)` as a visibility change at 1 s granularity, an unsettled handler
  nacked at 0, `close` aborts the poll and returns waiting bells.
- `monitoring.ts`, `deadLetters.ts`: `stats` from `GetQueueAttributes` with the dead-letter queue's depth, the age
  from CloudWatch `ApproximateAgeOfOldestMessage` (cached, 60 s by default), `source`, `observedAt` and
  `maxStalenessMs`, and `null` for what is unavailable; the dead-letter queue is a metric, never replayed
  (`peekDeadLetters` reads without deleting).
- `provision.ts`: `ensureQueue` and `removeQueue` for tests and emulators: standard queue plus dead-letter queue with
  14-day retention, `maxReceiveCount` redrive, tags. **Task 42's Terraform must create the same names, tags and
  settings.** `names.ts` is the reversible, collision-safe name encoding.
- `options.ts`, `queueUrls.ts`, `errors.ts`, `metrics.ts` (`billedRequests`, the request counters), `bell.ts`.

**Wired**

- `QCLOUD_TRANSPORT=aws-sqs` with `QCLOUD_AWS_REGION` and optional `QCLOUD_AWS_SQS_ENDPOINT` in `qcloud-tick`
  (`packages/maintenance`), the Control API (`runtime/settings.ts`, `open.ts`, with `name: 'aws-sqs'` and
  `doorbellDeadLetter: true`) and `examples/orders`. `GET /capabilities` now answers from the transport's own
  declaration, not a literal. `packages/control-api/Dockerfile` copies `transport-aws` (not built).

**Tests** (113 pass in `packages/transport-aws`, `test/contract/sqs.test.ts` and `test/support/doorbell`; the full
suite is 3,757 pass, 83 skip, 0 fail in 411 files with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1`)

- Contract suite on the SQS emulator: `test/contract/sqs.test.ts`, 12 tests, the same assertions as the local and GCP
  transports.
- Every spike 04 scenario is a test: `delivery` (baseline, 2a publish lost, 2a half a batch, 2b duplicate bell, 2e
  paused, 2e rate-limited, queue A never reaches queue B), `crash` (SIGKILLed worker, slow worker with and without a
  heartbeat), `delay` (rounded up, 900 s, pre-ring by the tick, retry ring), `outage` (database down). Unit suites
  `names`, `publisher`, `ring`, `stats`, `receive`, `subscribe.faults`, `deadLetters` use a stub client and always run.
- `cost.test.ts` counts requests per job.

**Measured** (emulator)

- Requests per job: 1.94 to 1.99 at concurrency 10 (100 jobs: 10 sends, 82 to 87 receives, 100 deletes, 0
  heartbeats, 0 nacks), 2.13 at concurrency 1. **About $0.84 per million jobs** at the list price of $0.40 per million
  requests ($0.44 after the free million); idle long polls about $0.05 a month per subscribed queue per worker
  process. The count is client-side and carries over; the **price was not checked against the live page**.
- Bells that beat their `markRung` and needed the worker's 25 ms recheck: 6 of 50 on ElasticMQ, every job completed
  with no tick (below).

**Emulator versus real SQS** (the list the task asks for; each is a place a green suite does not carry over)

1. Stale receipt handle on delete: ElasticMQ answers `ReceiptHandleIsInvalid` and leaves the message; real SQS may
   answer success without deleting.
2. Redrive: ElasticMQ dead-letters after the N-th receive, SQS on receive N+1, and counts dead-letter retention from
   the original enqueue.
3. Attribute counts are exact on ElasticMQ and approximate, up to about a minute stale, on SQS.
4. ElasticMQ never duplicates; a standard queue is at-least-once.
5. ElasticMQ fills a receive to 10; SQS may return fewer, so a real busy worker may receive more often.
6. `DelaySeconds` and batch limits are enforced only with `sqs-limits = strict`.
7. No CloudWatch: the age metric is tested against a stub. Metric name, dimension and unit are unverified.
8. `TagQueue` is unverified on ElasticMQ (`ensureQueue` ignores a tag failure).
9. Throughput, latency, IAM, KMS, VPC endpoints and the bill are not represented at all.

`scripts/sqs-fidelity.ts` probes 1 to 6 and runs against a real account with `--real --region <r>`; it was run
against ElasticMQ only.

**Decisions and findings**

- **A bell can beat its `markRung`** (F-40-1). First seen as 4 to 6 empty claims in a 50-job burst with a test
  worker that did not recheck. The SDK worker already rechecks once after 25 ms when a job of the queue is waiting
  (task 20); the test worker now does the same (`recheck`, default on) and the baseline needs no tick. **Not a new
  open decision**, and the store is unchanged. A consumer without the recheck waits for the tick's re-ring.
- **Two defects the new tests found, fixed with a failing test first:** the receiver subtracted running handlers from
  `capacity()` twice (a busy worker asked for too few bells), and `stats` reported a queue's depth twice.
- **No test-only `heartbeat` knob in the production API.** Heartbeat loss is simulated by a client wrapper in
  `testWorker.ts` that drops the visibility extensions of the claim window.
- **Shared fault-test helpers** moved from the spike to `test/support/doorbell/` (`ledger`, `ringing`, `lines`,
  `util`) so the SQS and Pub/Sub suites use one ledger and one invariant checker.
- **Spike disposal is complete.** `packages/store-postgres/spike/` (93 files, including `ported/`, `harness.ts`,
  `claimOnce.test.ts`, `leaseRecovery.test.ts`, `crashingClaimer.ts`, `doorbell/` and `doorbell-aws/`) is deleted;
  `docs/PORTING.md` lost its 69 spike rows and `scripts/port.ts` now requires `--out`. The ElasticMQ config is
  `test/support/elasticmq.conf`.
- **Bun:** the AWS SDK v3 SQS and CloudWatch clients (3.1140.0) work under Bun 1.4.2 against ElasticMQ, long polls and
  abort on shutdown included. No workaround; only explicit connection and request timeouts. Tried against an
  emulator only.
- **For task 41:** the scenario list is `packages/transport-aws/test/{delivery,crash,delay,outage}.test.ts`; the fault
  wrappers are `test/support/doorbell/ringing.ts` and the client wrapper in `testWorker.ts`.
- **For task 42:** queue and dead-letter queue names and settings of `ensureQueue`; IAM for send, receive, delete,
  change visibility and get attributes on the queues, `cloudwatch:GetMetricData` for `stats`; alarms on the
  dead-letter depth and age; `QCLOUD_AWS_REGION` set on every process.

**Not run**

- Real SQS or CloudWatch, any `aws` write, any Terraform (D9).
- The compose ElasticMQ native image, PostgreSQL 16, and the fidelity tool against the image (owed at the end).
- `bun run test:model`: nothing in the store or core changed.
- The AWS price was not looked up; D2 stays "per job" on emulator counts.
