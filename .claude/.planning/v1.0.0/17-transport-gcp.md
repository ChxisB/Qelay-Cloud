# 17 — transport-gcp (Pub/Sub)

**Status:** done · **Depends on:** 10, 03 · **Phase:** 1

## Goal

Production `DeliveryTransport` on Google Cloud Pub/Sub, following the behaviour proven in spike 03.

## Scope

In: publish, pull-subscribe with flow control, queue statistics, dead-letter handling, emulator support, authentication, tests.
Out: Terraform for topics and subscriptions (task 21). A Cloud Tasks delay relay: **not in v1.0.0** (task 06; it is
documented in the gate write-up and was not prototyped).

## Gate decisions (task 06)

Binding. Evidence: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md), [spike 03](../../../docs/spikes/03-doorbell-gcp.md).

- **Implement the settled `DeliveryTransport`** (task 10), starting from `packages/store-postgres/spike/doorbell/`,
  which moves here. Its scenarios become this package's automated tests, and the spike directory is removed by this
  task.
- **One topic per environment, one filtered subscription per Qelay queue.** `ring` publishes with the queue (and
  namespace) as message attributes and routes by `bell.queue`; `subscribe(queue, ...)` and `stats(queue)` address that
  queue's subscription. A bell can never reach a worker that does not serve its queue. A shared channel for a group of
  queues is out of v1.0.0. Adding a queue is an infrastructure change (task 21).
- **Delay is the tick's, not the transport's.** `maxDeliverDelayMs: 0`, so `ring` reports `delay-too-long` for any
  item with a delay, and the tick rings delayed jobs only once due. Delay, retry backoff and rate-limit resumption
  are therefore tick-speed on this transport: seconds-level precision needs the in-process tick (task 20) on an
  always-on worker. The Transport page and `docs/limits.md` say so.
- **`ring` never fails an enqueue and never throws for a broker failure.** It returns a result per item
  (`ok`, `rejected`, `unreachable`); after the retry budget an item is `unreachable` and its job stays unrung for the
  tick.
- **Demand-driven receive.** The `capacity()` callback sets flow control and `refresh()` re-evaluates it; a busy
  worker takes no bells, so the subscription backlog stays equal to the unclaimed jobs, which is what an autoscaler
  reads (D2: per job).
- **Ack after the claim attempt, never after the job.** A database error nacks with a backoff; a malformed
  body (`Delivery.bell` is null) goes to the dead-letter topic, as in spike 03.
- **The doorbell DLQ is a metric.** Report `deadLetterDepth` in `stats`, alert on it (task 71), and never replay it:
  the tick re-rings every claimable job anyway.
- **Bun and the official client come first.** Before building on it, re-run the spike's check of the client under
  Bun (streaming pull, shutdown, a restart of the process) and settle the fallback in step 7. The spike ran it against
  the emulator only; the real service is the D9 item in step 9.

## Steps

0. **Bun check first:** step 7, done before anything else is written, so a fallback decision does not arrive at the end.
1. **Capabilities:** `maxDeliverDelayMs: 0` (no per-message delay); delayed jobs reach workers through the tick (task 20). `maxRingBatch` is Pub/Sub's per-request message limit; `attemptCount` and `retryGranularityMs` are declared as spike 03 measured them.
2. **Topology convention:** one topic per environment, one **filtered** subscription per queue, a dead-letter topic with `maxDeliveryAttempts`. Resource names derived from `namespace` and `queue` with a documented, collision-safe encoding (queue names can contain characters Pub/Sub does not allow).
3. **`ring`:** batch publish within Pub/Sub's per-request message and size limits; retry transient errors with backoff; return a per-item `RingResult` so the caller marks only the bells that were taken and leaves the rest unrung for the tick.
4. **`subscribe`:** streaming pull with flow control from `capacity()`; ack **after the claim attempt**, not after the job finishes (spike 03); nack on handler errors; extend ack deadlines only as long as the claim is running.
5. **`stats`:** undelivered message count and oldest-unacked age from Cloud Monitoring metrics, DLQ depth from the dead-letter subscription. Return `source`, `observedAt` and `maxStalenessMs` (these metrics lag), and `null` for a number the service cannot give.
6. **Auth and environments:** Application Default Credentials; `PUBSUB_EMULATOR_HOST` for tests; explicit project ID option.
7. **Bun compatibility:** verify the official client (gRPC) under Bun, including streaming pull and shutdown. If it misbehaves, use the client's REST/`fallback` mode or a thin REST pull implementation. Record which, and the reason.
8. Run the contract suite (task 16) against the emulator, plus the fault scenarios from spike 03 as automated tests. Gaps between emulator and real service go in the Result: the emulator's retry backoff is not exponential, and its dead-lettering and throughput are not the service's.
9. If D9 allows, run the suite once against a real project with a throwaway topic and subscription, then delete them.

