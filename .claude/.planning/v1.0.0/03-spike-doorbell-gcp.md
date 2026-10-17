# 03 — Spike: doorbell on Pub/Sub

**Status:** done (real-project step 8 not run, needs D9) · **Depends on:** 01 · **Phase:** 0 (spike)

## Goal

Prove the doorbell model on GCP: a Cloud Run-style pull worker consuming Pub/Sub doorbells while Postgres stays authoritative,
with no job lost or double-run under redelivery, dropped publishes and worker crashes.

## Scope

In: a spike publisher and worker using the spike store from task 01, the Pub/Sub emulator for most checks, and a short real-project run if D9 allows.
Out: the production `transport-gcp` (task 17), Terraform (task 21).

## Steps

1. Run the Pub/Sub emulator (`gcloud beta emulators pubsub start` or the emulator container). Create a topic and a pull subscription with a dead-letter topic and a retry policy.
2. Publisher: after the job insert commits, publish `{namespace, queue, jobId}`. Set `rung_at` on success.
3. Worker: streaming pull with flow control (`maxMessages` = concurrency). On a doorbell run the claim query, then ack. Ack **after** the claim attempt, not after the job finishes. The lease protects the job, not the message.
4. Fault scenarios, each an automated test:
   - publish fails after commit → the sweep re-rings jobs with `rung_at` null or older than the threshold;
   - the same doorbell is delivered twice → the second claim finds nothing and acks;
   - the worker crashes after claiming → the lease expires, the sweep or a later doorbell recovers the job, the attempt is counted;
   - the worker is slow and the ack deadline expires → redelivery is harmless;
   - queue is paused or rate-limited → the doorbell is consumed and the job is re-rung when it becomes claimable.
5. **Doorbell granularity (D2):** measure per-job doorbells against per-queue doorbells for message count, claim attempts per job and latency, using 10k jobs.
6. **Delay:** confirm Pub/Sub has no per-message delay in the emulator and in the current docs; record the tick-based alternative and whether a Cloud Tasks relay is worth it (Cloud Tasks task publishing to Pub/Sub via an OAuth-authenticated HTTP target). Prototype the relay only if time allows.
7. **Emulator fidelity:** list what the emulator does not reproduce (dead-letter forwarding, retry backoff and ordering are the likely gaps). Anything that matters must be re-run against a real project.
8. **Real project (needs D9):** if a project is supplied and applying is allowed, repeat scenarios 4a-4d once with real Pub/Sub and a small Cloud Run worker, then tear everything down. Record cost and cleanup. Otherwise stop and report what remains.
9. Write `docs/spikes/03-doorbell-gcp.md`.

## Acceptance

- All five fault scenarios pass against the emulator with the invariants from task 02 checked.
- The write-up contains the D2 measurement and a recommendation.
- The emulator-vs-real gap list is explicit, and the real-project run is either done and cleaned up, or marked not run.
- A statement on whether the Cloud Tasks relay is needed for v1.0.0.

## Verify

```bash
bun test packages/store-postgres/spike --grep doorbell-gcp
```

## Risks / notes

- Ack timing is the classic mistake: acking after the job finishes ties message lifetime to job duration and breaks long jobs.
- Never run real-project steps without D9. State in the Result exactly which were run.
- Pub/Sub ordering keys are not needed (Postgres decides order); do not enable them.

## Result

Done 2026-10-13 on the emulator. **Step 8, the real-project run, was not run** (D9). The write-up is
[docs/spikes/03-doorbell-gcp.md](../../../docs/spikes/03-doorbell-gcp.md).

