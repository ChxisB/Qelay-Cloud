# Task 04: spike, doorbell on SQS (2026-10-13)

**Done on ElasticMQ 1.7.1.** The doorbell model holds on SQS. No job was lost or run twice in any of these scenarios:

- a dropped publish, and a batch publish that half succeeds;
- duplicate bells;
- a crash before or after the delete;
- a visibility timeout that expires, with and without the heartbeat;
- paused and rate-limited queues;
- delayed bells, failing jobs, database outages and malformed bodies.

Postgres decided every outcome. **Step 6, the real-account run, was not run** (D9).

**Docs:**

- the write-up: `docs/spikes/04-doorbell-aws.md`;
- the full Result: `.claude/.planning/v1.0.0/04-spike-doorbell-aws.md`;
- task 06's inputs: a "From task 04" block.

**Code:** `packages/store-postgres/spike/doorbell-aws/`, 17 TypeScript files and 2,553 lines, plus `elasticmq.conf`.
Five test files hold 27 tests: 23 need Postgres and ElasticMQ, and 4 use a stub client and always run.

**Other changes:**

- `@aws-sdk/client-sqs` 3.1140.0 (exact pin) as a root devDependency;
- an opt-in `sqs` profile in `docker-compose.test.yml` (ElasticMQ on `127.0.0.1:59324`);
- `doorbell/invariants.ts` (task 03's checker) accepts a job that fails and retries: each claim settles at most once,
  and a settle under an older claim starts before the next claim. `doorbell/invariants.test.ts` covers it, and task 03's
  suites still pass;
- `docs/spikes/03-doorbell-gcp.md` states the new rule;
- CLAUDE.md says how to start ElasticMQ and what `QCLOUD_REQUIRE_SQS=1` does.

**Findings:**

1. **`DeliveryTransport` needs six changes:** a result per bell from `ring`; a relative, rounded-up delay refused above
   `maxDeliverDelayMs`; `capabilities` gains `maxRingBatch`, `attemptCount` and `retryGranularityMs` and drops
   `ordering`; a demand-driven `subscribe` with `capacity()`; a `Delivery` with `ack()` and `nack(retryInMs)`;
   `stats()` with `source`, `observedAt` and `maxStalenessMs`, nullable where a broker cannot say.
2. **Retry backoff need not run at tick speed on AWS.** The failing worker rings the retry for `run_at`. Task 03's
   finding is specific to a cloud with no per-message delay.
3. **Bells are fungible.** `rung_at` counts bells, not jobs, and the tick's age threshold, not the null check, bounds
   invariant 3.

Also: the DLQ is a metric on SQS too, so nack with a backoff, alert on it and never replay it.

**Bugs found and fixed:**

- the checker rejected fail-then-retry jobs (see above);
- a late heartbeat undid a nack's retry time. A test reproduced it first, and the fix is in `sqsTransport.ts`.

**Verified:**

- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 bun test packages/store-postgres/spike --grep doorbell-aws`: 27 pass, 63 s;
- the full gate, with Postgres, ElasticMQ and the Pub/Sub emulator required: 51 tests across 12 files, 124 s;
- `bun run test:model`: 6 pass;
- the 22 emulator tests that existed first passed on 3 consecutive runs.

**Not done or not verified:**

- no real AWS: no `aws` call, no Terraform, nothing paid;
- D2 (per-job or per-queue bells) was not measured on SQS. Recommendation: per job, to be revisited with a load test;
- throughput and request cost, FIFO queues, short polling, KMS, and a broker-side duplicate of one message;
- `Failed[]` from a real partial failure: parsing is covered by stub-client tests, and the worker's reaction by a fault wrapper;
- ElasticMQ gaps against AWS (stale-handle deletes, attribute-count lag, quotas) are listed in the write-up;
- CI does not run ElasticMQ, so the emulator suites skip there;
- nothing committed.

**Open for task 06:**

- the six interface changes, and whether a transport is bound to one cloud queue (the spike) or one per Qelay queue (the
  sketch);
- whether D2 closes on task 03's data;
- the emulator gaps that need a real run;
- spike disposal: `doorbell-aws/` moves to `transport-aws` (task 40), with the SQS dependency.

**Next:** task 05 (database access and delay). Its emulator and local Postgres parts can run now; real-cloud parts need D9.