## Acceptance

- The contract suite passes against the Pub/Sub emulator.
- Every fault scenario from spike 03 is an automated test and passes.
- A publish failure, including a half-failed batch, never fails an enqueue; the affected jobs stay unrung for the tick.
- A bell for queue A is never delivered to a subscriber of queue B (filtered subscription test on the emulator).
- `packages/store-postgres/spike/doorbell/` no longer exists.
- `stats()` returns freshness and handles the metrics API being unavailable (degrades, does not throw into the worker loop).
- The real-project run is done and cleaned up, or marked not run.

## Verify

```bash
bun run typecheck && bun run lint && bun run format:check && bun run architecture
bun test packages/transport-gcp test/contract
```

## Risks / notes

- The Pub/Sub client and Bun: streaming pull is the likeliest trouble spot. It is step 0 for that reason. The spike's pass was against the emulator, not the service.
- Rate-limited queues, retry backoff and lease recovery run at tick speed on this transport (a queue limited to 10 jobs/s ran about 10 per minute under the 1-minute tick). Do not try to fix that inside the transport.
- Resource-name encoding must be reversible or recorded, otherwise the panel cannot map subscriptions back to queues.
- Never log message payloads (doorbells carry only identifiers, but keep the habit).

## Result

**Done locally, on the Pub/Sub emulator and PostgreSQL 18.6, not on the Docker PG 16 of CI, and not against a real Google Cloud project.**
The user told me to defer Docker-backed runs until every task is done. That departs from CLAUDE.md's "run the gate with
`QCLOUD_REQUIRE_DB=1`" rule; the Docker run is owed at the end. Step 9 (a run against a real project) was **not run**: D9, the
go-ahead for real cloud resources, was not given. Details of every decision: [docs/spikes/06-phase0-gate.md](../../../docs/spikes/06-phase0-gate.md),
section "The Pub/Sub transport (task 17)", items (a) to (j), and its dated amendment on the spike directory.

**Built** (`packages/transport-gcp/src/` unless noted)

- `transport.ts`: `PubSubTransport implements DeliveryTransport`. `ring` publishes per queue with `queue` and `namespace` attributes and
  returns one `RingResult` per item; `subscribe` opens a streaming pull on the queue's filtered subscription; `stats` read Cloud
  Monitoring. Capabilities: `maxDeliverDelayMs: 0`, `maxRingBatch: 1000`, `attemptCount: 'approximate'`, `retryGranularityMs: 1000`.
- `publisher.ts`: batch publish within the per-request limits, a retry budget with backoff, a per-item result; a half-failed batch reports
  its failed items as `unreachable` and the rest as `ok`.
- `receiver.ts`: demand-driven receive from `capacity()`/`refresh()`, `maxHeld` (default 8) un-acked bells, a local FIFO for bells that
  have no capacity yet, `nack(retryInMs)` held up to `maxNackHoldMs` (30 s). A malformed body reaches the handler with `bell` null; the
  worker nacks it and the subscription's dead-letter policy takes it. `bell.ts` is the message codec.
- `names.ts`: the reversible, collision-safe resource-name encoding for namespace and queue (documented in the file and tested).
- `monitoring.ts`: stats from Cloud Monitoring with `source`, `observedAt` and `maxStalenessMs` (lag 300 s plus a 30 s cache), `null`
  where the service cannot say (`inFlight`), `delayed` 0, DLQ depth, and a degrade to an `unavailable` result instead of a throw.
