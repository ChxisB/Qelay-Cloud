# Spike 01: porting Qelay's Postgres engine without brokers

- **Task:** 01, run on 2026-10-13.
- **Upstream:** `../qelay` at commit `c43442c91a9f` (2026-10-07), schema version 21.
- **Spike code:** `packages/store-postgres/spike/`. Task 06 promotes it or deletes it.

## Verdict

**Go on "port".** The hot path ported with 2.0% of its lines changed by hand and no lines rewritten.

- **Brokers were a thin layer.** One module (`brokerSessions`, 112 lines) handled them, plus column clears and a lock call spread over 15 others.
- **The ported engine passes the spike tests** against Postgres 16, with those parts removed:
  - 1,000 jobs across 8 concurrent claimers, each claimed exactly once;
  - a SIGKILLed worker's job is recovered, with its attempt counted;
  - fail → retry → DLQ works.
- **Across all 86 upstream modules:** 52 keep, 28 adapt, 4 drop, 2 rewrite. The two rewrites are the broker runtime and the store facade, which are glue code.

The task set a rewrite threshold: more than about half of the hot-path lines needing a rewrite. The result is nowhere near it. The task's named hot-path modules have 1,596 lines, of which 32 (2.0%) changed by hand and 0 were rewritten.

## What was done

