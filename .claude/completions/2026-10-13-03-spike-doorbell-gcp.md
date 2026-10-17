# Task 03: spike, doorbell on Pub/Sub (2026-10-13)

**Done on the emulator.** The doorbell model holds on Pub/Sub. No job was lost or run twice in any of these scenarios:

- dropped publish;
- duplicate delivery;
- a crash before or after the ack;
- an expired ack deadline;
- paused and rate-limited queues.

Postgres decided every outcome. **Step 8, the real-project run, was not run** (D9).

**Docs:**

- the write-up: `docs/spikes/03-doorbell-gcp.md`;
- the full Result: `.claude/.planning/v1.0.0/03-spike-doorbell-gcp.md`;
- task 06's inputs: a "From task 03" block.

**Code:** `packages/store-postgres/spike/doorbell/`, 12 files and 1,519 lines.

- The worker: streaming pull, a slot semaphore, and ack after the claim.
- The publisher: commit first, then ring, then set `rung_at`.
- A sweep: recovery plus capped re-rings.
- A claim ledger checked with task 02's invariant names.
- Two test files: 8 tests in all.
- Two tools: the emulator fidelity probe and the D2 measurement.

`@google-cloud/pubsub` 6.1.0 is a root devDependency for now. Nothing is ported, so there are no PORTING.md rows.

**Findings (design changes, for task 06):**

1. **Rate-limited queues, retry backoff and lease recovery run at tick speed on GCP.** The write-up gives three fixes,
   none of which needs Cloud Tasks.
2. **Only the tick recovers a crashed job.** A redelivered doorbell claims nothing. "Or a later doorbell" in task 03
   and DESIGN.md is wrong.
3. **The tick's re-ring needs two limits:**
   - a per-queue cap;
   - a grace period before a null `rung_at` is due.

**D2: keep per-job doorbells.** On the emulator:

- per-queue doorbells drained a 10k backlog 1.5-1.75× faster;
- under steady load the modes were the same;
- batch claims for per-job doorbells gained nothing.

**Cloud Tasks relay: not needed for v1.0.0.** Pub/Sub has no per-message delay. The docs show none, and the emulator
rejects the fields.

**Checked:**

- the Verify command passes 8 tests, on 3 consecutive runs;
- the full gate passes with Postgres and the emulator up, and `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1` set: 20
  tests across 6 files;
- `bun run test:model` passes.

**Not done or not verified:**

- no real GCP;
- the compose `pubsub` service is untested (Docker disk full);
- the Cloud Tasks relay was not prototyped;
- groups and concurrency limits were not covered under 4e;
- nothing committed.

**Host change:** the gcloud `pubsub-emulator` and `beta` components were installed. CLAUDE.md now says how to start
the emulator.

**Open for task 06:**

- the three findings above;
- whether task 04 measures D2 on SQS (its steps do not);
- the emulator gaps that need a real run: retry backoff, DLQ under IAM, throughput, restarts;
- spike disposal: `doorbell/` moves to `transport-gcp` (task 17) along with the pubsub dependency.

**Next:** task 04 (SQS doorbell spike). Its emulator steps can run now; the real-account step needs D9.