- `provision.ts`: topic, filtered subscriptions and dead-letter topology for tests and the emulator; the default topology (ack deadline
  30 s, 5 delivery attempts, backoff 1 to 10 s) is the shape task 21 has to create in Terraform, under the same names.
- `options.ts`: project ID, emulator host (`PUBSUB_EMULATOR_HOST` or option), Application Default Credentials otherwise.
- Tests, in `packages/transport-gcp/test/`: `names`, `ring`, `receive`, `stats`, `delivery` and `crash` (the spike 03 scenarios), `ledger`, and the helpers
  (`support`, `scenario`, `ledger`, `testWorker`, `crashingWorker`, `lines`, `ringing`). In `test/contract/`: `pubsub.test.ts` (the
  contract suite against the emulator), `harness.ts` (new: the harness types and `ContractOptions`), and `transport.ts` (a per-suite
  `timeoutMs`).
- `packages/store-postgres/spike/doorbell/`: the files this package replaces (the transport, the worker, the receive scenarios) are gone.

**Design problems found and how they were handled** (none reverses the gate; each is in the gate document)

1. **`packages/store-postgres/spike/doorbell/` is not fully removed.** Five files remain (`invariants.ts`, `invariants.test.ts`, `ring.ts`,
   `store.ts`, `sweep.ts`): `spike/db-access/` (tick, fleet, claimPath) and `spike/doorbell-aws/` import them. The step says this task removes
   the directory; deleting the five would break suites tasks 20 and 40 own. Task 20 removes `spike/db-access/`, task 40 removes
   `spike/doorbell-aws/`, and whichever goes last removes `spike/doorbell/`. Recorded in the gate document (item j) and in tasks 20, 22 and 40.
2. **A heartbeat extends a lease to the store's `leaseMs`, not the claim's.** A worker's `PostgresStore` has to be built with the worker's
   lease length. The tests and the crashing worker do so; task 30 (the worker) must too.
3. **Recovering a dead worker's lease spends an attempt.** A job enqueued with the default `attempts: 1` fails for good
   (`max_attempts_exceeded`) when its worker dies, so the crash scenarios enqueue with `attempts: 3`. This is the store's rule (task 12) and
   not new, but spike 03's scenarios never exercised it.
4. **`allowExcessMessages: true` is required on the subscriber.** With `false` a WAIT-style close took seconds; `true` closes at once and
   the flow-control bound is enforced by the receiver's own `maxHeld`. A regression test covers it.
5. **Bun and the official client.** Step 0 (Bun check) was done first: streaming pull, shutdown and a restart of the process work under Bun
   1.4.2 against the emulator, so the official client is kept and no REST fallback was built. Only the emulator was tried (item a).
6. **The emulator ignores flow control**, so "a busy worker does not hoard bells" cannot be shown on it. It is a `test.todo`, with the
   receiver's own `maxHeld` bound tested instead (item d).
7. **The contract suite's 5 s Bun default timeout broke three Pub/Sub tests in a full run** (a redelivery test takes 4 to 5 s with the
   topology set up; the first file was cold and the fixed `contract` namespace was shared, so one timeout cascaded). Fixed with an explicit
   `timeoutMs` option on the contract suite, 30 s in `pubsub.test.ts`. Reproduced with `--timeout 4000` first, and re-run green.

**Decisions on the gate's open points**

- Default topology: ack deadline 30 s, `maxDeliveryAttempts` 5, retry backoff 1 to 10 s. Tests use 10 s and 0 to 1 s.
- `maxHeld` 8, `maxNackHoldMs` 30 s. A hold burns no delivery attempt; a retry hint longer than the cap is cut to it, and the bell is
  nacked to the broker when the hold ends. A nack with no hint goes back at once and counts towards `maxDeliveryAttempts`.
- A malformed body is `bell: null`; the worker nacks it and the subscription dead-letters it after `maxDeliveryAttempts` (tested: five
  deliveries, then the dead-letter subscription holds it; exact on the emulator, best-effort on the service). The DLQ is a metric
  (`stats().deadLetterDepth`) and is never replayed.
- `stats`: `source: 'cloud-monitoring'`, `maxStalenessMs` 330,000, `inFlight` null, `delayed` 0; an emulator or an unavailable API gives
  `'unavailable'` with null numbers and never throws into the worker loop.