1. **Inventory.** I wrote up all 86 modules (see [Inventory](#inventory)).
2. **Fence.** I wrote down the fence that replaces brokers (next section) before porting any code.
3. **Mechanical port.** [`scripts/port.ts`](../../scripts/port.ts) (moved from `spike/tools/` in task 11) reads upstream with `git show c43442c9:<path>`, so it never checks anything out and upstream stays untouched.
   - **Entry points.** It starts from 10 hot-path modules: `admission`, `claims`, `leaseRenewal`, `leaseRelease`, `completionOutcome`, `outcomes`, `recovery`, `dlqLifecycle`, `expiry` and `schemaInitialization`.
   - **Closure.** It follows their relative imports and writes everything they reach into `spike/ported/` with upstream's layout, renaming upstream's old name to `qcloud`. That is 71 files and 10,137 lines: 44 `postgres/` modules plus 27 domain, shared and scheduler files they import.
   - **Why it is bigger than the hot path.** The hot path calls flow, group, dependency and event code inside the same transactions, so that code came along unchanged.
   - **Clean-up.** `oxlint --fix` changed nothing. `oxfmt` only sorted imports. Strict TypeScript 6 compiled the result with no hand edits once `msgpackr` was added as a dependency.
4. **Broker removal** by hand. This is the part measured below.
5. **Tests and measurement.** `spike/tools/measure.ts` produced the numbers. The Phase 0 gate (task 06) deleted it: the figures below are the record, and `port.ts` can regenerate the mechanical port if they ever need re-deriving.

## The fence that replaces brokers

**Invariant.** A worker's write to a leased job (complete, fail, renew or release) is applied only if, in the same transaction and under a `FOR UPDATE` row lock:

1. `state = 'active'`;
2. `lease_token` equals the token the worker got from its claim;
3. `lease_until > databaseNow()`, using the database clock and never the worker's.

**Token lifecycle.**

- Every claim issues a fresh UUIDv7 token.
- Recovery, release and every terminal transition set `lease_token = NULL`.
- So a token is valid for one lease generation only.
- Once its lease has expired, the token can never become valid again, even before recovery runs. Renewal also requires an unexpired lease.

**Role of `version`.** Every write increments `version`. It is the optimistic guard for writers that hold no lease: operator and Control API mutations such as change priority, promote, remove and DLQ retry. Lease-holder writes do not compare it. Renewals bump `version`, so a version check there would add nothing that token plus deadline do not already guarantee. It would only force the holder to track a moving number.

**Owner.** `lease_owner` is the worker id. It serves for diagnostics and as the key for graceful shutdown (`releasePostgresOwnerLeases(owner)`), so it must be unique per process.

**Why no broker session is needed.** Upstream's session fence existed to stop a broker that had lost its session from acting on leases it had issued. Workers now write directly, and token plus deadline already reject a zombie worker. No intermediary remains whose authority can go stale.

**Where the fence lives in the port:**

| Path | Location |
| --- | --- |
| Fail | `outcomes.ts:60` |
| Complete | `completionOutcome.ts:68` |
| Renew | `leaseRenewal.ts:103-137` |
| Release | `leaseRelease.ts:99` |
| Token issued (claim) | `claimBatch.ts:47` |
| Recovery selects expired leases (`lease_until <= now`) | `recovery.ts:123-165` |

**Proposed wording change to DESIGN.md invariant 2 (for task 06).** The invariant says "Compare-and-set on `version`". Upstream does not compare `version` on lease-holder writes, and should not, for the reason above. The proposed wording:

> The lease holder is fenced by token plus unexpired deadline under a row lock. Writers without a lease use a version compare-and-set.

The spike found no case where the design is wrong. This is a wording fix, not a design change.

## Spike tests

The tests are `claimOnce.test.ts` and `leaseRecovery.test.ts`. Each file runs in its own schema via `test/support/db.ts`. All 3 tests passed on 6 consecutive runs, with `QCLOUD_REQUIRE_DB=1` and Postgres 16 in Docker on tmpfs.

**Exactly once** (`claimOnce.test.ts`)

- **Setup:**
  - 1,000 jobs, bulk-enqueued in 5 batches of 200;
  - 8 claimers, each with its own 2-connection pool and worker id;
  - each claimer claims 4 jobs at a time and completes them.
- **Asserts:**
  - on the worker side, each id was claimed once;
  - in the database, there is one `pulled` event per job;
  - 1,000 jobs are completed, no lease is left, and `attempts` is 0;
  - all 8 claimers got work.

**Crash** (`leaseRecovery.test.ts`)

- **Setup:** a child process claims a job with a 2 s lease, renews it once, prints the lease, and is then SIGKILLed.
- **While the lease is live:**
  - the job stays `active` with the dead worker's token;
  - it is not claimable, and recovery finds nothing.
- **After the lease expires (database clock):** the dead worker's token can neither complete nor renew the job, even before recovery runs.
- **After recovery:**
  - the job is `waiting` with `attempts` 1 and `stallCount` 1, and the token is cleared;
  - a new claim gets a new token;
  - the old token is still rejected, and the new one completes the job.
- **Version:** `version` strictly increases across enqueue, claim + renew, recovery and complete.

**Fail → DLQ** (`leaseRecovery.test.ts`)

- **First fail** (`maxAttempts` 2): the job retries (`waiting`, `attempts` 1), and a stale token is rejected.
- **Second fail:** the job becomes `failed` with `attempts` 2 and `dlq_entry` set.
- **Repeat fail:** rejected.

**Timing.** Indicative only (local Docker, tmpfs, one laptop):

- enqueueing 1,000 jobs took 96-115 ms;
- claiming and completing 1,000 jobs with 8 claimers took 1.46-1.68 s.

## Measurements

The numbers came from `spike/tools/measure.ts --files` (since deleted, see above). The tool diffed the mechanical port (upstream plus the rename) against `spike/ported/` and classified each diff hunk:

- **Adapted:** removed and added lines that pair up.
- **Dropped:** removed lines with no partner.
- **New:** added lines with no partner.
- **Kept:** lines the formatter only moved.

**Hot-path lines** (the 71 ported files):

| Measure | Lines | Share |
| --- | ---: | ---: |
| Upstream total | 10,137 | 100% |
| Kept | 9,941 | 98.1% |
| Adapted | 16 | |
| Dropped | 180 | |
| New | 3 | |
| Rewritten | 0 | |
| **Hand-touched** (adapted + dropped + new) | **199** | **2.0%** |

- Of the kept lines, 522 changed only through the mechanical rename.
- Of the dropped lines, 112 are `brokerSessions.ts`, deleted whole. The other 87 hand-touched lines are spread over 16 files.

**Named hot-path modules.** These are the task's list: `claims`, `claimBatch`, `claimSelection`, `leaseRenewal`, `leaseRelease`, `completionLifecycle`, `completionOutcome`, `dlqLifecycle` and `recovery`. Together they have 1,596 lines, 32 hand-touched (2.0%) and 0 rewritten. `leaseStore` is also on that list, but it is a 23-line interface the port never reached.

**New code** (not ported), 664 lines:

| File | Lines |
| --- | ---: |
| Harness | 128 |
| Crashing claimer | 24 |
| Two test files | 227 |
| `port.ts` | 88 |
| `measure.ts` | 197 |

**Time.** About 28 minutes of agent wall-clock time, from task start (18:28 UTC) to this write-up. The first spike file was written at 18:36 and the tests passed by 18:46. This is not a human-effort estimate. For a person, the edit counts above are a better proxy: about 90 mechanical broker-removal lines plus the fence reasoning. For the hot path, that is hours of work, not weeks. Tasks 11-15 still carry their own new work: `rung_at`, the migration runner, the `StateStore` facade and the tick.

**By area:**

| Area | Upstream | Renamed | Kept | Adapted | Dropped | New | Hand-touched | Broker refs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| application | 144 | 0 | 144 | 0 | 0 | 0 | 0.0% | 0 |
| domain/job | 1052 | 2 | 1052 | 0 | 0 | 0 | 0.0% | 11 |
| domain/types | 588 | 1 | 588 | 0 | 0 | 0 | 0.0% | 2 |
| domain/types/jobs | 149 | 0 | 149 | 0 | 0 | 0 | 0.0% | 0 |
| infrastructure/persistence | 573 | 2 | 573 | 0 | 0 | 0 | 0.0% | 0 |
| infrastructure/persistence/postgres | 6909 | 516 | 6713 | 16 | 180 | 3 | 2.9% | 8 |
| infrastructure/scheduler | 255 | 1 | 255 | 0 | 0 | 0 | 0.0% | 0 |
| shared | 467 | 0 | 467 | 0 | 0 | 0 | 0.0% | 0 |
| **Total** | 10137 | 522 | 9941 | 16 | 180 | 3 | 2.0% | 21 |

**Files with hand edits** (under `infrastructure/persistence/postgres/`):

| File | Upstream | Renamed | Kept | Adapted | Dropped | New | Hand-touched | Broker refs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `advisoryLocks.ts` | 13 | 1 | 12 | 0 | 1 | 0 | 7.7% | 0 |
| `batchEvents.ts` | 131 | 1 | 130 | 0 | 1 | 0 | 0.8% | 0 |
| `brokerSessions.ts` | 112 | 6 | 0 | 0 | 112 | 0 | 100.0% | 0 |
| `claimBatch.ts` | 119 | 1 | 113 | 2 | 4 | 0 | 5.0% | 0 |
| `claims.ts` | 205 | 7 | 203 | 0 | 2 | 0 | 1.0% | 0 |
| `codec.ts` | 120 | 0 | 119 | 0 | 1 | 0 | 0.8% | 0 |
| `completionOutcome.ts` | 135 | 7 | 134 | 0 | 1 | 0 | 0.7% | 0 |
| `context.ts` | 128 | 1 | 127 | 0 | 1 | 0 | 0.8% | 0 |
| `dlqLifecycle.ts` | 251 | 8 | 249 | 1 | 1 | 0 | 0.8% | 1 |
| `leaseRelease.ts` | 141 | 8 | 132 | 4 | 5 | 3 | 8.5% | 0 |
| `leaseRenewal.ts` | 161 | 2 | 154 | 2 | 5 | 0 | 4.3% | 0 |
| `maintenanceSchedule.ts` | 76 | 0 | 72 | 4 | 0 | 0 | 5.3% | 2 |
| `outcomes.ts` | 250 | 6 | 248 | 0 | 2 | 0 | 0.8% | 0 |
| `recovery.ts` | 216 | 8 | 214 | 0 | 2 | 0 | 0.9% | 1 |
| `schema.ts` | 267 | 72 | 239 | 0 | 28 | 0 | 10.5% | 0 |
| `schemaInitialization.ts` | 270 | 57 | 261 | 0 | 9 | 0 | 3.3% | 0 |
| `types.ts` | 199 | 0 | 191 | 3 | 5 | 0 | 4.0% | 0 |

## Remaining coupling

- **Comments.** 21 lines in the port still mention brokers, and all are comments:
  - 13 in `domain/` (`timeoutRule`, `state`, `options`, `commandArguments`, `groupFifoOrder`, `types/group`);
  - 8 in `postgres/` (`recovery`, `dlqLifecycle`, `eventRetention`, `flowFailures`, `deduplication`, `leaseDeadline`, `maintenanceSchedule`).

  Reword them when the files are promoted.
- **Timeout authority.** Upstream's broker scheduler is the timeout authority (`domain/job/timeoutRule.ts`). In the cloud model, the tick (task 20) owns timeout and lease recovery.
- **Unported modules.** Modules not in the spike still carry broker code:

  | Module | Broker refs |
  | --- | ---: |
  | `runtime` | 25 |
  | `workers` | 21 |
  | `crons` | 7 |
  | `runtimeConfig` | 3 |
  | `mutations` | 3 |
  | `store` | 2 |
  | `telemetry` | 2 |
  | `connection`, `storageHealth`, `jobData`, `destructiveMutations`, `batchCompletion`, `terminal`, `dlqMaintenance` | 1 each |

  The inventory gives each one's kind and verdict.

## Findings for other tasks

1. **Claim does not increment `attempts` upstream (task 13).**
   - **Mismatch:** task 13 step 2 says claim increments it.
   - **Upstream behaviour:** an attempt is counted when it ends without success. Both fail (`outcomes.ts:177`) and lease recovery (`recovery.ts:178`) increment it; claim and complete do not.
   - **DESIGN.md:** invariant 5 ("an expired lease counts as an attempt") holds under upstream's semantics, and the crash test checks it.
   - **Recommendation:** keep upstream's semantics, so retry counts and backoff match Qelay, and fix task 13's wording. Task 06 to confirm.
2. **`sessionLimits.ts` is not a broker module (tasks 11 and 13).**
   - **Mismatch:** task 13 lists it to drop.
   - **What it is:** PostgreSQL's maximum session timeout, used to validate `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`.
   - **Recommendation:** keep it in task 11's connection factory.
3. **Renewal, release and recovery bypass the retry wrapper upstream (tasks 13 and 14).**
   - **What happens:** they call `ctx.sql.begin` directly (`leaseRenewal.ts:88`, `leaseRelease.ts:88,115`, `recovery.ts:117`). A serialisation failure there surfaces to the caller, and the next heartbeat or tick retries.
   - **Spike:** kept as is, because the task said not to simplify transaction handling.
   - **Recommendation:** tasks 13 and 14 decide whether to wrap these calls, backed by a test.
4. **Event journal: keep it (task 11 decision; recommendation).**
   - **What it is:** `eventJournalSchema` is a commit-time sequencer. A deferred trigger assigns `commit_seq` at commit time, under a per-namespace advisory lock.
   - **The problem it solves:**
     - event ids from a sequence are assigned at insert time;
     - so a reader polling `id > cursor` can skip a row whose transaction commits after a row with a later id;
     - that is a concurrent-writers problem, not a brokers problem.
   - **Why the cloud model needs it more:** every worker writes events in its own transactions, so there are more concurrent writers, not fewer.
   - **Cost:** the lock serialises event-writing commits within a namespace. Task 13's 5,000-job run should measure it.
   - **If it were dropped:** QueueEvents and the panel stream would need another ordering scheme.
5. **The worker id must be unique per process (task 11).**
   - **Why:** `releasePostgresOwnerLeases(owner)` releases every lease with that owner.
   - **Recommendation:** use upstream's broker-id default, `hostname:pid:<uuid suffix>` from `runtimeConfig.ts`, as the worker-id default.
6. **Post-commit maintenance runs inline when nothing hosts it (tasks 19 and 20).**
   - **What happens:** with no `postCommitMaintenance` hook in the context, work such as DLQ-limit enforcement runs inline after commit (`context.ts:31-35`). The spike ran it that way.
   - **Open question:** tasks 19 and 20 decide where the coalescing runner (`postCommitMaintenance.ts`) lives.
7. **Upstream baseline.** The task's figures (86 modules, about 12,300 lines, 34 mentioning brokers) describe upstream's working tree, not the commit.
   - **The commit:** `c43442c9` has 85 modules and 12,264 lines.
   - **The 86th module:** `legacySchemaGuard.ts` (32 lines) is uncommitted. It belongs to an in-flight table-prefix rename (the old prefix to `qelay_`), and the only other uncommitted change in `postgres/` is that rename plus the guard's call.
   - **Effect on the port:** the port takes the commit and applies its own `qcloud` rename, so nothing is lost.
   - **Hot-path size:** the named hot path is 1,619 lines, not about 2,000.
8. **Not verified by this spike:**
   - Bun.SQL over TLS to Cloud SQL or RDS (task 05);
   - the model harness (task 02);
   - groups, rate limits, concurrency limits, flows and cron under concurrency. These were ported unchanged; tasks 13-15 test them.

## Module plan for tasks 11-15

Each task promotes its modules from `spike/ported/`, or re-runs `port.ts` first if upstream has moved, then makes the changes listed below. Verdicts and notes per module are in the inventory.

**Task 11: schema and migrations**

| Module(s) | Action |
| --- | --- |
| `schema` | Adapted. Add `rung_at` and its indexes. |
| `groupSchema`, `groupSchemaFingerprint`, `eventJournalSchema`, `eventRetentionSchema` | Keep. |
| `schemaInitialization` | Becomes the migration runner. Version 1 is upstream v21 without brokers. Keep its column and index verification as the drift check. |
| `advisoryLocks`, `transactionRetry`, `context`, `types`, `codec` | Promote. |
| `connection`, `runtimeConfig`, `sessionLimits` | Become the connection factory, with the worker-id default. |
| `legacySchemaGuard` | Drop. |

**Task 12: enqueue**

| Module(s) | Action |
| --- | --- |
| `admission`, `admissionParent` (hook only), `admissionResult`, `batchAdmission`, `serialAdmission`, `deduplication`, `priorityColumn`, `queueLifecycle` | Keep. |
| `admissionStore` | Becomes `StateStore.enqueue`, which returns `needsRing`. |
| Domain closure (`domain/job`, `domain/types`, `shared/msgpack`) | Comes with it. |

**Task 13: claim and leases**

| Module(s) | Action |
| --- | --- |
| `claims`, `claimBatch`, `leaseRenewal` | Adapted. |
| `claimSelection`, `groupClaims`, `groups`, `policies`, `rateLimit`, `leaseDeadline` | Keep. |
| `leaseRelease` | Adapted; keyed by owner. |
| `dependencyPromotion` | Keep; provides the claim-time repair. |
| `leaseStore` | Folds into `StateStore`. |
| `brokerSessions` | Drop. |
| Task text | Fix step 2 (finding 1) and the `sessionLimits` reference (finding 2). |

**Task 14: complete, fail, DLQ, recovery**

| Module(s) | Action |
| --- | --- |
| `completionOutcome`, `outcomes`, `dlqLifecycle`, `recovery` | Adapted. |
| `completionLifecycle`, `completionEvents`, `completionQueries`, `dlqRetryPlan`, `dlqMaintenance`, `expiry`, `dependencyDestruction`, `metricWrites` | Keep. |
| `batchCompletion`, `terminal`, `batchEvents` | Adapt. |
| `flowFailures`, `relationships` | Keep as flow hooks. |

**Task 15: delay, cron, events, logs, metrics, workers**

| Module(s) | Action |
| --- | --- |
| `promotion`, `repeatMutations`, `logs`, `lifetimeMetrics`, `lifetimeMetricsFinalizer`, `control`, `queries`, `queueDestruction`, `maintenance`, `groupStateRetention`, `jobData` | Keep. |
| `events`, `eventJournal`, `eventCatchupCursors`, `eventCommitGc`, `eventPruneWatermarks`, `eventRetention` | Keep (see finding 4). |
| `crons` | Adapt: replace the broker election. |
| `workers`, `mutations`, `destructiveMutations`, `telemetry` | Adapt: remove broker columns and ids. |
| `readModels` | Adapt: drop the whole-manager snapshot. |

**Elsewhere**

| Module(s) | Destination |
| --- | --- |
| `runtime` | Rewritten as the tick (task 20). |
| `maintenanceSchedule`, `maintenanceFlights`, `postCommitMaintenance` | Task 20 (and 19). |
| `storageHealth` | Tasks 20 and 30. |
| `store` | Rewritten as the `StateStore` facade across tasks 12-15. |
| `removeUnprocessedChildren` | Task 50. |
| `brokerSessions`, `cloudReadModel`, `snapshotBudget`, `legacySchemaGuard` | Dropped. |

## What was and was not run

**Run:**

- the full gate: `bun run typecheck`, `lint`, `format:check`, `architecture`, and `QCLOUD_REQUIRE_DB=1 bun test`;
- against the local Docker Postgres 16 from `docker-compose.test.yml`. I started Docker Desktop locally for this.

**Not run:**

- anything in a cloud account: no `terraform`, `gcloud` or `aws`;
- no commit or push.

`../qelay` was only read, with `git show`, `git diff` and `git ls-tree`.

## Inventory

All 86 modules under upstream `src/infrastructure/persistence/postgres/`.

**Columns:**

- **Lines** and **Broker refs** (lines matching `/broker/i`) are measured at `c43442c9`. For `legacySchemaGuard` they are measured on the working tree.
- **Tables** are the tables each module's SQL mentions, without the `qcloud_` prefix.
- **In spike** means the module was ported into `spike/ported/`.

**Verdicts:**

- **keep:** copy with an import fix;
- **adapt:** remove broker concepts, or reshape to `StateStore`;
- **drop:** broker-only, or used only by upstream's cloud telemetry;
- **rewrite:** replaced by new code.

**Totals** (86 modules, 12,296 lines):

| Verdict | Modules | Lines |
| --- | ---: | ---: |
| keep | 52 | 6,784 |
| adapt | 28 | 4,482 |
| drop | 4 | 450 |
| rewrite | 2 | 580 |

| Module | Lines | Broker refs | In spike | Tables | Verdict | Task | Notes |
| --- | ---: | ---: | :---: | --- | --- | --- | --- |
| `admission` | 292 | 0 | yes | completions, dependencies, flow_failures, group_order_seq, job_logs, jobs, repeat_links | keep | 12 |  |
| `admissionParent` | 46 | 0 | yes | jobs | keep | 12, 50 | Flow-parent hook; flows land in 50. |
| `admissionResult` | 10 | 0 | yes | - | keep | 12 |  |
| `admissionStore` | 177 | 0 |  | - | adapt | 12 | Admission facade (serial vs batch). Reshape to `StateStore.enqueue` returning `needsRing`. |
| `advisoryLocks` | 13 | 0 | yes | - | keep | 11, 13 | Lock prefix `qcloud:`. |
| `batchAdmission` | 238 | 0 | yes | group_order_seq, jobs | keep | 12 |  |
| `batchCompletion` | 251 | 1 |  | completions, dependencies, flow_failures, job_logs, jobs, repeat_links | adapt | 14 | Broker lease columns in the terminal `SET`. |
| `batchEvents` | 131 | 1 | yes | events | adapt | 14 | `brokerId` in the NOTIFY payload (no reader used it). |
| `brokerSessions` | 112 | 53 | yes | brokers | drop | - | Broker session fence. Replaced by the lease-token fence. |
| `claimBatch` | 119 | 6 | yes | jobs | adapt | 13 | Broker id and session columns on claim. |
| `claimSelection` | 191 | 0 | yes | completions, dependencies, group_state, jobs | keep | 13 | `FOR UPDATE OF job SKIP LOCKED`. |
| `claims` | 205 | 2 | yes | jobs, queue_state | adapt | 13 | Session-lock call. |
| `cloudReadModel` | 205 | 0 |  | completions, crons, job_logs, jobs, metric_totals, queue_state, workers | drop | - | Feeds upstream's Cloud telemetry adapter only (`src/infrastructure/cloud/`). |
| `codec` | 120 | 1 | yes | - | adapt | 12 | msgpackr kept. `leaseBrokerId` removed. |
| `completionEvents` | 51 | 0 |  | - | keep | 14 |  |
| `completionLifecycle` | 177 | 0 | yes | completions, dependencies, jobs | keep | 14 |  |
| `completionOutcome` | 135 | 1 | yes | completions, dependencies, job_logs, jobs, repeat_links | adapt | 14 | Broker lease columns in the `SET`. |
| `completionQueries` | 119 | 0 |  | completions, dependencies, jobs | keep | 14, 50 | `getChildrenValues` serves flows. |
| `connection` | 17 | 1 |  | - | adapt | 11 | Broker id in `application_name`. Becomes the worker id in task 11's connection factory. |
| `context` | 128 | 1 | yes | events | adapt | 11 | `brokerId` in the NOTIFY payload. |
| `control` | 174 | 0 |  | queue_state | keep | 15 | Queue configuration get/set. |
| `crons` | 250 | 7 |  | brokers, crons | adapt | 15 | Missed-run reconciliation elects the oldest live broker. Replace with `FOR UPDATE SKIP LOCKED` / an advisory lock. |
| `deduplication` | 68 | 1 | yes | jobs | keep | 12 | Comment mentions brokers. |
| `dependencyDestruction` | 96 | 0 | yes | dependencies, jobs | keep | 14 |  |
| `dependencyPromotion` | 294 | 0 | yes | completions, dependencies, jobs | keep | 14 | Claim-time repair is called from 13. |
| `destructiveMutations` | 126 | 1 |  | completions, dependencies, flow_failures, job_logs, jobs | adapt | 15 | `removeJob`, `retryTerminalJob`. Broker lease columns. Exposed by 31/32. |
| `dlqLifecycle` | 251 | 3 | yes | dependencies, flow_failures, job_logs, jobs | adapt | 14 | Broker lease columns in DLQ retry. |
| `dlqMaintenance` | 53 | 1 |  | jobs, queue_state | keep | 14, 20 | Run by the tick. Comment mentions brokers. |
| `dlqRetryPlan` | 153 | 0 | yes | dependencies, jobs, queue_state | keep | 14 | Store-level DLQ retry only if task 06 agrees. |
| `eventCatchupCursors` | 80 | 0 |  | - | keep | 15 | Reader bookkeeping for the journal. Used by QueueEvents (19). |
| `eventCommitGc` | 74 | 0 |  | - | keep | 15 | Journal GC. Drop with the journal if 11 drops it. |
| `eventJournal` | 115 | 0 |  | event_commits, event_prune_watermarks, events | keep | 15 | Commit-ordered reads. |
| `eventJournalSchema` | 270 | 0 | yes | 12 `qcloud_*` objects | keep | 11 | Commit-time sequencer. See "Event journal". |
| `eventPruneWatermarks` | 204 | 0 | yes | event_prune_watermarks | keep | 15 |  |
| `eventRetention` | 150 | 1 | yes | event_commits, event_retention_deltas, event_retention_state, events | keep | 15 | Comment mentions brokers. |
| `eventRetentionSchema` | 227 | 0 | yes | event_retention_deltas, event_retention_state, events, events_track_retention_delete, events_track_retention_insert, track_event_deletions, track_event_insertions | keep | 11 |  |
| `events` | 300 | 0 |  | - | keep | 15, 19 | `PostgresEventStream`: polling is authoritative, LISTEN only a wake-up hint. |
| `expiry` | 86 | 0 | yes | dependencies, flow_failures, job_logs, jobs | keep | 14 |  |
| `flowFailures` | 256 | 1 | yes | completions, dependencies, flow_failures, jobs | keep | 14, 50 | Comment mentions brokers. |
| `groupClaims` | 128 | 0 | yes | group_state, jobs, queue_state | keep | 13 |  |
| `groupSchema` | 166 | 0 | yes | group_order_seq, group_state, jobs | keep | 11 |  |
| `groupSchemaFingerprint` | 135 | 0 | yes | group_order_seq, group_state, jobs | keep | 11 |  |
| `groupStateRetention` | 117 | 0 |  | group_state, jobs | keep | 15 |  |
| `groups` | 258 | 0 | yes | group_state, jobs | keep | 13 |  |
| `jobData` | 35 | 1 |  | - | keep | 15 | Comment mentions brokers. |
| `leaseDeadline` | 88 | 1 | yes | - | keep | 13 | Comment mentions brokers. |
| `leaseRelease` | 141 | 9 | yes | dependencies, flow_failures, job_logs, jobs | adapt | 13 | Release by broker becomes `releasePostgresOwnerLeases(owner)`. |
| `leaseRenewal` | 161 | 7 | yes | jobs | adapt | 13 | Session lock and broker columns. |
| `leaseStore` | 23 | 0 |  | - | adapt | 10, 13 | A 23-line interface that folds into `StateStore`. |
| `lifetimeMetrics` | 74 | 0 |  | event_commits, events, metric_totals | keep | 15 |  |
| `lifetimeMetricsFinalizer` | 21 | 0 |  | - | keep | 15 |  |
| `logs` | 89 | 0 |  | job_logs, jobs | keep | 15 |  |
| `maintenance` | 187 | 0 |  | completions, dependencies, flow_failures, job_logs, jobs | keep | 15 | Clean queue, purge DLQ. |
| `maintenanceFlights` | 78 | 0 |  | - | keep | 20 | Per-subsystem serialisation inside the tick. |
| `maintenanceSchedule` | 76 | 6 | yes | - | adapt | 20 | Broker heartbeat cadence becomes the worker heartbeat cadence. |
| `metricWrites` | 147 | 0 | yes | metric_buckets, metric_totals | keep | 14, 15 |  |
| `mutations` | 221 | 3 |  | jobs | adapt | 15 | Broker lease columns in the state `CASE`. |
| `outcomes` | 250 | 2 | yes | dependencies, job_logs, jobs | adapt | 14 | Broker lease columns in the `SET`. |
| `policies` | 40 | 0 | yes | queue_state | keep | 13 |  |
| `postCommitMaintenance` | 134 | 0 |  | - | keep | 19, 20 | Without it, post-commit work runs inline (the spike did). |
| `priorityColumn` | 17 | 0 | yes | jobs | keep | 12 |  |
| `promotion` | 48 | 0 |  | jobs | keep | 15 |  |
| `queries` | 203 | 0 |  | completions, events, jobs, queue_state | keep | 15 |  |
| `queueDestruction` | 185 | 0 |  | 10 `qcloud_*` objects | keep | 15 | Drain and obliterate. Exposed by 31. |
| `queueLifecycle` | 84 | 0 | yes | queue_state | keep | 12, 13 |  |
| `rateLimit` | 19 | 0 |  | - | keep | 13 |  |
| `readModels` | 133 | 0 |  | completions, jobs, queue_state | adapt | 15 | Keep the queue read model and job projections. Drop the whole-manager snapshot (broker in-memory state). |
| `recovery` | 216 | 3 | yes | dependencies, job_logs, jobs | adapt | 14 | Broker lease columns in the `SET`. |
| `relationships` | 245 | 0 | yes | completions, dependencies, jobs | keep | 14, 50 |  |
| `removeUnprocessedChildren` | 291 | 0 |  | completions, dependencies, flow_failures, job_logs, jobs | keep | 50 |  |
| `repeatMutations` | 44 | 0 |  | jobs, repeat_links | keep | 15 |  |
| `runtime` | 286 | 25 |  | - | rewrite | 20, 19 | Broker process lifecycle: heartbeat, session fencing, maintenance timers. The tick replaces it. There is nothing to adapt line by line. |
| `runtimeConfig` | 100 | 3 |  | - | adapt | 11 | `brokerId` becomes `workerId` (default `hostname:pid:uuid`). `brokerSessionId` is dropped. |
| `schema` | 267 | 17 | yes | 16 `qcloud_*` objects | adapt | 11 | Broker table, columns and indexes removed. |
| `schemaInitialization` | 270 | 7 | yes | 21 `qcloud_*` objects | adapt | 11 | Becomes the migration runner (`qcloud_schema_migrations` from version 1). Keep its column/index verification. |
| `serialAdmission` | 151 | 0 |  | completions, dependencies, events, jobs | keep | 12 |  |
| `sessionLimits` | 14 | 0 |  | - | keep | 11 | PostgreSQL's session-timeout ceiling, **not** broker sessions. Task 13 lists it as a drop. |
| `snapshotBudget` | 101 | 0 |  | completions, crons, dependencies, jobs, queue_state | drop | - | Guards the broker's whole-namespace in-memory snapshot. There is no such snapshot here. |
| `storageHealth` | 32 | 1 |  | - | adapt | 20, 30 | `brokerId` in the health report. Health for the tick and the Control API. |
| `store` | 294 | 2 |  | - | rewrite | 12-15 | The broker's `QueueStore` facade (lease owner defaults to the broker id). A thin delegation layer, rebuilt as `StateStore` across 12-15. |
| `telemetry` | 144 | 2 |  | events, metric_buckets, metric_totals | adapt | 15 | `brokerId` in the NOTIFY payload. |
| `terminal` | 173 | 1 |  | dependencies, flow_failures, job_logs, jobs | adapt | 14 | Broker lease columns in the `SET`. |
| `transactionRetry` | 49 | 0 | yes | - | keep | 13 | 2 attempts on 40001, 40P01 and 55P03. Used by every transition. |
| `types` | 199 | 8 | yes | - | adapt | 10, 11 | Broker fields removed. |
| `workers` | 166 | 21 |  | workers | adapt | 15 | Drop broker columns and `removeBrokerWorkers`. Liveness by `last_seen`. |
| `legacySchemaGuard` | 32 | 0 |  | - | drop | - | Uncommitted upstream. Guards upstream's old-prefix to `qelay_` table rename. There are no legacy tables here. |
