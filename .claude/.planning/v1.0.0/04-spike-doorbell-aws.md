# 04 — Spike: doorbell on SQS

**Status:** done (real-account step not run, needs D9) · **Depends on:** 01 · **Phase:** 0 (spike)

## Goal

Validate the `DeliveryTransport` interface against a second, different cloud **before** it hardens around Pub/Sub. If the
interface survives SQS, it is probably right. This spike exists to find where it does not.

## Scope

In: an SQS doorbell publisher and worker on the spike store, run against ElasticMQ or LocalStack, plus a paper review of the interface.
Out: the production `transport-aws` (task 40), Terraform (task 42).

## Steps

1. Run ElasticMQ (or LocalStack SQS). Create a **standard** queue with a redrive policy to a DLQ. Do not use FIFO: per-message delay is not available on FIFO queues, and Postgres decides order anyway.
2. Reuse the task 03 fault scenarios against SQS: publish failure, duplicate delivery, worker crash after claim, visibility-timeout expiry, paused or rate-limited queue.
3. **Delay:** use `DelaySeconds` for delays up to the SQS limit (about 15 minutes). Check how the maintenance tick pre-rings jobs whose `run_at` falls inside that window, and what happens at the boundary (a delay slightly over the limit).
4. **Receive loop:** long polling, batch receive (up to 10), and `ChangeMessageVisibility` as the heartbeat for slow doorbell processing. Decide whether the worker acks (deletes) before or after the claim; the answer must match task 03.
5. **Interface review.** Write the SDK `DeliveryTransport` sketch from DESIGN.md section 5 as the spike's interface, then list every place SQS and Pub/Sub differ:
   `capabilities.maxDeliverDelayMs`, batching limits, `subscribe` semantics (streaming vs polling), `stats()` sources (CloudWatch vs Cloud Monitoring, with different lag), and redelivery counting for poison handling. Propose concrete changes to the interface.
6. **Real account (needs D9):** if allowed, run scenarios 2a-2d once against real SQS, then delete the queues. Otherwise mark not run.
7. Write `docs/spikes/04-doorbell-aws.md` including the proposed interface changes.

## Acceptance

- The fault scenarios pass on SQS with the task 02 invariants checked.
- The write-up lists every interface change SQS requires, or states that none is needed, with reasoning.
- Delay behaviour at and beyond the SQS limit is tested, not assumed.
- Real-account run is either done and cleaned up, or marked not run.

## Verify

```bash
bun test packages/store-postgres/spike --grep doorbell-aws
```

## Risks / notes

- `stats()` is where the clouds differ most: SQS exposes approximate queue attributes directly, Pub/Sub depth comes from a metric with lag. The interface must expose freshness, not pretend the numbers are exact.
- ElasticMQ and LocalStack differ from real SQS in redrive and visibility edge cases. List the gaps.

## Result

Done 2026-10-13 on ElasticMQ 1.7.1. **Step 6, the real-account run, was not run** (D9). The write-up is
[docs/spikes/04-doorbell-aws.md](../../../docs/spikes/04-doorbell-aws.md).