**Verdict.** The doorbell model holds on Pub/Sub. No scenario lost a job or ran one twice, and Postgres decided every
outcome. Three findings change the design (recorded in task 06's inputs):

1. Rate-limited queues, retry backoff and lease recovery run at tick speed on GCP. The write-up gives three cheap
   fixes that need no Cloud Tasks.
2. Only the tick recovers a crashed worker's job. Step 4c's "or a later doorbell" is wrong: the redelivered doorbell
   claims nothing while the row is `active` under the dead lease.
3. The tick's re-ring needs a per-queue cap and a grace period before a null `rung_at` is due.
   - Without the cap, a backlog re-rings jobs whose doorbells are only waiting in line.
   - Without the grace period, the tick re-rings jobs whose publish is still in flight.

**Built.** `packages/store-postgres/spike/doorbell/` (12 files, 1,519 lines, none over 300), on top of the task 01 port:

- `pubsub.ts`: emulator client, `describePubsub` guard, a per-test topology (topic, pull subscription with retry
  policy, dead-letter topic after 5 attempts).
- `ring.ts`, `worker.ts`, `sweep.ts`, `store.ts`: publisher (commit, publish, set `rung_at`), streaming-pull worker
  (slot semaphore, ack after the claim, optional batch claims), the tick reduced to recovery plus capped re-rings,
  and the spike's `rung_at` column.
- `invariants.ts`, `scenario.ts`, `crashingWorker.ts`: a claim/run/settle ledger checked against the database with
  task 02's invariant names, the test scenario, and a worker process to SIGKILL.
- `delivery.test.ts`, `crash.test.ts`: the eight scenario tests.
- `tools/emulatorFidelity.ts`, `tools/doorbellGranularity.ts`: the fidelity probe and the D2 measurement.
- `@google-cloud/pubsub` 6.1.0 as a root devDependency, and an opt-in `pubsub` profile in `docker-compose.test.yml`.

Nothing is ported, so `docs/PORTING.md` has no new rows.

**Fault scenarios (step 4).** All five pass on the emulator, with task 02's invariants checked after each:

| Step | Test | Outcome |
| --- | --- | --- |
| 4a publish fails after commit | `delivery.test.ts` | Jobs wait with `rung_at` null; one sweep rings all 5; they complete. |
| 4b duplicate delivery | `delivery.test.ts` | 40 doorbells, 20 jobs claimed, 20 empty claims acked; nothing redelivered or dead-lettered. |
| 4c crash after claim (after and before the ack) | `crash.test.ts` | Stale token rejected twice; the sweep recovers the job with `attempts` 1; it completes once. |
| 4d slow worker past the ack deadline | `crash.test.ts` | Both doorbells redelivered; the late copies claim nothing; each job runs once. |
| 4e paused and rate-limited queues | `delivery.test.ts` | Doorbells consumed as empty claims; the sweep re-rings after resume or when the window frees; no window over the limit. |

**D2 (step 5): keep per-job doorbells.** Setup: 4 workers at concurrency 16, a 5 ms job and 2 connections per
worker, with a 10k burst and a 1,500-job trickle.

| Mode | Burst: doorbells/job | Burst: claims/job | Burst: p50 latency | Burst: jobs/s | Trickle: p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| per job | 1.059 | 1.038 | 24.5 s | 210 | 37 / 110 ms |
| per job, batch claims | 1.046 | 1.046 | 22.2 s | 254 | 34 / 76 ms |
| per queue | 0.828 | 0.828 | 15.8 s | 312 | 30 / 72 ms |

- **Per queue** drained the burst 1.49× faster (1.75× in an earlier run), with 22% fewer doorbells. It costs the
  backlog signal for autoscaling, and it needs a chain that a crash breaks.
- **Batch claims** did not batch: about one claim transaction per job either way. The 21% gap is within run-to-run
  variance (`job` gave 146 and 210 jobs/s in two runs).
- **No lost or double-run job.** Every job completed once. The only invariant reports were `CLAIM.ledger` artefacts
  in the bursts: event retention trims `pulled` events above about 3.3k jobs per queue.
- **D2 on SQS.** D2 says spikes 03 and 04 confirm it, but task 04's steps do not measure granularity. Task 06
  decides whether 04 runs the same modes on SQS.

**Delay (step 6).** Pub/Sub has no per-message delay. The docs (updated 2026-10-09) list no delivery-time field, and
the emulator rejects `deliverAfter`, `deliveryTime` and `scheduleTime` with `400 INVALID_ARGUMENT` and ignores a
future `publishTime`. **The Cloud Tasks relay is not needed for v1.0.0** and was not prototyped.

**Emulator fidelity (step 7).** The DLQ forwarded after exactly 5 attempts, and ack-deadline redelivery took 10.02 s.
Ordering showed 1 inversion in 500. **Retry backoff is not faithful:** the first redelivery came after 8 ms and the
rest were not exponential. IAM, quotas and server-side flow control are not modelled. The write-up lists what a real
project must re-run.

**Verify.** `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 bun test packages/store-postgres/spike --grep doorbell-gcp`
passes 8 tests. It passed on 3 consecutive runs, about 58 s each. Bun 1.4.2 accepts `--grep` as an alias of `-t`.
Without the emulator, the suites skip with a warning; CI does not run the emulator.

**Gate.** With the test Postgres and the emulator up, and `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1` set, the full
gate passes: 20 tests across 6 files, 61.7 s. `bun run test:model` also passes.

**Not run or not verified:**

- step 8 (real Pub/Sub and Cloud Run): no `gcloud` writes, no Terraform, nothing paid;
- the compose `pubsub` service: the image did not fit in Docker's disk, so the gcloud `pubsub-emulator` and `beta`
  components were installed on the host instead;
- the Cloud Tasks relay;
- group-blocked jobs and per-queue concurrency limits under 4e (same claim and re-ring paths as the rate limit).