**Acceptance**

- *The contract suite passes against the Pub/Sub emulator:* yes, `test/contract/pubsub.test.ts`, 12 tests, also with a 4 s default timeout.
- *Every fault scenario from spike 03 is an automated test and passes:* yes, all seven rows of spike 03's table, as nine tests under the
  ledger checks (I1 to I5 and "every claim is a `pulled` event"). `delivery.test.ts` (6): a baseline, 4a (the ring fails after commit;
  a batch the broker half takes), 4b (a duplicate bell), 4e (a paused queue; a rate-limited queue). `crash.test.ts` (3): 4c (a crash after the
  ack), 4c' (a crash before the ack) and 4d (a worker past its ack deadline), with a real SIGKILLed Bun process. `ledger.test.ts` (5)
  checks the checker on hand-built ledgers, so a checker that cannot fail would be noticed.
- *A publish failure, including a half-failed batch, never fails an enqueue; the affected jobs stay unrung for the tick:* yes. `ring.test.ts`
  (a batch with items that cannot be rung, an unreachable service retried for its budget and then reported, never thrown) and, end to end
  through `PostgresStore`, `delivery.test.ts` 4a (the jobs stay unrung, the tick rings them, only the bells taken are marked rung).
- *A bell for queue A is never delivered to a subscriber of queue B:* yes, on the emulator: the contract suite's "routes a bell only to
  subscribers of its queue" and `ring.test.ts` "a queue is served by its own subscription only, even when names look alike".
- *`packages/store-postgres/spike/doorbell/` no longer exists:* **no.** Five files remain (see problem 1); the directory goes with the last
  spike that imports it.
- *`stats()` returns freshness and handles the metrics API being unavailable:* yes (`stats.test.ts`), against a stub Monitoring client; the
  emulator has no Monitoring API, so the live API's metric names and filters are **unverified**.
- *The real-project run is done and cleaned up, or marked not run:* **marked not run** (D9 not granted). No real project, topic or
  subscription was created or touched.

**Checked** (Pub/Sub emulator on 127.0.0.1:58085, PostgreSQL 18.6 on 127.0.0.1:55442, TCP only)

- `bun run typecheck`, `lint`, `format:check` and `architecture` (337 files within 300 lines) exit 0.
- `bun test packages/transport-gcp test/contract` with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1`: 106 pass, 1 todo, 0 fail, 10 files
  (105 s). `bun test test/contract` alone: 41 pass (memory, Postgres and Pub/Sub). `bun test --timeout 4000 test/contract/pubsub.test.ts`: 12 pass.
- The full repository `bun test` before the contract timeout fix: 1,262 pass, 60 skip, 1 todo, 4 fail. Three were the contract timeout
  cascade (fixed above). The fourth is `spike/db-access/fleet.test.ts` "at the cap, direct", which fails every time on PG 18.6
  (`ERR_POSTGRES_CONNECTION_REFUSED` besides 53300). It is a spike that task 20 removes and was not touched by this task; recheck it in
  the Docker run on PG 16. The full run was not repeated after the fix.

**Not done / not verified**

- A real Google Cloud project (step 9, D9), and so: IAM and authentication with Application Default Credentials, real retry backoff
  (the emulator's is not exponential), exact dead-lettering, real throughput, real flow control and the Bun client against the real service.
- Cloud Monitoring: the metric names, the filter and the lag are written from the documentation and tested against a stub only.
  `inFlight` is always null and `delayed` always 0.
- "A busy worker does not hoard bells" (`maxHeld` against a service that honours flow control): `test.todo`.
- Docker, PG 16, `QCLOUD_REQUIRE_DB=1` on PG 16, PgBouncer, TLS, ElasticMQ, the `fleet` spike's cap test, and `bun run test:model` (no
  queue semantics changed in this task, so no deep run was owed).
- `spike/doorbell/` is not deleted (see problem 1). `bun run test:contract` is still the task-41 placeholder.
- Nothing committed, pushed or published; no real cloud resource touched.

**Next:** task 18 (SDK: Queue, the producer). Tasks needing real cloud resources (21, 22's real runs, 40 onward) stop at the real-cloud
steps until D9 is granted.