**Verdict.** The doorbell model holds on SQS. No scenario lost a job or ran one twice, and Postgres decided every
outcome. **The `DeliveryTransport` sketch in DESIGN.md section 5 needs six changes** (recorded in task 06's inputs):

1. `ring` returns a result per bell: `SendMessageBatch` can half succeed.
2. The delay is relative (`deliverAfterMs`), rounded up, and refused above `capabilities.maxDeliverDelayMs` (900 s).
3. `capabilities` adds `maxRingBatch`, `attemptCount` and `retryGranularityMs`. `ordering` can go.
4. `subscribe` is demand-driven (`capacity()`), so a busy worker leaves bells queued for idle workers.
5. The handler gets a `Delivery` with `ack()`, `nack(retryInMs)` and the attempt count. The transport holds the bell
   while the handler runs.
6. `stats()` returns `source`, `observedAt` and `maxStalenessMs`, and `null` for what a broker cannot say
   (`oldestAgeMs` on SQS).

Two findings are not interface changes:

- **Retry backoff need not run at tick speed on AWS.** The failing worker rings the retry for `run_at`. Task 03's
  finding 1 is specific to a cloud with no per-message delay.
- **Bells are fungible**, so `rung_at` counts bells, not jobs. The tick's age threshold, not the null check, bounds
  invariant 3.

**Built.** `packages/store-postgres/spike/doorbell-aws/` (18 files, none over 300 lines), reusing task 03's ledger and
store helpers:

- `transport.ts`, `sqsTransport.ts`, `sqs.ts`: the proposed interface, the SQS adapter (chunked `ring` with per-entry
  results, demand-driven long-poll receive, `ChangeMessageVisibility` heartbeat, nack with a retry time, queue-attribute
  stats), and a loopback-only client with a per-test queue and DLQ.
- `ring.ts`, `sweep.ts`, `worker.ts`: publisher and `ringRetry`, the tick reduced to the doorbell plus a delayed
  pre-ring, and a transport-agnostic worker.
- `faults.ts`, `scenario.ts`, `wait.ts`, `crashingWorker.ts`, `lines.ts`: transport fault wrappers (failing, partial,
  duplicating, limited delay) and the test scaffolding.
- `delivery.test.ts`, `crash.test.ts`, `delay.test.ts`, `receive.test.ts`, `ring.test.ts`: 27 tests.
- `tools/sqsFidelity.ts`: the ElasticMQ against AWS probe.
- `@aws-sdk/client-sqs` 3.1140.0 as a root devDependency, and an opt-in `sqs` profile in `docker-compose.test.yml`
  (ElasticMQ, `127.0.0.1:59324`).

**Changed from task 03.** `doorbell/invariants.ts` assumed one applied settle per job, which fails for a job that
fails and retries. The rule is now: a claim settles at most once, and a settle under an older claim must have started
before the next claim. `doorbell/invariants.test.ts` covers it, and task 03's suites pass after the change.

Nothing is ported, so `docs/PORTING.md` has no new rows.

**Fault scenarios (step 2).** All pass with task 02's invariants checked: publish failure (whole and half a batch),
duplicate bells, a crash after and before the delete, a slow worker with and without the heartbeat, and paused and
rate-limited queues.

**Delay (step 3).** Tested at and beyond the limit, against the transport and the service. 900 s is accepted, 900,001 ms
is refused by the transport (`delay-too-long`) and `DelaySeconds` 901 is rejected by the service. A delay beyond the
limit defers the job, and the tick pre-rings it once `run_at` is inside the window. A failing job's retry is rung for
`run_at`, with no tick and no early claim.

**Receive loop (step 4).** The worker deletes after the claim attempt, as in task 03. A receive returns up to 10 bells,
and a worker asks for no more than its free slots. A long poll wakes on arrival and closes in under 2 s. A database error
nacks with a backoff. Without it, an outage dead-letters the bells and the tick still finishes every job: the DLQ is a
metric, not a work queue. A bug found by reading, a heartbeat that undid a nack's retry time, was fixed after a test
reproduced it.

**Interface review (step 5).** The six changes above, a Pub/Sub against SQS table, and one open point for task 10: whether
a transport is built for one cloud queue (the spike) or per Qelay queue (the sketch).

**D2.** Not measured on SQS. ElasticMQ throughput says nothing about SQS. Recommendation: per job, as on Pub/Sub, to be
revisited with a load test on real SQS.

**Emulator fidelity.** ElasticMQ matched the docs on delay limits, batch limit, redrive count, nack timing and long
polling. It differs on attribute-count lag, stale-handle deletes, broker-side duplicates and several AWS quotas. The
write-up lists each gap and what it affects.

**Verify.** `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 bun test packages/store-postgres/spike --grep doorbell-aws` passes
27 tests in 63 s (23 need Postgres and ElasticMQ, 4 use a stub client). The 22 emulator tests that existed first passed on 3
consecutive runs, about 56 s each. Without the emulator the 23 skip with a warning. CI does not run ElasticMQ.

**Gate.** With Postgres, ElasticMQ and the Pub/Sub emulator up, and `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1
QCLOUD_REQUIRE_PUBSUB=1` set, the full gate passes: 51 tests across 12 files, 124 s. `bun run test:model` also passes.

**Not run or not verified:**

- step 6 (real SQS): no `aws` call, no Terraform, nothing paid;
- D2 on SQS, throughput and request cost;
- FIFO queues (excluded), short polling, KMS, and a broker-side duplicate of one message;
- `Failed[]` from a real partial failure: parsing is covered by stub-client tests, and the worker's reaction by a fault wrapper.
