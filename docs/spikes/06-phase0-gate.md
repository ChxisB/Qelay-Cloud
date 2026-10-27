# Phase 0 gate: go / no-go

- **Task:** 06, run on 2026-10-13.
- **Inputs:** the write-ups for spikes [01](01-postgres-port.md), [03](03-doorbell-gcp.md), [04](04-doorbell-aws.md) and
  [05](05-db-access-and-delay.md), and the Result of task 02.
- **What was not run (D9):** nothing touched a real cloud account. Every cloud statement below comes from an emulator
  (Pub/Sub, ElasticMQ), a stand-in (PgBouncer, a TCP fault proxy) or the vendor's documentation, and says which.

## Verdict

**Go.** D5 is confirmed: Postgres is authoritative, the cloud queue is a doorbell, and the engine is ported, not
rewritten. The design needs **nine corrections**, listed under [What changed in the design](#what-changed-in-the-design).
None of them argues for a different architecture.

The go has three conditions. They are not formalities: each is a place where a spike "mostly worked".

1. **The model harness has not run against the real store.** Task 02 proved the harness and the reference model against
   a fake in-memory store. DESIGN.md Phase 0 (a) asked for the ported Postgres code under it. The ported code has
   tests (1,000 jobs over 8 claimers, a SIGKILLed worker, retry to DLQ) and the doorbell spikes check invariants 1-5 on
   real Postgres through a ledger, but neither is a randomised history. **Tasks 12-14 own this.** They already list
   the harness in their acceptance. Task 13 and task 14 are not done until `bun run test:model` runs on the Postgres
   store, and task 11 must add the clock seam it needs.
2. **No result came from a real broker.** Pub/Sub and SQS were exercised on emulators. The gaps are listed
   [below](#not-proven-and-needs-d9). Task 22 runs the scenario suite on a real project, or records it as not run.
3. **The delay precision is a product limit, not a bug.** On GCP, seconds-level delay, retry backoff and rate-limit
   resumption need an always-on worker running the in-process tick. A scale-to-zero push handler gets one minute.
   `docs/limits.md` (task 22) says so in its first table.

## Evidence per risk

"Confirmed" means the spike found the risk real. "Reduced" means it is smaller than DESIGN.md feared. "Worse" means
it is larger, or has a shape the design did not name.

| Risk (DESIGN.md section 10) | Spike | Verdict | Evidence | Consequence |
| --- | --- | --- | --- | --- |
| Rebuilding Qelay's engine; broker coupling | 01 | **Reduced** | 32 of the 1,596 hot-path lines (2.0%) changed by hand, none rewritten. Of 86 upstream modules: 52 keep, 28 adapt, 4 drop, 2 rewrite (the broker runtime and the store facade, both glue). Brokers were one 112-line module plus column clears and a lock call across 15 others. | Port. Unported modules still carry broker code (`runtime` 25 references, `workers` 21, `crons` 7, `runtimeConfig` 3, `mutations` 3). Tasks 15 and 20 own them. |
| Invariants under fault injection | 02, 03, 04 | **Held, with a gap** | Harness: 5 planted bugs found in 6 commands or fewer, fake store only. Pub/Sub emulator: 8 fault scenarios, 3 runs, no failure. ElasticMQ: dropped and half-dropped publishes, duplicate bells, crash before and after the delete, expired visibility, pause, rate limits, database outage, malformed bodies. No job lost or run twice in any. | Condition 1 above: the harness must reach the real store. |
| Interface fit across clouds | 04 (03 on paper) | **Confirmed, with six changes** | `DeliveryTransport` as sketched could not express a half-failed batch, a relative delay, demand-driven receive, ack/nack with a retry time, or stale statistics. | [Settled below](#deliverytransport). |
| Doorbell edge cases: a paused, rate-limited or group-blocked job consumes a doorbell | 03, 04 | **Worse than designed** | Never lost, but three paths run at tick speed on Pub/Sub: rate-limited queues (a queue limited to 10 jobs/s runs about 10 per minute under a 1-minute tick), retry backoff, and lease recovery. A later doorbell does not recover a crashed worker's job. Bells are fungible, so `rung_at` counts bells, not jobs. | Tick contract and in-process tick, [below](#the-tick-contract). |
| Connection pressure from serverless workers | 05 | **Reduced, bounded** | `direct = sum(count x (pool + listen)) + 6`, worker `concurrency` is not in it. 10 / 50 / 200 worker processes at pool 2 need 32 / 112 / 412 direct connections, or 26 behind a pooler. Measured with real processes: direct 50 workers peaked at 100 connections, pooled 50 at 10. At a hard cap the failure is `53300`, not a queue: 326-336 of 400 operations failed. | Pool default 2, formula in config validation, pooler above about 80% of `max_connections`. Derived from the formula: a 25-connection Cloud SQL shared-core instance fits about 9 processes in all, so 6 workers beside 3 control processes. |
| Always-on database cost | none | **Unchanged** | No spike priced it. | Task 21 states the smallest sensible tier and its connection ceiling in the README. |
| 1-minute scheduler floor | 03, 05 | **Confirmed, mitigated** | Tick-only delay: mean about 30 s, max about 60 s, never early. In-process tick with a lease-row leader, 500 ms interval: mean 343-348 ms, p95 554-562 ms, max 577-592 ms. 2,000 ms: mean 1,186-1,190 ms, max 2,065-2,079 ms (two runs, the second at this gate). A tick costs about 7 ms. Takeover after a leader crash takes about the lease length. | Opt-in in-process tick. No Cloud Tasks relay in v1.0.0. |
| **New:** the driver has no bound on a silent connection | 05 | **New** | `Bun.SQL` 1.4.2: a query on a connection that stops answering never settles. `cancel()` and `statement_timeout` do not help, and `close()` without a timeout hangs. Resets and refusals recover by themselves. | Per-operation deadline wrapper, `maxLifetime`, `idleTimeout`, `close({ timeout })` in the connection factory (task 11). |
| **New:** `LISTEN` through a transaction pooler fails silently | 05 | **New** | Subscribing succeeds and no event ever arrives. `NOTIFY` through the pooler is fine. | `QueueEvents` and the local transport take a direct `listenUrl`. |
| **New:** emulators are not the services | 03, 04 | **New** | The Pub/Sub emulator's retry backoff is not exponential, and ElasticMQ's receive counts, stale-handle deletes and `Failed[]` are not SQS's. | Condition 2. |
| **New:** Bun-only driver (CURRENT.md D12) | 01, 05 | **Confirmed** | The ported code uses `Bun.SQL` throughout, and spike 05's findings are about its behaviour. | No change. The limit stays in the compat table. |

## D5: Postgres authoritative, with a doorbell

**Decision: proceed.** The alternative the task named is Postgres-only polling workers with a cloud queue added later.
It is not the better course, for three reasons from the spikes:

1. **The polling design is already in the plan.** Phase 1 ships `transport-local` (LISTEN/NOTIFY plus polling) first.
   The doorbell is a second `DeliveryTransport` beside it. If a cloud transport misbehaves in production, a deployment
   switches transport and keeps its data and its code.
2. **The doorbell's failure modes are all repaired by a mechanism that must exist anyway.** The tick does cron, lease
   recovery and promotion with or without a doorbell. Every doorbell failure the spikes injected (a dropped publish, a
   duplicate, a crash on either side of the ack, an expired deadline, a paused or rate-limited queue) was repaired by
   the tick or never mattered, because Postgres decided each outcome.
3. **What the spikes found worse is delay precision, not correctness.** That is a documented limit with a fix for
   always-on workers, not a lost job.

The doorbell still adds real cost: a second system to provision per queue, a DLQ to watch, and the tick-speed paths.
The reason to keep it is autoscaling and wake-up without polling, and that reason is unchanged.

## Port or rewrite

**Port, as task 01 planned.** The hot path is 98% unchanged. Per module group:

| Group | Decision | Owner |
| --- | --- | --- |
| Schema, groups, event journal and retention | Keep. Adapt `schema` (add the ring columns). `schemaInitialization` becomes the migration runner. | 11 |
| Connection, runtime config, session limits | Rewrite as the connection factory. `sessionLimits` stays: it validates timeout values. | 11 |
| Admission, dedup, batch and serial admission | Keep. `admissionStore` becomes `StateStore.enqueue`. | 12 |
| Claim selection, group claims, rate limit, leases | Keep or adapt. | 13 |
| Completion, outcomes, DLQ, recovery, expiry | Adapt. | 14 |
| Promotion, crons, events, logs, metrics, workers, read models | Keep, except `crons`, `workers`, `mutations`, `telemetry`, `readModels`, which adapt. | 15 |
| `runtime`, `maintenanceSchedule`, `maintenanceFlights`, `postCommitMaintenance` | Rewrite as the tick. | 20 (and 19) |
| `store` | Rewrite as the `StateStore` facade across tasks 12-15. | 12-15 |
| `brokerSessions`, `cloudReadModel`, `snapshotBudget`, `legacySchemaGuard` | Drop. | none |

Decisions the port needed, now closed:

- **Event journal: keep.** It orders events for concurrent writers, and the cloud model has more writers.
  The lock serialises event-writing commits per namespace. Task 13's 5,000-job run measures the cost.
- **`attempts`: keep upstream's semantics.** An attempt is counted when it ends without success: on fail and on
  lease recovery. Claim does not increment it. Invariant 5 holds under this rule.
- **Renewal, release and recovery bypass the retry wrapper upstream.** Tasks 13 and 14 decide whether to wrap them,
  backed by a test. The default is to keep upstream's behaviour.

## Settled interfaces

### DeliveryTransport

The spike 04 proposal, with two decisions the spike left open and one the gate adds.

```ts
interface Bell { namespace: string; queue: string; jobId?: string }  // jobId is a hint, never a claim

interface RingItem { bell: Bell; deliverAfterMs?: number }            // relative, rounded up, never down

type RingResult =
  | { ok: true }
  | { ok: false; reason: 'delay-too-long' | 'rejected' | 'unreachable' };

interface Delivery {
  readonly bell: Bell | null;          // null: the body is not a bell
  readonly attempt: number | null;     // broker's delivery count, if it keeps one
  ack(): Promise<void>;                // after the claim attempt, never after the job
  nack(retryInMs?: number): Promise<void>;
}

interface DeliveryTransport {
  readonly capabilities: {
    maxDeliverDelayMs: number;         // SQS 900_000, Pub/Sub 0, local unbounded
    maxRingBatch: number;              // SQS 10, Pub/Sub 1_000
    attemptCount: 'approximate' | 'none';
    retryGranularityMs: number;        // SQS 1_000
  };
  ring(items: readonly RingItem[]): Promise<RingResult[]>;            // one result per item, in order
  subscribe(queue: string, handler: (d: Delivery) => Promise<void>,
            options: { capacity: () => number }): { refresh(): void; close(): Promise<void> };
  stats(queue: string): Promise<{
    depth: number | null; inFlight: number | null; delayed: number | null;
    oldestAgeMs: number | null; deadLetterDepth: number | null;
    source: string; observedAt: number; maxStalenessMs: number;
  }>;
  close(): Promise<void>;
}
```

Changes from the DESIGN.md sketch, with the evidence in [spike 04](04-doorbell-aws.md):

1. `ring` returns a result per bell, because `SendMessageBatch` half-succeeds and `rung_at` must be set only for the
   bells the broker took.
2. The delay is relative and rounded up. An absolute time would make the transport read a clock, and a bell that
   arrives before `run_at` is an empty claim and a lost wake-up.
3. `capabilities` drops `ordering` and gains `maxRingBatch`, `attemptCount` and `retryGranularityMs`.
4. `subscribe` is demand-driven: the worker says how many jobs it can start, and a busy worker asks for nothing,
   so the backlog stays visible to an autoscaler.
5. The handler gets a `Delivery`. The transport holds the bell, extending the broker's deadline, while the handler runs.
6. `stats` says where its numbers come from and how stale they can be. `null` means the broker cannot say.

Decided at the gate:

7. **One cloud queue per Qelay queue.** `subscribe` and `stats` keep the sketch's `queue` argument, and `ring` routes
   each bell by `bell.queue`. The spike used one cloud queue for every Qelay queue, which works only if every worker
   serves every queue. A worker that serves queue A and receives a bell for queue B can do nothing with it, and SQS
   cannot filter. On GCP this is one topic per environment with a filtered subscription per queue, as DESIGN.md
   section 7 already said. Adding a queue is an infrastructure change on both clouds (task 21, 42). A shared
   channel for a group of queues is out of v1.0.0.
8. **The delay is per item, not per call.** The spike's tick called `ring` once per delayed job, one request each.
   SQS takes a delay per batch entry, so one batch can carry bells with different delays.
9. **The doorbell DLQ is a metric.** A malformed bell goes to the DLQ, and a database error nacks with a backoff.
   Alert on the DLQ and never replay it: the tick re-rings every claimable job anyway. Set SQS DLQ retention to
   the 14-day maximum.

### StateStore

Changes to the sketch, from task 02's provisional interface (`test/model/store.ts`) and the spikes:

1. **No `now` argument.** The store takes an injected `Clock`, defaulting to the database clock. All lease and
   schedule arithmetic uses the database clock, so a worker's clock never enters it. The harness injects a fake clock.
2. **Mutations that make a job claimable return the doorbells to ring**, as `RingItem`-shaped values with the
   delay measured on the database clock at the time of the call (`dueInMs`, 0 when due). The store never rings. The
   caller rings, then calls `markRung`. No absolute time crosses the store/transport boundary.
3. **`rung_at` means "a doorbell is deliverable at this time"**: now, or `run_at` for a delayed bell. It is set only
   for bells the broker took, and cleared whenever a job returns to claimable (retry, recovery, resume, promotion).
4. **Every write is safe to treat as "outcome unknown" on a deadline.** Writes are guarded by lease token or
   version, so a worker that hits the operation deadline can retry or drop the result without a double effect.
5. **Claim does not count an attempt** (see above).
6. **`tick` takes a time budget and returns `moreWork`**, and is safe to run concurrently with itself.
7. **Randomness and ids are injectable.** Upstream's backoff jitter uses `Math.random`, which makes model runs
   unreplayable. Generated job ids must sort in creation order (UUIDv7), because LIFO is checked by creation.

### Connection and driver contract (task 11)

- Pool size default **2** per process. Config validation computes the budget from the formula and refuses a fleet that
  exceeds `max_connections` when the operator supplies the number.
- `tls: { ca }` is required for a cloud database. The driver default is plaintext, and `tls: true` encrypts without
  verifying.
- Behind a transaction pooler: `prepare: false` (or `max_prepared_statements > 0`), no `statement_timeout`,
  `lock_timeout` or idle-in-transaction startup parameters, and schema and timeouts set on the role with
  `ALTER ROLE ... SET`. `search_path` as a startup parameter is accepted and not applied reliably.
- A direct `listenUrl` for `LISTEN`. A transaction pooler delivers nothing to it.
- A per-operation deadline (`ResilientPool` in the spike), `maxLifetime`, `idleTimeout` and `close({ timeout })`.
- `password` may be a function, called per connection, for IAM tokens. Cloud Run's `/cloudsql` socket works through
  `path`. libpq's `?host=/dir` form is silently read as TCP.

### Enqueue and the ring handshake (task 12)

Recorded by task 12; each item is a place where the plan text was refined, not a reversal.

- **`markRung` covers delayed jobs, not only claimable ones.** The interface comment said "only where still claimable". A delayed
  job inside the transport's delay window (SQS 900 s) is pre-rung, and `rung_at` for it is its delivery time (DESIGN.md
  section 3 already defines `rung_at` as "now, or `run_at` for a delayed bell"). The store applies `markRung` to waiting,
  prioritized and delayed jobs, and still leaves an active, finished or removed job alone. A pre-rung delayed job therefore
  has a `rung_at`; task 15's tick has to treat it as rung, not as unrung.
- **Enqueue returns a ring when `dueInMs <= ringWindowMs`.** `ringWindowMs` is a store option, default 0 (only jobs claimable at
  the call). Whatever wires a store to a transport should pass the transport's `maxDeliverDelayMs` so a delayed job is pre-rung at enqueue (not wired yet).
- **Grouped admission keeps `nextval('qcloud_group_order_seq')`.** A rolled-back enqueue leaves a gap and never reuses a value,
  which is all FIFO within a group needs. `qcloud_queue_state.group_sequence` is unused and stays in schema v1 (dropping it is a
  new forward-only migration). RDS Proxy pinning on `nextval` with `prepare: false` is still unverified; task 22 owns that
  check.
- **No job-level `ttl` option exists**, so `qcloud_jobs.ttl` stays NULL. Dedup has its own `ttl`, which is a different field.
- **Admission caps** (new, typed errors): 1,000 jobs per call, 1 MiB encoded payload, 256 characters per identifier.

### Claim, leases and limits (task 13)

Recorded by task 13. Items (a) to (c) widened the interfaces; the rest refine the plan text. Nothing here reverses the gate.

- **(a) `StateStore.release` did not exist.** The gate and the task named release (graceful shutdown) but task 10's interface had
  no method for it. Added to core: `release(lease): Promise<Outcome>`, with the transition cause `'release'`. The fake store and
  the reference model have it too.
- **(b) No setter for rate and concurrency limits.** Added `setRateLimit(queue, RateLimit | null)` and
  `setConcurrencyLimit(queue, number | null)`, the minimum a claim needs to be tested. The rest of queue configuration (stall,
  DLQ, listing) stays with task 15.
- **(c) `claim` had no group pull options.** Added `ClaimOptions.group` (`concurrency`, `limit`, `affinity`), which is what
  upstream's claim takes from the worker. A group's own override in `qcloud_group_state` wins over it.
- **(d) Ordering is merged in code.** Upstream orders ungrouped jobs with one `ORDER BY CASE` over LIFO and FIFO, which no index
  serves. Here a LIFO query and a FIFO query each read their own partial index with `FOR UPDATE SKIP LOCKED`, and
  `mergeByPriority` merges them (priority first; LIFO before FIFO at equal priority). Rows read but not taken stay locked until
  commit; each branch reads at most `capacity` rows, so at most `capacity` extra rows are held.
- **(e) Heartbeat and release stay out of the retry wrapper** (the gate said to decide; the default was kept). Each is one
  `UPDATE` fenced by the token and an unexpired lease: a single-row write cannot deadlock with another statement, and a replay after
  an ambiguous failure could answer "lost" for a write that landed. A deadlock on a claim is replayed once (`runTransaction`: two
  attempts, SQLSTATE 40001, 40P01, 55P03 only). A test drives the helper with scripted failures.
- **(f) A claim counts no attempt and clears `rung_at`**, as the gate said. The model checks `attempts` after every claim
  (`I4.attemptsCounted`), and a planted bug that counts on release fails it.
- **(g) `rung_at` clearing is incremental.** Resume and a limit change clear `rung_at` of pending jobs whose bell was due
  (`rung_at <= now`); a pre-ring of a delayed job (`rung_at` in the future) stays. Release clears its own job's `rung_at`. A rate
  window that rolls over clears nothing: nothing writes at that moment, so the tick has to notice (see h).
- **(h) Rate-limited recovery runs at tick speed.** The tick does not know when the window reopens
  (`rate_window_started_at + rate_duration_ms`), so jobs rung into a used-up window are only rung again by the next tick. A
  simulation (virtual clock, a test-side stand-in for the tick's re-ring, `claim.recovery.test.ts`; **not a measurement of the
  product**) with 60 jobs, 10 per second and a 10 s tick: 50 s to drain instead of 5 s. A ring cap of 3 per tick: 190 s. A window
  longer than the tick (30 s): 150 s, which is the limit's own pace. Task 15 should ring the jobs that the end of the window unblocks
  (`dueForRing` knows the window) and size the per-tick cap to the rate room.
- **(i) Not ported yet.** Dependency filters and repair (task 50), TTL expiry in the claim (task 15), `groupStateRetention` (task
  15: `qcloud_group_state` rows of finished groups stay until then). Upstream's grouped `ready` CTE reads every pending grouped job
  of the queue on each claim; that is O(pending grouped jobs) and is left as it is. Task 22's measurements should include a deep grouped
  backlog.
- **(j) Upstream defect fixed.** A group's own rate or concurrency limit was applied by the claim only when the worker also passed
  a default, so such a group's window was never refreshed or counted. All three places now combine the group's value with the worker
  default by `COALESCE`.
- **(k) The event-journal cost of the 5,000-job case, measured in task 15.** With the journal on, the 8-claimer, 5,000-job
  claim-and-complete path costs about 1.3-1.4 times what it did without it: about 0.07 ms more per job (0.18-0.22 ms per job before,
  0.25-0.32 after), over 4 runs on one local PostgreSQL 18.6, with the application and the database on the same machine. Enqueue showed
  no measurable cost. The per-namespace commit lock serialises the commits that write events, and it did not dominate at this size.
  `journal.cost.test.ts` asserts correctness only and no time, so the figure is a measurement on one machine and not a regression
  guard. Task 22's load check repeats it on Cloud SQL-class hardware.
- **(l) Lease rules.** A heartbeat never shortens a lease, is capped at `started_at + timeout`, and refuses a job already past its
  processing deadline. A claim's lease is shortened by the stall timeout and capped by the same deadline, so the two agree. Release
  refuses an expired lease: the attempt must be counted by recovery.
- **(m) "Enforced inside the claim transaction" is proven black-box.** Eight claimers ask at once on a fixed fake clock: with a
  concurrency limit of 3 they take 3 jobs between them; with a rate of 10 per window, 10; a churn run samples the committed active
  count and never sees more than the limit. As a manual mutation check, removing the shared-to-exclusive upgrade made them fail (24
  jobs claimed where 3 are allowed). No test hook exists in production code for this, on purpose.
- **(n) Arguments.** A claim on an unknown queue creates its `qcloud_queue_state` row, as upstream does. Queue and owner go through
  `identifier` (no NUL, 1 to 256 characters). `n` is rounded down and clamped to `MAX_CLAIM` (1,000); anything not above 0 gives `[]`.
- **(o) The harness grew with the store.** The Postgres target now runs claim, heartbeat, release, pause, resume, rate and
  concurrency limits. The reference model and `FakeStore` share one `QueueLimits` on purpose: the Postgres store is the
  independent implementation. New check `CLAIM.limits`, and two planted bugs (limits ignored, release counts an attempt) that the
  harness must catch.

### Complete, fail, DLQ and recovery (task 14)

Recorded by task 14. Nothing here reverses the gate; (a) to (c) are the points where the plan text and the code part.

- **(a) `StateStore` has no typed lost-lease error.** Step 1 of the task said a stale token returns a `LeaseLostError`. The interface
  (task 10) returns `Outcome { ok, rings }`, and `heartbeat` a boolean, so a lost lease, a second `complete` of the same lease and
  a lease past its time all return `{ ok: false, rings: [] }` and change nothing. That is what makes a retry after an
  `OperationDeadlineError` safe. A typed error would have widened the interface for no caller that needs it (the worker
  drops the job either way).
- **(b) Recovery is a building block, not yet the tick.** The gate says recovery belongs to the tick alone, and the tick is task 15.
  `PostgresStore` therefore has `recoverExpired(limit?)`, `expirePending(limit?)`, `purgeExpiredDlq(limit)` as public methods outside
  `StateStore`, and the model harness has a Postgres-only `recover` command that calls them. "The model passes with `crash`" means:
  the `crash` and `expireLease` commands run, and a `recover` pass takes exactly the jobs the model says are expired, counting an
  attempt each. The tick that calls them is task 15's; its contract is unchanged (lease plus two tick intervals).
- **(c) An unrecoverable failure records `explicit_fail`.** Upstream records `max_attempts_exceeded` for it, which says the attempts ran
  out when they did not. The recorded reason is now the true one.
- **(d) One step for `fail` and recovery.** `settleAttempt` counts the attempt, clears `rung_at`, keeps the history, writes the DLQ entry
  once and returns the ring. Recovery cannot drift from `fail`. A retry is journaled `retried` (a worker's report) or `stalled` (a lease).
- **(e) Every write is fenced** by the token and an unexpired lease under a row lock, and bumps `version`. Recovery takes
  `lease_until <= now`, a worker's write needs `lease_until > now`, so the two never both succeed for one lease. Tests: the same
  `complete` twice, `complete` after recovery, `fail` after recovery, and a recovery pass against a `complete` in flight (the pass
  skips the locked row with `SKIP LOCKED` and takes it next time, if the lease is still due).
- **(f) Retry state lives in `dlq_retry_state`.** The DDL is fixed, so there is no new column. The attempt history (newest 20) and the
  stall count are one blob. A job that stalls `maxStalls` times (default 3, 0 for no limit) goes to the DLQ with attempts left;
  a lease that expires after the processing deadline is a `timeout` and does not count as a stall. The model does not model stalls:
  with `maxAttempts` of 3 or less and the default 3, the attempt limit fires first.
- **(g) Events, metrics and hooks are in the transaction, and a failure rolls the whole change back.** A journal, metric or hook
  error leaves the job as it was, active with its lease, and the same lease can be tried again (tested for `complete`, `fail` and
  recovery). `completed` and `failed` metrics are written at the terminal change; a retry counts nothing. Task 15's journal and its
  metrics reads must not count them twice.
- **(h) The terminal hook is the flow seam.** `onTerminal(tx, changes)` runs in the transaction for each completion and last failure and
  may return rings. Task 50 plugs flow-parent promotion into it. Not ported now: flow-failure application, repeat successors and
  cron-lease protection (tasks 15 and 50).
- **(i) The DLQ limit is enforced in the failing transaction.** Upstream trims after commit. Here the oldest entries are deleted with
  `FOR UPDATE SKIP LOCKED` in the transaction that adds the newest. Each failure counts the rows committed when it runs, so a burst of
  concurrent last failures can overshoot `maxEntries` by the burst, and the next failure trims it. The cost of the trim at the
  10,000-entry default is **not measured**.
- **(j) DLQ age.** `purgeExpiredDlq` deletes failed jobs whose `completed_at + maxAge` has passed (default seven days, `null` for ever).
  It is the tick's work. Reads: `listDlqPage` (oldest first, with the total), `dlqStats` (total, span, counts by reason), `purgeDlq`
  (named entries or the whole queue; never touches a job that is not `failed`).
- **(k) DLQ retry is not implemented**, as the gate decided: fail-closed. Reopening it needs the `version` precondition and an entry
  here and in task 32.
- **(l) Backoff.** Fixed is the base; exponential is `base * 2^attempts`, so the first retry waits twice the base; both are capped at
  `backoff.maxDelay` (default one hour). A base of 0 is 0. Jitter is off, with an injected `random` for a later switch.
- **(m) Rings.** A retry or a recovered job returns a ring with `dueInMs` equal to its backoff, **only when the backoff fits
  `ringWindowMs`**; otherwise it returns none and the job stays `delayed` with `rung_at` null for the tick to pre-ring. With
  `ringWindowMs` 0 only a backoff of 0 rings.
- **(n) Error text.** NUL and lone surrogates (which PostgreSQL refuses) become U+FFFD, the message is cut at 10,000 characters and the
  stack at 20,000, and a handler that throws a non-string gives an empty message. `fail` cannot fail because of what the handler threw.
- **(o) TTL.** `expirePending` deletes pending jobs with `created_at + ttl < now`, with their logs and dependencies, journals `removed`
  (`Job TTL expired`), counts no metric, and skips rows a claim holds. No job option sets `ttl` today (D6).
- **(p) Not known.** A corrupt `stall_config` or `dlq_config` blob would throw (task 15 writes them, through setters that validate). The
  performance of recovery and the DLQ trim under load is unmeasured (task 22).

### Delay, crons, journal and read models (task 15)

Run on PostgreSQL 18.6 only; the PG 16 run is owed at the end. Nothing here contradicts the gate's go decision. Items that
change what a later task may assume are marked **binding**.

- **(a) The tick, in order.** `recoverExpired`, the cron step, `promoteDue`, `expirePending`, `purgeExpiredDlq` and worker expiry,
  event and event-commit trimming, completion and group-state pruning, and last `dueForRing`. Each step is capped by `maxItems`.
  When `maxDurationMs` has passed after a step, the later maintenance steps are skipped and `moreWork` is true; recovery and the ring
  query always run, because they are what the tick is for. A bug in the first version (`moreWork ||= await step()` did not run the
  step once an earlier one had reported more work) was found by a failing test first and fixed with a `note(more)` fold. It also
  repaired older steps that had the same shape.
- **(b) Rings.** The task text said `promoteDue` clears `rung_at` and returns the rings. It does neither, and the difference is a
  decision, not an oversight. A promoted job keeps `run_at` (so it keeps its FIFO place) and keeps `rung_at`: a pre-ring that is in
  flight or delivered needs no second bell, and a job without one is found by `dueForRing`, which runs after the other steps in the
  same tick. Rings are the ring query's work alone. The grace is measured from `created_at` only. The tick returns the cron step's
  rings as well (the creation grace exists for an enqueuer's publish in flight, and here the tick is the creator) and lists a job
  once; the bells `recoverExpired` returns are dropped because the ring query finds the same jobs and applies the cap. A backlog of N
  jobs needs `ceil(N / cap)` ticks to be rung; the ring tests and the model say so. The stored `delayed` state is cosmetic for
  claiming: a claim and every reader treat a stored `delayed` row past its `run_at` as ready.
- **(c) Crons.** Validation is stricter than upstream: the interval is 1 ms to 365 days, `maxLimit` is 1 to 2,147,483,647, the
  schedule must parse, only some job options are allowed in a template, and deduplication needs a `uniqueKey` or `preventOverlap`.
  `skipMissedOnRestart` is dropped: there is no catch-up, so a missed occurrence is never run late. For an interval,
  `scheduled = dueAt + interval` and, when `scheduled <= now`, the next run is `now + interval`. A cron schedule continues from
  `now`. Re-upserting with unchanged timing keeps `next_run`; changed timing recomputes it; `immediately` applies to a new cron only;
  `executions` survives a replace. One `admitJobs` call serves a claim batch, so locks are taken in the order admission fixes. An
  occurrence that makes no job because the previous one is still live (`preventOverlap` on), or because `skipIfNoWorker` found no
  worker, is not counted but still advances `next_run`. With a user key and `preventOverlap` off, a duplicate counts: the occurrence
  happened and deduplication chose not to make another job. A finished cron has `max_limit = executions` and `next_run = 0`.
  **Binding:** a cron's rows are claimed with `FOR UPDATE SKIP LOCKED` and advanced in the claiming transaction, so any number of
  concurrent ticks make each occurrence exactly once.
- **(d) Mutation check for (c).** With the row lock removed from `claimDueCrons`, `CRON.exactlyOnce` fails within 5 runs. The
  minimised history is `upsertCron` then `concurrentTicks(4)`. The source was restored and diffed. There is no permanent planted-bug
  target for crons: the planted-bug targets are fake stores, and the cron path needs the Postgres store.
- **(e) Queue configuration.** Setters are PATCHes. Unknown keys are refused. The stall and DLQ blobs are validated on write (task 14
  (p) is closed). `autoRetry` stays closed (see task 14 (k)). The panel's read-only rule for DLQ `maxAge` and `maxEntries` is the
  Control API's to apply (tasks 30-32), not the store's: the store accepts what a validated caller sends.
- **(f) Workers.** A worker row's liveness is self-asserted. `listWorkers` returns every registered row with an `active` flag
  (capped at 1,000), `skipIfNoWorker` uses the rows whose heartbeat is recent, and the tick deletes rows silent for `workerExpireMs`
  (90 s by default).
- **(g) Read models.** The reads treat a stored `delayed` row past its `run_at` as waiting, so the effectively delayed set is a
  subset of the stored one. Offset paging is capped by `MAX_PAGE_OFFSET`; a deeper read uses the `listJobs` cursor. A job by custom id
  is a primary-key lookup. Counts are index-only and **no counters are maintained**: the risk note in the task asked for counters only
  if an `EXPLAIN` showed a full scan, and none did. A list's total and its items come from separate snapshots, so a page can disagree
  with its total by the jobs that changed between the two reads. **No new index and no migration.**
- **(h) Plans.** Every read-model query has an index-backed plan on PG 18.6: counts by state use `qcloud_jobs_ready_idx` and
  `qcloud_jobs_state_idx` index-only; queue totals use `qcloud_queue_state_pkey` (the planner is forced, because the tables in the
  test are tiny); `listJobs` uses the primary key, or `state_idx` plus a sort, `ready_idx` for waiting and prioritized, `delayed_idx`
  for delayed; a job by custom id uses the primary key; job logs use `qcloud_job_logs_job_idx`; throughput uses
  `qcloud_metric_buckets_pkey` for the day and the 14-day range, and totals use `qcloud_metric_totals_pkey` (forced). The log trim
  `DELETE` was checked with `EXPLAIN` without `ANALYZE`. The clean select, the completion cut and the idle-group query are in the task
  Result. **These plans are PG 18.6; the PG 16 plans are re-checked at the final Docker run, and the plan tests will say if one
  changes.** Tiny test tables make the planner choose by cost, so the plan tests force the index where the table is too small to
  prefer it and say so.
- **(i) Journal.** The gap is stateless: a reader behind the retention horizon jumps its cursor to `(pruned, MAX_SAFE_INTEGER)` and
  is told there is a gap. Events are read first and the watermarks second, so a reader never sees a watermark ahead of its events.
  Retention is a window and a hard cap, and the hard cap always raises the gap. False gaps are possible and safe. There is one
  watermark row per queue. Envelopes are garbage-collected. Defaults: 24 hours, 10,000 events per queue, batches of 1,000.
  `qcloud_event_retention_deltas` rows are folded by the sweep. A rolled-back transaction leaves no event (tested). **Binding for task
  14 (g):** the journal and the metrics reads do not count a completion twice.
- **(j) Logs and metrics.** The per-job log cap is enforced under the job row's lock, so concurrent appends cannot exceed it. An
  over-long message is refused, not truncated. Throughput series are dense (empty buckets are zero). Totals outlive their buckets.
- **(k) Retention.** There is **no autonomous purge of completed jobs**: `cleanJobs` removes completed or failed jobs only on request;
  clean, drain and obliterate of pending states are left to tasks 18 and 31. `pruneCompletions` keeps the newest N completion records
  regardless of whether the job row still exists, which differs from upstream. It writes no journal event. Its cost is about
  `maxCompletedJobs` index-only entries per sweep (default 50,000), so a large limit makes each sweep read that many index entries.
  `read.plans.aux.test.ts` asserts the cut reads at most the keep limit plus one entry and the candidate query fewer than 2,500.
  `pruneGroupStates` deletes an idle group: no waiting, prioritized, delayed or active job. A waiting-children job does not keep a
  group alive. The delete re-check race is harmless and not tested deterministically.
- **(l) Task 50 must reconcile two things.** (1) Completion records are read with `FOR SHARE` by the admission path (the contract is
  in `completions.ts`), so a job that is being admitted cannot lose the record it depends on to a prune. (2) The failed-job
  dependency guard exists only in `cleanJobs` and in the completion prune; `purgeDlq` and `removeFailed` lack it.
- **(m) Task 13 (h) is not done.** `dueForRing` has no knowledge of the rate window: it rings claimable jobs of unpaused queues up to
  the per-queue cap whether or not the window has room, and a window that reopens between ticks is noticed by the next tick. So
  rate-limited recovery still runs at tick speed, as measured in the simulation. The cost of the missing logic is bounded by the cap
  (a few wasted bells per queue per tick). Adding it means reading `rate_window_started_at + rate_duration_ms` for the queue and
  for every group in the ring query, which is a new join on a hot query; task 22's 100k-job load check should decide it with data.
- **(n) The model.** The harness gained `upsertCron` and `concurrentTicks`, a cron model (intervals only; cron expressions are tested
  in the store tests) and the invariant `CRON.exactlyOnce`: a cron's executions, next run and limit match the model, and the jobs it
  made equal its executions. These commands are Postgres-only. Cron jobs live in queues `cron-a` and `cron-b`, outside the model's
  `QUEUES`, so their bells are marked rung but never delivered. The Postgres target uses a pool of 4 so four ticks can hold a
  connection at once. `bun run test:model` passes on the Postgres store, standard (100 runs of 60 commands) and deep.
- **(o) Spike disposal.** Task 15 could not empty `packages/store-postgres/spike/ported/`. 68 of its 70 files are still reachable
  through `spike/harness.ts`, which three spikes use. Task 15 deleted the two dead files (`maintenanceSchedule.ts`, `timers.ts`) and
  recorded the rest: whichever of tasks 17, 20 and 40 removes the last importing spike also removes `harness.ts`, `claimOnce.test.ts`,
  `leaseRecovery.test.ts`, `crashingClaimer.ts` and `ported/`, and task 22 checks. The row in "Spike code disposal" is updated.

### The local transport: NOTIFY, a poll loop and a heartbeat (task 16)

Run on PostgreSQL 18.6 only; the PG 16 run, PgBouncer and TLS are owed at the end. The gate's go decision stands. One gate
decision is **refined** (item (a)); the rest add to it. Items that change what a later task may assume are marked **binding**.

- **(a) A delayed bell is announced by `NOTIFY` with its delay, and held at each listener. Refines the gate's "a delayed job is
  not announced by `NOTIFY`".** The contract suite requires `ring([{ bell, deliverAfterMs }])` to deliver the bell once, and not
  before, its delay has passed, and its bells have no job rows for a poll to find. So the `NOTIFY` payload carries the bell
  (`{"n": namespace, "q": queue, "j": jobId, "d": delayMs}`, `j` and `d` only when set) and every listener keeps the bells of the
  queues it serves in an in-memory buffer (a `MemoryTransport`, which already has the contract-tested delay, nack, visibility and
  capacity logic). A bell is still never delivered early. The poll still finds a delayed job once its `run_at` has passed, with
  or without a bell, so nothing depends on the held bell. **Binding:** the delay precision of this transport is still the poll
  interval, because the poll loop is what runs the buffer's clock (`tick()`): a held bell, a `nack(retryInMs)` and an unsettled
  bell's visibility timeout all fire at the next poll turn. `retryGranularityMs` is the poll interval.
- **(b) The poll loop is the recovery guarantee, not `NOTIFY`.** Each subscription polls on a jittered interval (default 1,000 ms,
  plus or minus 20 %). A turn runs the buffer's clock, and when the worker has capacity and the buffer holds nothing (ready or in
  flight) it asks the store `hasClaimable(queue)` and rings a bell with no job id if so. A worker with capacity 0 makes no
  claim attempt and no read. A failed read backs the next turn off by doubling, up to 8 times the interval. `refresh()` asks for a
  turn now, coalesced. A bell held in the buffer past a cap (default 1,000 per queue) is dropped: the poll finds the job. Bells
  for queues no subscriber of the process serves, and bells of another namespace, are ignored on receipt and `rejected` on `ring`.
- **(c) What Bun's `SQL.listen` does when the connection is lost, measured.** A killed `LISTEN` backend is silently re-established
  by the driver (about 400 ms) with no `onconnect` or `onclose` callback, and a notification sent in that gap is lost (`NOTIFY`
  has no replay). Calling `listen` again on the same connection adds a second handler. **Binding for tasks 19 and 20:** do not
  rely on a hook; the transport sends itself a heartbeat through the pool every `heartbeatMs` (default 5,000) and replaces the
  connection when one is not heard within a period, then runs one catch-up poll. This covers a reset, a stall and a half-open
  connection (tested with a blackholing TCP proxy). `listenerReconnects` counts the replacements and is the metric to export.
- **(d) The probe is the claim's own select.** A bare `EXISTS` over `qcloud_jobs` chose a sequential scan (153,000 rows visited on a
  three-queue table); `hasClaimable` uses the claim's ordered `LIMIT 1` selects, which read `qcloud_jobs_ready_idx` and
  `qcloud_jobs_lifo_ready_idx` and visit no heap row even for a queue whose jobs are all delayed. It takes no lock and does not
  look at rate or concurrency limits, so a limited queue says yes and the claim finds nothing, which is cheap and is how a
  reopened rate window is noticed. That is also the answer to task 13 (h) for the local transport; task 22 still decides it from load data.
- **(e) `stats` are the store's counts, not the buffer's.** `depth` is the claimable jobs (not bells, which are not stored), `inFlight`
  the active jobs, `delayed`, `deadLetterDepth` the failed jobs, `oldestAgeMs` from `run_at` of the oldest claimable job,
  `source: 'postgres-counts'`, `maxStalenessMs: 0`. The contract suite's stats case takes an optional `backlog(queue, n)` hook so a
  transport that reads a store can have jobs, not bells, counted.
- **(f) `LISTEN` needs a direct connection (unchanged), and the fallback is tested both ways.** No `listenUrl` behind a pooler:
  `openListener()` throws, the transport reports `mode: 'poll'` and `pollOnlyReason`, and jobs run on the poll loop (tested with a
  `LocalDatabase` whose `openListener` throws, not through PgBouncer). A direct `NOTIFY` wakes a subscriber before the next poll
  (tested with a 10 s poll interval and a probe counter that must not move). A process that only rings never opens a listener.
- **(g) A cost to keep in mind, not measured.** A notification reaches every listener of the channel, whatever the queue or
  namespace, and each filters in process, so the cost grows with listeners times bells. The channel is an option (default
  `qcloud_jobs_changed`); a per-namespace channel is the lever if it matters. Task 22's load check should include listeners.

- **(h) A bug in task 11's migrator, found by this task's broad run and fixed: `to_regclass` after an advisory-lock wait is stale.**
  Under ten parallel starters on one empty schema, 36 of 40 runs failed with `SchemaVersionError: "qcloud_jobs" exists but there is
  no migration record`. A backend that waits on `pg_advisory_xact_lock` does not process catalog invalidations while it waits
  (unless the invalidation queue overflows), so a lock-free `to_regclass(...)` can still answer "absent" from the backend's name
  cache for a relation the lock holder created and committed meanwhile, while a `pg_class` read is current. The migrator's
  post-lock `readRecorded` then saw no record table, and `refuseForeignTables` found the holder's own `qcloud_jobs`. The fix reads
  `pg_class` joined to `pg_namespace` (`relationExists`) for both checks. A failing test came first
  (`schema.migrate.race.test.ts`, a holder that creates a two-table stub while a starter waits: 3 of 3 failed, 3 of 3 pass after);
  the ten-way stress is now 40 of 40. **Binding for later migrations and any code that reads the catalog after taking a lock:**
  do not use `to_regclass`, `regclass` casts or other name-cache lookups for "does it exist" there; read `pg_class`. PG 18.6 only; the
  PG 16 run repeats the stress.

### The Pub/Sub transport (task 17)

Run on the Pub/Sub emulator and PostgreSQL 18.6 only; the real-project run (D9) and the PG 16 run are owed. The gate's decisions
stand (one topic per environment, one filtered subscription per queue, `maxDeliverDelayMs: 0`, ack after the claim attempt, a
doorbell DLQ that is a metric). Items that change what a later task may assume are marked **binding**.

- **(a) The official client runs under Bun 1.4.2, so there is no REST fallback.** Streaming pull, shutdown with `WAIT`, a stream
  that ends with a fatal error, and a SIGKILLed Bun worker whose bell another Bun worker takes over all work against the emulator.
  The real service is the D9 item. The client's `allowExcessMessages` must be `true`: with `false`, a `WAIT` close waited out its
  whole timeout (a regression test, `close returns promptly ...`). The cost is that the client may hand over more bells than its
  flow control while closing, which the transport's own queue (item (b)) absorbs.
- **(b) A bell that finds no capacity waits un-acked in a local FIFO; `capacity()` is asked per bell.** `PubSubTransportOptions.maxHeld`
  (default 8) bounds the bells a process holds un-acked per subscription: the ones whose claim attempt is running plus the ones
  waiting. A held bell is invisible to every other worker until its ack deadline, so `maxHeld` is kept small and the held bells are
  extended only while held (`maxExtensionMs`). `close()` nacks the waiting bells and waits for the running handlers.
  **Binding for task 30:** a worker takes its slot synchronously, before the handler's first `await`, because the next `capacity()`
  question is asked as soon as the handler's synchronous part returns. A handler that returns or throws without settling its
  delivery gets the bell nacked.
- **(c) Hoarding by `maxHeld` is not measured.** The emulator ignores server-side flow control, so "a busy worker takes no more than
  `maxHeld` bells and the rest stay visible to other workers" is a `test.todo`. It is the first thing the real-project run must
  show, and task 22 reads it as an autoscaling input (the backlog an autoscaler sees is the unclaimed jobs only if nothing is hoarded).
- **(d) `nack(retryInMs)` holds the bell locally, up to `maxNackHoldMs` (default 30,000), and burns no delivery attempt.** A bell
  nacked without a hint goes back at once and counts towards `maxDeliveryAttempts`. The emulator's retry backoff is not
  exponential (the service's is, between the subscription's minimum and maximum backoff, task 21 sets them), so redelivery
  timing is only checked as "it comes back".
- **(e) A malformed body is `bell: null`; the worker nacks it and the subscription dead-letters it after `maxDeliveryAttempts`.**
  Tested: five deliveries, then the dead-letter subscription holds it, exactly (the emulator's dead-lettering is exact, the service's is
  best-effort). The DLQ is a metric: `stats().deadLetterDepth`, never replayed.
- **(f) `stats` come from Cloud Monitoring, cached, and degrade.** `source: 'cloud-monitoring'`, `maxStalenessMs` is the 5 min metric lag
  plus the cache (30 s default), a series that is missing is `null`, never 0, a failing API is not asked again for 10 s, and nothing
  throws into the worker loop. `inFlight` is always `null` (Pub/Sub has no cheap figure) and `delayed` is 0 (a Pub/Sub bell is never
  delayed). On an emulator, which has no Monitoring, `stats` answers `source: 'unavailable'`. **Not verified:** the metric names, the
  filter and the response shape are tested against a stub of the API, not the live one.
- **(g) Fault scenarios of spike 03, now automated against `PostgresStore`, with what the new store does differently.** Baseline,
  4a (the ring fails after commit; half a batch taken), 4b (a duplicate bell), 4c (a crash before and after the ack), 4d (a worker
  past its ack deadline) and 4e (paused and rate-limited queues) all pass, under the ledger checks of the model harness (I1 to I5)
  plus "every claim is a `pulled` event". The differences from the spike, none of them a defect:
  - `resume` clears `rung_at`, so the first tick after a resume rings at once; the spike waited the re-ring threshold.
  - **Binding for task 30:** `heartbeat(lease)` extends to the **store's** `leaseMs`, not the claim's. A worker builds its store with
    the lease length it claims with, or its heartbeats shorten the lease.
  - Recovering the lease of a dead worker **spends an attempt**. A job enqueued with the default `attempts: 1` that loses its worker is
    failed for good (`max_attempts_exceeded`), which is upstream's behaviour; a job that must survive a crash needs `attempts` of 2 or more.
    The scenario's first run hid this behind a job that was simply failed.
  - `complete` is refused once the lease is due, whether or not another worker has the job. The crash tests read `lease_until`
    and the database clock in one statement, because a heartbeat the dead worker sent just before the kill can still land.
- **(h) The scenario ledger's checker has its own tests** (`ledger.test.ts`, the spike's `invariants.test.ts` rewritten for the new store),
  so a checker that cannot fail would be noticed.
- **(i) The shared contract suite changed in one place:** the delayed-bell case branches on `maxDeliverDelayMs < 400`: a transport that
  cannot delay must answer `delay-too-long` and deliver nothing early. The memory, Postgres and Pub/Sub transports all pass it.
  The suite also takes a `timeoutMs` option (`ContractOptions`, in `test/contract/harness.ts`) for every test. Bun's default is 5 s and a
  test that waits for a redelivery on Pub/Sub takes 4 to 5 s with its topology set up; in a full run three of them timed out, and
  because they share one namespace the first timeout's teardown broke the next. `pubsub.test.ts` sets 30 s.
- **(j) The spike directory is not fully gone, and task 17's acceptance line says it should be.** Six files that the replaced scenarios
  used are deleted (`crash.test.ts`, `crashingWorker.ts`, `delivery.test.ts`, `pubsub.ts`, `scenario.ts`, `worker.ts`, with `tools/`).
  `spike/doorbell/{store,ring,sweep,invariants}.ts` and `invariants.test.ts` stay, because `spike/db-access/` (`store`, `ring`, `sweep`)
  and `spike/doorbell-aws/` (`store`, `invariants`) import them. Moving them would only rename the directory. **Binding:** task 20
  removes `spike/db-access/` and task 40 removes `spike/doorbell-aws/`; whichever goes last also removes `spike/doorbell/`, and task 22
  checks it is gone. The two measurement tools (`doorbellGranularity.ts`, `emulatorFidelity.ts`) are deleted: their results are in
  spike 03's write-up, and the facts they established are now regression tests in `packages/transport-gcp/test/`.

### The Queue SDK and the store's control facet (task 18)

Run on PostgreSQL 18.6 and the in-memory transport only; the PG 16 run is owed. The gate's decisions stand (the SDK rings after the
commit, `markRung` only for `ok` items, relative `deliverAfterMs`, the tick repairs). What task 18 found, and what a later task may
assume (**binding** where marked):

- **(a) Job ids are unique per namespace, not per queue, and the store does not know it.** The jobs table keys a custom id on the
  namespace. The SDK therefore checks the queue before every id-based call: a job of another queue reads as missing, and a custom id
  that a live job of another queue holds is refused with `UnsupportedOptionError('jobId', ...)` after the call's other jobs were
  added. **Store gap, not fixed here:** `plan.ts` replaces a *finished* job of the same id without comparing queues, so
  `queueB.add('x', data, { jobId })` can delete a finished job of `queueA`. Closing it takes either a store refusal for a finished
  job of another queue (no schema change) or a key of `(namespace, queue, id)` (a retype, which the migration rules allow only in two
  releases). Decide before 1.0. Until then, a deployment that reuses custom ids across queues of one namespace should namespace the ids.
- **(b) `attemptsMade` counts failed and stalled attempts, and is 0 while a job runs.** The store bumps `attempts` in `fail`, `settle`
  and `recovery` only. Qelay maps `attemptsMade` the same way, so the SDK shows it unchanged; a processor that wants "which try is
  this" reads the worker's own counter (task 19).
- **(c) Migration v3 adds `progress` and `progress_message` to the jobs table** (nullable or defaulted, so an old worker still connected
  is safe) and two journal event types, `progress` and `obliterated`. Progress writes do not bump `version`. The DDL snapshot is
  regenerated on PG 16 at the end, with the rest of the owed Docker runs.
- **(d) `drain`, `clean` and `obliterate` are bounded per call and the SDK loops.** `drain` and `cleanPending` skip a job another
  transaction holds and a job a live flow parent waits on (`flowGuard.ts`); `obliterate` refuses an active job unless forced. A
  caller that is cut off in the middle has deleted a prefix, never a half of one job. **The panel's buttons for these three stay closed**
  until task 31 adds the confirm field and `expectedVersion` fencing (the gate's fail-closed rule).
- **(e) Hand-offs.**
  - **Task 19 (binding):** the worker rings after `complete` and `fail` exactly as `add` does (ring, then `markRung`, a failure
    logged and swallowed); it takes its concurrency slot synchronously, before the handler's first `await`; it builds its store with
    the worker's own lease length; `close` always returns, with a timeout. `QueueEvents` reads the journal, which now carries
    `progress` events with the progress value (the text of an object or string progress is in the job row, not the event).
  - **Task 31 (binding):** the operator role, the confirm field and version fencing for the destructive actions above. A DLQ retry
    stays closed (task 14 (k)).
  - **Task 20:** the tick re-rings every job the SDK left unrung, within `reRingAfterMs`; the SDK tests only assert that
    `rung_at` stays null for exactly the failed bells.
- **(f) Not supported in the producer API, each recorded in `docs/compat.md` with its reason:** DLQ retry and `retryCompleted`,
  `retryJob(s)`, group administration, job schedulers, deduplication-key lookup and release (there is no store facet for them),
  `getCountsPerPriority`, `getMetrics`, `trimEvents`, `forward`, `rateLimit`/`getRateLimitTtl`/`isMaxed`, and the `durable`,
  `repeat`, `debounce`, `parent`, `keepLogs`, `timestamp`, `stackTraceLimit` and `sizeLimit` job options. `durable` matters most for
  migration: the upstream multibroker example passes it, and the SDK refuses it by name.
- **(g) `docs/compat.md` is enforced by a test** (`packages/sdk/test/queue.compat.test.ts`): it lists the 134 public names of
  Qelay's `Queue` class chain and fails when one, or a public method of this `Queue`, is missing from the file.

### The Worker and QueueEvents (task 19)

Run on PostgreSQL 18.6, the in-memory transport and the Pub/Sub emulator; the PG 16 run is owed. The gate's decisions stand (the
worker keeps its own slots and asks for no bell while busy, claims by queue and never by a bell's job id, rings after `complete`
and `fail`, and closes in the order stop subscribing, drain, release, close the transport, close the store). What task 19 found,
and what a later task may assume (**binding** where marked):

- **(a) A bell can find its own job locked, and the worker rechecks once. Found by a flaky test, not by design.** `ringAfterCommit`
  rings the transport and then runs `store.markRung`, an `UPDATE` of the job's `rung_at`. A transport that delivers at once (the
  in-memory one always; a broker may, before the publisher has its acknowledgement) starts the claim while that `UPDATE` holds the
  row, and a claim never waits for a row another transaction holds (`FOR UPDATE SKIP LOCKED`). The claim is empty, the bell is
  acknowledged, and the job waits for the tick's re-ring: no loss, but the doorbell's whole point is lost for that job. Measured
  on the zero-latency `MemoryTransport` in roughly one full-suite run in three to six, never in an isolated worker file.
  **Handled in the worker, and binding:** an empty claim while the queue still has a job `waiting` or `prioritized` is made once
  more after 25 ms (`workerClaim.ts`; the count `qcloud.worker.claim_rechecked`). Once, so a job that stays unclaimable (a paused
  queue, a full group, a rate limit) costs one extra claim per bell, not a loop; a bell for a queue with nothing waiting costs one
  lookup and no second claim. Pinned by `claim.locked.test.ts` (the store) and `worker.locked.test.ts` (the worker).
  **Widened in task 20.** Task 19 keyed the recheck on the bell's own job. Bells are fungible, so that was too narrow: another claim
  can take the bell's job while a different one is the locked one, and the recheck never ran. See "The tick as built (task 20)", (c).
  **Rejected:** a bounded retry inside `claim` (the hot path, and a grouped claim would retry on false positives); setting `rung_at`
  in the add transaction (it would record a bell the broker has not taken, against the gate's rule that the caller reports only the
  bells it got); doing nothing and leaving it to the tick (the tick is opt-in). **Hand-off to task 20:** the tick is what bounds
  invariant 3 if the recheck is ever missed, so its tests keep a case for a job whose first claim lost this race; decide there whether
  a store-side mitigation is still wanted. *Decided in task 20: none. The queue-keyed recheck closes it, and the tick stays the bound.*
- **(b) The watchdog rule (binding).** A job's lease is treated as lost at *the start of the last confirmed beat plus the lease
  length*, which is never later than the database's own expiry, so a worker never writes after a recovery may have handed the job on.
  A beat that throws proves nothing; only the clock decides. A lost job's abort signal fires, its outcome is dropped and nothing is
  written. Heartbeats run on a real timer at a third of the lease, so a processor that blocks the event loop for longer than
  `lockDuration` loses its lease like a dead worker: do the heavy work off the loop or raise `lockDuration`.
- **(c) The processor's second argument is `{ signal }` (binding, an addition to the Qelay shape).** Qelay's `ProcessorContext` also
  carries a `signal`; the SDK passes `{ signal: AbortSignal }` only, which aborts on lost lease, unconfirmed lease and a `close`
  whose grace has run out. `job.updateProgress` and `job.log` become no-ops from then on.
- **(d) A listener that throws, or an `error` with no listener, cannot take the worker down.** Listeners are called in isolation
  (`typedEmitter.ts`): a throwing one is logged and the rest still run. Node's rule that an unhandled `error` event throws is not
  followed: a worker with no `error` listener logs the error (`worker error`) and goes on.
- **(e) `QueueEvents` polls, and this contradicts one line of DESIGN.md.** The journal sends no notification, so the reader reads
  it every 250 ms (up to eight times that on a quiet queue; `pollInterval`), using one pooled statement per read. DESIGN.md's
  connection budget says "Each `QueueEvents` listener adds one direct connection that bypasses the pooler"; **it does not**: a
  reader costs no connection of its own while it waits. Amended in DESIGN.md by task 70 (2026-10-17).
  What it buys: a cursor `{commitSeq, eventId}` that follows commit order, so a late-committing transaction is still delivered, and a
  reader that stops and resumes from a stored cursor sees no gap and no duplicate. The cost: an event arrives up to one poll later.
- **(f) What a journal event cannot carry, and the SDK's `QueueEvents` therefore leaves out.** `completed` has no `returnvalue`
  (read it with `queue.getJob(jobId)`), `delayed` has no `delay`, and `progress` carries the numeric value only. Retention can
  delete events a slow reader had not read: it emits `gap` and goes on from the oldest event left. A stall with no attempts left is
  journaled as a terminal `failed`, not `stalled`.
- **(g) Consequences the processor owner should know (recorded in `docs/compat.md`).** A job the claim holds back (its group is
  full, its group's rate limit is spent, a retry's backoff has not elapsed) is taken at the next bell or tick after the hold ends,
  not at the instant it ends: the worker asks for no bell while it is busy, and a bell it nacked is redelivered after 250 ms (no free
  slot) or one second (a failed claim). `attemptsMade` counts failed and stalled attempts only (task 18 (b)).
- **(h) Hand-offs.**
  - **Task 20 (binding):** the in-process tick joins the shutdown order between releasing leases and closing the transport; the SDK
    still does not import `maintenance`. See (a) for the race the tick's tests keep.
  - **Task 50:** flow-parent promotion plugs into the worker's terminal path (`onTerminal`).
  - **Task 70:** the migration guide takes `{ signal }`, the polling `QueueEvents` and the missing `returnvalue` from here.
  - **The model harness** (`test/model/`): the `postgres-workers` target hands each bell the model would claim with, and each lease it
    would end, to a real `Worker` over a fault-injected stand-in transport; the `crash` command stays out (a worker's death is
    `worker.crash.test.ts`). The task's Result says what ran and what did not.

### The tick contract

This replaces the sweep wording in DESIGN.md section 3.

- **Re-ring rule.** The tick rings every claimable job in an unpaused queue whose last doorbell is at least
  `reRingAfterMs` old. `reRingAfterMs` must not be greater than the tick interval. Without it, a dropped publish
  leaves a job stuck.
- **Bounds on the re-ring.** A cap per queue per tick, because under a backlog the tick would otherwise ring one
  doorbell per waiting job on every tick. A grace period for a job with no `rung_at` yet, so the tick does not
  ring jobs whose publish is still in flight.
- **Bells are fungible.** A bell's `jobId` is a hint and the claim takes the next job in queue order. `rung_at`
  therefore counts bells, and **the age threshold, not the null check, is what bounds invariant 3**.
- **Recovery is the tick's alone.** A later doorbell claims nothing while a dead worker's row is `active`. Recovery
  leaves the job `delayed` by its backoff, so the worst case is the lease plus two tick intervals.
- **Delay window.** The tick pre-rings jobs whose `run_at` falls inside the transport's window. The window is clamped
  to `maxDeliverDelayMs` and should be at least one tick interval plus the worst tick lateness.
- **In-process tick (opt-in).** Always-on workers may run the tick themselves every few seconds (default 5 s),
  with the leader chosen by a **lease row** read against the database clock, not a session advisory lock: a session
  lock admits two holders behind a pooler. Lease length is about three intervals. The tick must remain safe to run
  concurrently, because the lease is an efficiency device, not a correctness fence. Measured lateness on the built loop
  is about half the interval when the tick rings a delayed job only once due, close to nothing (about 6 ms) when it
  rings ahead, and never early. The numbers are in "The tick as built (task 20)".
- **Cloud Scheduler stays.** The 1-minute scheduler tick is the safety net and the cron source. The in-process tick
  never replaces it.

### The tick as built (task 20)

`packages/maintenance`: `runTick` (one pass), `runTicks` (passes until nothing is left or the run budget is spent), `ringDue`,
`TickLoop` (the in-process loop), `createTickHandler` (`POST /internal/tick`) with `sharedSecretAuthenticator` and
`oidcAuthenticator`, and the CLI `qcloud-tick run | serve`. The contract above stands; nothing in this section is a deviation
from it. Run on PostgreSQL 18.6 with the in-memory and local transports and the Pub/Sub emulator; the PG 16 run is owed.

- **(a) What the contract's numbers became.** Defaults: interval 5 s (60 s for the CLI and the endpoint, the scheduler's period),
  `reRingAfterMs` = the interval (more is refused when the tick is configured), grace 2 s, 100 rings per queue per tick, 200 items
  per pass, 5 s per pass, 20 s per invocation (and never past the interval for one beat of the loop), worst lateness 1 s. The
  delay window is `interval + worst lateness` unless set, clamped to the transport's `maxDeliverDelayMs` and to the store's
  `ringWindowMs`; a value below that floor is refused, and `0` means "ring delayed jobs only once due". The config reports
  `delayPrecisionMs`, the lateness the window does not cover. The loop's lease is at least two intervals (default three), so one
  late beat cannot hand the lead over.
- **(b) What was measured**, on the real `TickLoop` with real timers, the database's clock for both ends and a transport that adds
  almost nothing (`scripts/measure-tick-lateness.ts`; 60 jobs per row, three runs; `docs/limits.md` quotes these, add the broker's
  own latency on a real queue):

  | Interval | Window | Lateness mean | p95 | max | Early bells | A tick pass |
  | --- | --- | --- | --- | --- | --- | --- |
  | 500 ms | 0 (ring once due) | 270-292 ms | 479-513 ms | 488-495 ms (one run 1,165 ms, see below) | 0 | 28-34 ms |
  | 500 ms | 1,500 ms | 6-7 ms | 8-10 ms | 9-10 ms | 0 | 12-16 ms |
  | 2,000 ms | 0 (ring once due) | 1,080-1,113 ms | 1,950-1,956 ms | 1,993-2,004 ms | 0 | 21-25 ms |
  | 2,000 ms | 3,000 ms | 6-8 ms | 11-15 ms | 11-17 ms | 0 | 14-20 ms |

  Spike 05's floor for the same loop was a mean of 343 ms at 500 ms and 1,190 ms at 2,000 ms, so the built loop is a little better
  where it rings once due and far better where it rings ahead. Zero rings were early in any run, which is what matters:
  `run_at` is a floor. The one 1,165 ms job came in the first case of a run, so cold connections are the likely cause; it
  was not reproduced and not diagnosed, and it is inside the contract's bound for one lost bell (three intervals). Twelve further runs
  of the same case had a worst of 489-521 ms. The windowed rows are the broker's lateness and not the tick's: on Pub/Sub, whose window is 0, the
  top rows are the ones that apply.
- **(c) A finding in the worker, fixed here.** The lateness runs showed jobs 1 to 3 intervals late at window 0. The cause is not
  the tick: the tick's `markRung` `UPDATE` holds the row locks of the jobs it just rang, a worker's claim skips locked rows, and
  a bell delivered in that moment claims nothing. Task 19's recheck covered a bell whose *own* job was still waiting. With
  fungible bells that is not enough: when another claim has taken the bell's job and a different waiting job is the locked one,
  the bell did not recheck, and the locked job waited for the tick's re-ring (up to `reRingAfterMs` plus an interval: two minutes
  with a one-minute scheduler). Invariant 3 held, so this is a latency hole and not a correctness one, but it is frequent on
  transports that deliver at once. A failing test reproduced it (`worker.locked.test.ts`), and `claimForBell` now rechecks once
  when the queue has any job waiting, using one `listJobs` probe that is best effort (a failed probe means no recheck). With
  it the outliers are gone. Task 19's rule in item (a) above is amended to match. `BellClaim` lost its `jobId`.
- **(d) Safety under failure.** The chaos test (`chaos.test.ts`) enqueues at random, loses half of the rings after reporting them
  `ok`, kills workers holding jobs, and checks after every step that no claimable job has waited longer than `reRingAfterMs` plus
  an interval without a bell due. Worst gap observed against the bound: 1,717-1,743 ms against 2,250 ms (interval 1,000 ms);
  3,222 ms against 3,750 ms (interval 2,000 ms, `reRingAfterMs` 1,500 ms); 697 ms against 1,200 ms on the local transport with real
  timers and its poll loop off. Everything enqueued completed exactly once and `attempts` equalled the deaths. A control run with
  no ticks breaks the bound and strands jobs, so the checks can fail. **A harness note:** a queue's `maxStalls` (3) fails a job
  that stalls that often, by design, so the harness caps the deaths of one job (`maxCrashesPerJob`, 2).
- **(e) Concurrency.** Four concurrent ticks create one job per cron occurrence, recover a dead worker's job once and count its
  attempt once, promote and expire each job once, and may ring a job twice but record it once (`concurrent.test.ts`). The overlap
  during a real lease takeover is not a separate test: the lease is an efficiency device and the four-tick cases are the same
  assertions.
- **(f) Election.** Three real processes on real timers against the database clock (`election.test.ts`, interval 200 ms, lease
  1,000 ms): one holds the lease continuously and it alone ticks; after a `SIGKILL` of the leader another leads within the lease
  plus an interval, never before the dead leader's lease ran out; after a `SIGTERM` the lease is released and a follower leads
  within about an interval or two, not a lease; a late joiner never takes it from a live leader. Behind PgBouncer
  (`pooled.test.ts`, which needs the `pgbouncer` profile and has not been run) the same lease is held by one of three loops.
- **(g) Endpoints.** `POST /internal/tick` authenticates before it looks at the method, answers a bare 401 to anything else, returns
  counts and milliseconds only (no ids, queue names, payloads or error text) and a 500 that says only that the tick failed. A
  shared secret is at least 24 characters and compared in constant time; OIDC (a Google-style RS256 identity token) checks the
  signature against the issuer's JWKS, the issuer, the audience, expiry and not-before, and a verified email on an allow list of
  service accounts (`allowedEmails`, at least one: a token from any Google account is not enough). The CLI and the loop read the database URL and secrets from the environment only, and `redact.ts` removes them
  (the whole value and a URL's password) from anything that reaches a log or telemetry.
- **(h) Hand-offs.**
  - **Task 21/36:** the scheduler's service account and the endpoint's URL are the OIDC options `allowedEmails` and `audience`; the
    scheduler's period is `QCLOUD_TICK_INTERVAL_MS` (default 60 s).
  - **Task 22:** `docs/limits.md` quotes (b) and says which transports rely on which row; delay precision on Pub/Sub is the
    interval, on SQS and the local transport it is the broker's.
  - **SDK:** the in-process tick joins the shutdown order between releasing leases and closing the transport
    (`TickLoop.stop` gives the lease up). The SDK still does not import `maintenance`; the worker's host starts and stops the loop.
  - **Task 35:** the panel's "last successful tick" comes from `store.maintenance.tickStatus()`.
  - **Run at the end of the plan:** `pooled.test.ts` and the pooled claim in `connection.pooled.test.ts` with PgBouncer, the
    PG 16 run, and the Docker-backed model run.

### The GCP infrastructure as built (task 21)

`infra/gcp/` is ten modules and one example environment (52 resources with the CI values). It is planned and checked, **never
applied**: `bun run check:terraform` (CI job `terraform`) runs `fmt -check`, `init -backend=false`, `validate` and a plan against a
placeholder token, then 109 assertions on the plan. Details are in `infra/gcp/README.md`; the decisions that the gate left open are:

- **(a) The budget is a precondition, and the flag follows the budget.** `infra/modules/budget` (moved there from `infra/gcp/modules/` by task 42, so both clouds share it) computes `direct` and `pooled` with the
  arithmetic of `budget()` in `packages/store-postgres/src/connection/budget.ts` and refuses a plan whose requirement exceeds
  `max_connections`. The database's flag is read from the budget module's output, so it cannot be planned unless the budget fits.
  The check script compares the Terraform figures with the TypeScript ones for 10, 50 and 200 workers, with and without a listener per
  process. A first draft left LISTEN connections out of the pooled figure; the cross-check would have caught it, and it is fixed.
- **(b) No Cloud SQL IAM role.** The task text listed "Cloud SQL client" for the workers and the tick. A direct private-IP connection
  with a password over TLS is not governed by Cloud SQL IAM; only the Auth Proxy or the `/cloudsql` socket needs `cloudsql.client`, and
  this design uses neither. The five roles in use are `pubsub.publisher`, `pubsub.subscriber`, `secretmanager.secretAccessor`,
  `run.invoker` and `iam.serviceAccountUser` (the last only for `deployer_members`); the plan check fails on a sixth or on a primitive
  role. Each is bound on one resource: there is no project-level IAM at all.
- **(c) Queue provisioning is Terraform only.** A subscription's filter is immutable, so a changed filter replaces the subscription.
  The subscriptions set `expiration_policy { ttl = "" }`. **The SDK's dev helper `ensureQueue` does not**, so a subscription it creates
  expires after 31 days without a pull. That is harmless for tests and wrong for anything that lives; the README says so. Not changed
  here, since the helper is task 17's and the Terraform is the production path.
- **(d) The tick's audience is computed, not read.** Cloud Run's URL has the form `https://<name>-<project_number>.<region>.run.app`,
  and the scheduler's OIDC audience must equal what the tick requires; the tick needs its own URL in its environment, and a resource
  cannot read an attribute of itself into its own configuration (a cycle). The audience is the deterministic URL, and a `check` block
  compares it with the real `uri` after an apply. `project_number` is a variable rather than a lookup so a plan needs no credentials.
- **(e) A tick service of its own.** A `tick` module (one instance, `cpu_idle`, public URL, OIDC only) rather than the worker module with
  different settings: the two have different ingress, scaling, invoker and secrets. It counts as one of the three control processes.
- **(f) The tick reads `QCLOUD_DATABASE_POOL_SIZE`.** The budget counts `pool_size` per process, so the process must use it. The
  environment reader of `packages/maintenance` gained the variable (a positive integer, else `UnsupportedOptionError`), with tests.
- **(g) TLS.** Cloud SQL runs `ENCRYPTED_ONLY`; the CA is a secret mounted as a file and given as `QCLOUD_DATABASE_TLS_CA_FILE`. The
  other modes are `unverified` and, with a pooler only, `off`. Whether hostname verification passes against Cloud SQL's CN-only
  certificate stays unproven (below).
- **(h) What the Terraform does not do.** It does not create a pooler (set `pooler` to point at one), does not run SQL (so the
  role-level `ALTER ROLE ... SET` that a pooler needs for a non-default schema or timeouts is left to the operator, and the defaults need
  none), and does not create the control plane's service account (task 36).
- **(i) `listen_connections`.** On GCP nothing holds a LISTEN connection (see "The Worker and QueueEvents", item (e)), so the variable
  defaults to 0 and exists for a service that runs the local `postgres` transport.
- **Needs D9** (the README's list): TLS hostname verification, Direct VPC egress to the private IP, dead-lettering with the service
  agent's grants, the `max_connections` value the tier accepts, the deterministic audience, OIDC accepted by both Cloud Run IAM and the
  application, `ttl = ""`, the subnet sizing (`2 x (instances + 1)` against usable addresses, derived from the instance count and not
  measured), the alert metric filters and the secret mount.

### The Phase 1 gate (task 22)

Phase 1 is complete **on the local stacks**: the core runs end to end on the in-memory, Postgres and Pub/Sub-emulator stacks. The GCP run of
the exit criterion was **not run** (D9: it needs a real project and an apply), and your review of this gate (step 8) was not obtained
separately: work continued under your standing instruction to go through every task, so Phase 2 is conditional on that review.
What did run, and where the figures are: `bun run test:scenarios` (12 scenarios on 3 stacks, 36 tests, 75-97 s); `bun run test:model`
deepened to 500 runs of 150 commands, green on the fake, on Postgres and on Postgres with workers (condition 1 of this gate, closed on
PostgreSQL 18); the load check (`scripts/load-check.ts`, `scripts/load-local.ts`, full 100,000-job runs); `examples/orders` as a test and
a demo. The numbers and the "not run" list are in [docs/limits.md](../limits.md). The findings are:

- **(a) The tick's re-ring is bounded per pass, not per beat.** `maxRingsPerQueue` caps one pass, but a beat repeats passes while work is
  left, for up to its interval, and a bell older than `reRingAfterMs` (default: the interval) is rung again. A deep healthy backlog is
  therefore re-rung in full every interval, because a bell in a broker and a lost bell look the same (they are fungible). Measured on
  100,000 jobs on a local database: 1.5 to 2 tick bells per job (148-198k) at a 5 s and at a 1 s interval, and 1,632-2,090 against
  3,130-3,295 jobs/s with no tick. No job was lost or run twice. **Open decision for you:** let only a job's first ring repeat within a
  run (cheap, but a bell lost *during* a long run is then repaired a beat later), or leave it and rely on the 60 s Cloud Scheduler
  interval and a longer `reRingAfterMs`. Not changed here: it alters the tick contract (task 20), and the figures are local.
  **Follow-up (review R10, 2026-10-19), still your decision:** the tick contract is unchanged by default. Three opt-in or
  separable parts were added: `maxStaleRingsPerQueue` (a separate cap for re-rings, so first rings keep the full cap; a low
  value delays the repair of many lost bells, to `cap` per pass), the producer's `ringCoverMs` (one bell per queue per window
  instead of one per job; the worker's `claimAgain`, on by default, is what lets one bell drain a backlog), and nothing else
  in the tick. The bells saved were counted on the local transports and Postgres only, never on a real queue (D9), and
  the default of `ringCoverMs` and of the stale cap stays off until that load check is run.
- **(b) A rate limit or a global concurrency limit serializes claims on one row.** 1,313-1,361 against 3,054-3,102 jobs/s on one hot
  queue, with a limit that never binds (`Lock:tuple`, about 27 waiters per poll). An exact limit needs it. Left as it is, so the limit stays
  exact; spread hot work over queues. **Open for you** only if a rate-limited queue must exceed about 1,300 claims per second.
- **(c) Event-writing commits of one namespace pass one advisory lock** (the journal assigns `commit_seq` at commit). About one waiter
  per poll at 3,000 jobs/s. Inherent to the ported journal; not changed.
- **(d) Retention does not keep up with a burst in one pass.** After a 100k drain the journal held 300,000 events and 200,000 envelopes
  against a cap of 10,000 events per queue, then came down over later beats. Two statements of the tick were quadratic on a table the
  planner knew nothing about, and are **fixed here, each failing test first**: `pruneEventCommits` scanned every live envelope per pass
  (now a bounded round-robin window in `eventCommitPrune.ts`), and the retention fold joined 40,000 counts to the rows it had locked as a
  nested loop (790 million join-filter rows, 32 s, over the 10 s deadline; now a delete by key). Each has a plan row in
  `schema.planned.ts`; neither changed the schema, so there is no migration and the DDL snapshot is untouched.
- **(e) The ring's "next queue" hop** uses `qcloud_jobs_state_idx` where the plan test names the ring index. Both are fast (0.016-0.030
  ms at 100,000 rows); the plan test was left as it is.
- **(f) Completions of one queue serialize on its metrics rows** (`metrics.ts` upserts them last in the completion transaction): about 14.5
  `Lock:transactionid` waiters per poll on a hot queue, still about 3,000 jobs/s on a local database. On a managed database a commit takes
  longer, so a single queue's completion rate is bounded by one commit time (an expectation, not measured). Inherent to the ported metrics.
- **(g) Two corrections.** DESIGN.md said a `QueueEvents` listener adds a direct connection; it adds none (task 19, item (e)), and the line
  and two comments in `budget.ts` are fixed (the LISTEN connection is the local transport's). `docs/limits.md` said the same and is fixed.
- **(h) Spike code.** `packages/store-postgres/spike/` still holds 93 files, which nothing in `src/`, `test/`, `examples/` or `scripts/`
  imports: `doorbell-aws/`, `ported/`, `harness.ts`, `claimOnce.test.ts`, `leaseRecovery.test.ts`, `crashingClaimer.ts` and
  `doorbell/{invariants.test.ts,invariants.ts,store.ts}`. **Owner: task 40**, which removes the last importing spike (`doorbell-aws/`) and
  with it the rest. `scripts/port.ts` keeps its default output path for upstream syncs.
- **(i) D2 stays "per job", on Pub/Sub data only.** The local transport's fan-out was measured (10,000 jobs, 1 / 4 / 16 listeners: 1,064-1,586,
  2,270-2,435 and 1,518-1,973 jobs/s): every bell reaches every listener, so it stays a development and small-fleet transport.
- **Carried, not new:** a finished job's custom id is replaced by an `enqueue` in another queue (task 18's gap). Decide before 1.0.

## D1 and D2

**D1, worker hosting: always-on pull workers (the default stands).** Seconds-level delay, retry and rate-limit
precision exist only with always-on workers (the in-process tick). A scale-to-zero push handler gets the 1-minute
tick, or a Cloud Tasks relay, which is documented (30-day schedule, 500 tasks per second per queue, $0.40 per million
operations after 1 million free) and was not prototyped. Push handlers also multiply connection pools by instance
count, which the formula makes visible. A push handler is a thin add-on after v1.0.0.

**D2, doorbell granularity: per job.** Closed on Pub/Sub data. Per-queue doorbells drained a 10k backlog 1.5-1.75x
faster on the emulator and were no faster under steady load (p50 30-37 ms), and letting a per-job doorbell claim
several jobs gained nothing. Per-job keeps the subscription backlog equal to the unclaimed jobs, which is what an
autoscaler reads. **SQS was not measured**: ElasticMQ throughput says nothing about SQS. It stays per job pending a
load test on real SQS (task 41, needs D9).

## What changed in the design

Each item is applied to DESIGN.md in the same change as this document.

| # | Change | Where |
| --- | --- | --- |
| 1 | D5 is decided: Postgres authoritative, doorbell, port. | section 1 |
| 2 | Invariant 2 names the lease token and unexpired lease as the fence. `version` guards writers without a lease. | section 3 |
| 3 | Invariant 3 is stated as a bound: `reRingAfterMs` plus a tick interval for a claimable job, lease plus two ticks for a crashed worker's. | section 3 |
| 4 | Only the tick recovers a crashed worker's job. A later doorbell does not. | section 3 |
| 5 | The tick contract: age threshold, per-queue cap, grace, window, in-process tick. | section 3 |
| 6 | The Cloud Tasks relay is dropped from v1.0.0. | sections 3, 4, 5, 9 |
| 7 | `DeliveryTransport` and `StateStore` replace the sketches. | section 5 |
| 8 | The Cloud SQL connector is a tunnel, not a pooler. Connection budget, pooler recipe, TLS and driver rules. | section 7 |
| 9 | The doorbell DLQ is a metric, and the rate-limit, retry and recovery paths run at tick speed without the in-process tick. | sections 3, 10 |

## Re-plan

Tasks 10-22 keep their order and dependencies. No task is added or removed. What changed is recorded at the top of
CURRENT.md and as a "Gate decisions" section in each affected task:

| Task | Change |
| --- | --- |
| 10 | The settled `DeliveryTransport` and `StateStore` above; `RingItem`, `Delivery`, `Clock`; typed `OperationDeadlineError`. |
| 11 | Event journal kept; connection factory takes the deadline wrapper, budget validation, TLS and pooler rules; `rung_at` semantics; clock seam. |
| 12 | `enqueue` returns rings with `dueInMs`; `markRung` per bell; grace for an unrung job. Grouped-job admission: decide `nextval` or `group_sequence`. |
| 13 | Step 2 is wrong: claim does not increment `attempts`. `sessionLimits` is kept. |
| 14 | Retry and recovery clear `rung_at`; recovery is the tick's. |
| 15 | `dueForRing` takes a per-queue cap and a grace; promotion and ring window clamped to the transport. |
| 16 | Direct `listenUrl`; poll fallback is required, not optional. |
| 17 | Per-queue filtered subscription; no relay; ack after the claim; DLQ is a metric; Bun and gRPC risk first. |
| 19 | Deadline-wrapped store calls; `close({ timeout })`; the worker keeps its own slot semaphore. |
| 20 | In-process tick uses a lease row, not an advisory lock; per-queue cap and grace; budget loop. |
| 21 | Connection ceiling in the plan (`max instances x pool`); TLS; pooler option. |
| 22 | Spike directories must be gone; real-run gaps listed in `docs/limits.md`. |
| 40, 41 | SQS transport follows the spike's `transport.ts` with the gate's changes; D2 on real SQS; emulator gaps. |

## Spike code disposal

Promotion happens under the task that owns each module. The owning tasks exist, their packages are skeletons, and a
module promoted without its task's tests and review would be code nobody has read. So disposal is by owner:

| Spike code | Goes to | Task | Removed when |
| --- | --- | --- | --- |
| `spike/ported/` | `packages/store-postgres/src/` per the module plan | 11-15 | **done in task 40**: the directory, `harness.ts`, `claimOnce.test.ts`, `leaseRecovery.test.ts` and `crashingClaimer.ts` were deleted with `spike/` (93 files); `docs/PORTING.md` lost its 69 spike rows |
| `spike/tools/port.ts` | kept for upstream syncs, moved to `scripts/port.ts` | 11 | done in task 11 |
| `spike/tools/measure.ts` | deleted: its output is in spike 01 and `docs/PORTING.md` | 06 | now |
| `spike/db-access/budget.ts`, `resilient.ts`, `pooler.ts` recipe, `tcpProxy.ts` | store connection factory; `test/support/` | 11 | done in task 11 (`src/connection/`, `test/support/`) |
| `spike/db-access/tick.ts` (lease row) | `packages/maintenance` (`TickLoop`, `store.maintenance` lease) | 20 | done in task 20 |
| `spike/db-access/*.test.ts` | kept as a compatibility suite if CI can run the `pgbouncer` and `tls` profiles, otherwise deleted | 11, 20 | task 11: `failure`, `tls` and `pooling` became `test/connection.*.test.ts`. Task 20 deleted the directory: the `tick` spike became `packages/maintenance/test/` (election, concurrency, lateness, chaos, `pooled`); the `claimPath` spike (the *ported* claim path behind a pooler) became a pooled claim on the real store in `connection.pooled.test.ts`; the `fleet` spike (up to 50 processes against the connection cap, about 40 s) is gone: the budget arithmetic stays in `connection.budget`, and the measured fleet stays in spike 05's write-up. PgBouncer's config and the TLS export moved to `test/support/pgbouncer/` |
| `spike/doorbell/` | `packages/transport-gcp`; its scenarios became task 17's tests | 17, 20, 40 | **done in task 40**: `store.ts`, `invariants.ts` and `invariants.test.ts` became `test/support/doorbell/{ledger,ringing,lines,util}.ts` (with `ledger.test.ts`), which the Pub/Sub and SQS fault suites share |
| `spike/doorbell-aws/` | `packages/transport-aws`; `faults.ts` and the scenario list feed task 41 | 40, 41 | **done in task 40**: `transport-aws` (src, 12 test files, contract suite `test/contract/sqs.test.ts`), `scripts/sqs-fidelity.ts` (the old `tools/sqsFidelity.ts`) and `test/support/elasticmq.conf`. Task 41 takes the scenario list from `packages/transport-aws/test/` |
| `test/model/` | stays: it is the harness | none | not applicable |

The root `@google-cloud/pubsub` (6.1.0) and `@aws-sdk/client-sqs` (3.1140.0) dev dependencies move with their
transports. The `pgbouncer`, `tls`, `sqs` and `pubsub` compose profiles stay, and the `pubsub` profile is untested.
Each write-up in `docs/spikes/` stays. `docs/PORTING.md` is current: its rows move with the files.

## Not proven and needs D9

None of this was run. Each item is either needed before Phase 1 sign-off or recorded as a Phase 1 risk.

- **Cloud SQL and RDS:** TLS with hostname verification (Cloud SQL's CN-only certificate), IAM authentication, HA
  failover timing (reset or stall), managed pooling (Enterprise Plus only), RDS Proxy pinning including `nextval`
  and `prepare: false`, and a measured fleet on a real instance.
- **Pub/Sub:** exponential retry backoff, dead-lettering under real IAM, throughput, streaming pull across Cloud Run
  restarts, and the official client under Bun against the real service (the spike ran it against the emulator).
- **SQS:** stale-handle deletes, broker-side duplicates, attribute-count lag, a real `Failed[]`, receive counts and
  short polling, request cost at the per-job rate, and the D2 granularity load test (per job against per queue; task 41 left it
  "not measured" in `docs/transports.md`).
- **Delay:** Cloud Tasks precision and cost, and Cloud Scheduler jitter.

## What the gate needs from you

Step 9 of the task is your explicit go-ahead to start Phase 1. The three conditions above are the thing to
decide on. If you would rather close condition 1 before Phase 1 than inside tasks 11-14, the work is a Postgres
target for `test/model/` with the clock seam, run against the spike's ported code. It would be a separate task
ahead of 10, and it delays the start of Phase 1 by that much.

## Amendments

### 2026-10-14: go-ahead

The user said "Let's continue through the v1.0.0 remaining tasks" and Phase 1 started. The questions above were not
answered, so the plan as written stands: condition 1 is closed inside tasks 11-14, spike code is disposed of by owner,
and the D9 items are Phase 1 risks until a real project exists.

### 2026-10-14: task 10 wrote the interfaces down

The settled sketch is unchanged. Task 10 fixed the details the sketch left open, in `packages/core/src/`:

- `EnqueuedJob` carries `ring: Ring | null`, where `Ring { bell, dueInMs }`.
- `NewJob` is `{ queue, data, name?, options? }`, and `JobOptions` uses upstream's option names (`deduplication`,
  `group`, `stallTimeout`).
- `TickBudget { maxDurationMs, maxRingsPerQueue, maxItems }` and `TickReport { recovered, promoted, cronFired, expired,
  rings, moreWork }`. The gate fixed only "`tick(budget)` returns `moreWork`".
- `StateStore.close({ timeout })`; `subscribe` returns a named `Subscription { refresh, close }`.
- `Random` and `IdGenerator` sit next to `Clock` as injectable seams.
- The transition table moved from `test/model/model.ts` into core; the harness reads it from there.

### 2026-10-14: task 16 refined the local transport's delayed-bell rule

The gate said a delayed job is not announced by `NOTIFY` and the poll finds it. The Postgres transport announces a delayed bell
with its delay, and every listener holds it until due, because the contract suite's delayed-bell case needs a bell that is
delivered, and not early, with no job row behind it. The poll still finds the job, and the delay precision is still the poll
interval. See "The local transport: NOTIFY, a poll loop and a heartbeat (task 16)", item (a).

### 2026-10-14: task 17 left five files of the doorbell spike in place

Task 17's acceptance says `spike/doorbell/` no longer exists. The scenarios, the worker and the Pub/Sub helpers it replaced are
deleted, but `store.ts`, `ring.ts`, `sweep.ts`, `invariants.ts` and `invariants.test.ts` are imported by the spikes tasks 20 and 40
own, so they stay until those are removed. See "The Pub/Sub transport (task 17)", item (j).

### 2026-10-14: task 18 found a store gap in custom ids across queues

A finished job's custom id is replaced by `enqueue` whichever queue the new job is in, so one queue can delete another queue's finished
job. The SDK refuses a custom id that a *live* job of another queue holds and scopes every read and change to its own queue, but cannot
see a finished job it is about to replace. See "The Queue SDK and the store's control facet (task 18)", item (a). Not fixed in task 18.

### 2026-10-14: task 19 found a doorbell race and a DESIGN.md line that is wrong

A bell delivered at once can find its job locked by the `markRung` that followed its own ring, and the claim skips the row, so the job
waits for the tick. The worker rechecks once after 25 ms; the tick stays the bound. Separately, DESIGN.md's connection budget says each
`QueueEvents` listener adds a direct connection that bypasses the pooler; the reader polls with one pooled statement instead, so the line
is wrong and is amended when DESIGN.md is next edited. See "The Worker and QueueEvents (task 19)", items (a) and (e).

### 2026-10-14: task 20 widened task 19's recheck and removed the db-access spike

Not a design deviation: invariant 3 and the tick contract stand, and the numbers meet them. Two things changed around the contract.
First, the lateness measurement showed task 19's one-time recheck (a bell whose *own* job is still waiting) is too narrow for fungible
bells, so a job could wait for the tick's re-ring while its `markRung` row lock was held. The worker now rechecks once whenever the
queue has a job waiting; the rule in "The Worker and QueueEvents (task 19)", item (a), is amended and the store-side mitigation
that task left open is decided against. Second, `spike/db-access/` is deleted (its tick is `packages/maintenance`), along with
`spike/doorbell/ring.ts` and `sweep.ts`. The `claimPath` and `fleet` spike suites have no direct successor beyond the pooled claim on
the real store (`connection.pooled.test.ts`), which has not been run against PgBouncer yet. See "The tick as built (task 20)".

### 2026-10-14: task 21 wrote the GCP infrastructure and applied none of it

Not a design deviation. One departure from the task text: no Cloud SQL IAM role is granted, because the connection is direct and does
not use one (see "The GCP infrastructure as built (task 21)", item (b)). Everything real-cloud is on the D9 list; `terraform apply` was
not run, and nothing was created in any project.

### 2026-10-14: task 22 closed Phase 1 locally, found two quadratic retention statements, and left three design findings open

The core runs end to end on the local stacks; the GCP run is not made (D9) and your step-8 review of this gate was not obtained
separately (work continued under the standing instruction). Two statements of the tick's retention were quadratic and are fixed in the
store with failing tests first. Three findings are *not* changed and are yours to decide: the tick re-rings a deep healthy backlog every
interval, an exact rate limit serializes claims on one row, and the journal and the metrics rows serialize commits per namespace and per
queue. DESIGN.md's `QueueEvents` line (task 19) is amended. See "The Phase 1 gate (task 22)", items (a) to (i), and `docs/limits.md`.

### 2026-10-15: task 40 built the SQS transport on the emulator, removed the spike directory, and made `aws-sqs` selectable

Not a design deviation: the interface of task 10 held unchanged for SQS (`attemptCount: 'approximate'`, no `ordering`, `maxDeliverDelayMs`
900,000, `maxRingBatch` 10, `retryGranularityMs` 1,000). Every result is an **emulator** result (ElasticMQ 1.7.1, the JVM jar run locally; the
compose native image is for the end of the plan); no real AWS account was used (D9). What it found:

- **The doorbell scenarios of spike 04 all run as tests** against `PostgresStore` and `SqsTransport`: publish lost, half a batch taken, a bell
  delivered twice, paused and rate-limited queues, SIGKILLed and stalled workers, heartbeat loss, the delay window (rounded up, refused past
  900 s, never clamped), a database outage, bell A never reaching subscriber B, and the dead-letter queue as a metric.
- **A bell that beats its own `markRung`** (the claim finds the row locked): the worker's one recheck after 25 ms (task 20) answers it and
  holds on SQS. 6 of 50 bells needed it on ElasticMQ. Not a new open decision; a consumer that does not recheck waits for the tick.
- **Request cost** (D2 stays "per job"): 1.94 to 1.99 requests per job at concurrency 10, 2.13 at concurrency 1, so about $0.84 per million
  jobs at the list price (not verified against the live page). See `docs/limits.md` section 11. Idle long polls are about $0.05 a month per
  subscribed queue per worker process.
- **The emulator differs from SQS** in stale-handle deletes, redrive timing, attribute-count lag, duplicates, short receives, and CloudWatch
  (`docs/limits.md` section 9). `scripts/sqs-fidelity.ts --real --region <r>` is the probe set for the first real-account run.
- **Two defects found by the tests and fixed in the transport**: the receiver subtracted running handlers from `capacity()` twice, and `stats`
  reported a queue twice. Neither reached a release.
- **New environment variables:** `QCLOUD_AWS_REGION` (required with `aws-sqs`, never taken from the machine) and `QCLOUD_AWS_SQS_ENDPOINT`.
  `qcloud-tick` and the Control API both select the transport; the example takes it too. Terraform (task 42) must create queues with the names,
  tags and settings of `ensureQueue` (`packages/transport-aws/src/provision.ts`).
- **Spike disposal is complete** (`packages/store-postgres/spike/` is gone); `scripts/port.ts` now requires `--out`.


### 2026-10-15: task 41 ran one contract suite and one scenario set on all three transports, and found a worker that acknowledged malformed bells

Not a design deviation: no capability flag was added and no transport was special-cased. Every result is an **emulator** result (the local
transports on PostgreSQL 18.6, the Pub/Sub emulator, ElasticMQ 1.7.1); no real cloud was touched (D9). What it found:

- **A real divergence, fixed in the SDK.** The end-to-end scenario "a malformed bell ends in the dead-letter queue, is counted, and the jobs
  behind it still run" showed that the worker **acknowledged** a delivery whose body was not a bell (`Delivery.bell === null`). An ack deletes
  the body, so no broker's dead-letter queue ever saw it and nothing counted it: the gate's rule "a malformed bell reaches the doorbell DLQ and
  is counted" held for the transports (the contract suite passed) and failed for the system. The worker now **nacks** such a delivery
  (`MALFORMED_BELL_RETRY_MS`, 1,000 ms) and counts `qcloud.worker.malformed_bell`, so a broker with a dead-letter queue keeps the body there after
  its redelivery limit. A test written first (`packages/sdk/test/worker.malformed.test.ts`) failed on the old behaviour. The `Delivery.bell`
  comment in `packages/core/src/transport.ts` says so. On the memory and Postgres transports, which have no dead-letter queue, a malformed body
  cannot be made, and the scenario is skipped with that reason in code and in the matrix.
- **The boundary is now enforced.** `packages/transports` is the one place that maps a configured name to a transport; `core`, `sdk`,
  `store-postgres`, `maintenance` and `control-api` source name no broker, and `bun run architecture` and `test/architecture/transportBoundary.test.ts`
  fail if one does. `qcloud-tick` and the Control API open their transport through it (their `ControlApiConfigError` and `Settings` types are
  unchanged for callers).
- **The matrix cannot drift from the code.** `docs/transports.md` is generated from the capability declarations and the skip reasons
  (`bun run docs:transports`); `test/contract/matrix.test.ts` fails when it is stale or when its delay-precision figures differ from
  `docs/limits.md` section 1. Every row carries an evidence label (declared, emulator, tested, design, not run).
- **D2 stays "per job" and "not measured" on SQS.** The granularity load test needs a real account (D9); `scripts/test-transport.ts` refuses
  the real names without `QCLOUD_REAL_CLOUD=1` and, with it, says no real-cloud stack exists until task 43.
- **A Pub/Sub client could leave gRPC and use real credentials.** The first full `bun test` with the emulator up failed 31 Pub/Sub tests: the
  panel's tests register a `window` with a `fetch` in the one test process, `google-gax` then picked its browser transport, and that transport
  asked Google's OAuth endpoint for a token with the machine's Application Default Credentials (the exchange was refused, so nothing was
  reached). In production there is no `window`, so nothing changed there, but a suite meant for the emulator must not depend on that.
  `PubSubTransport` now builds its own client with `GRPC_ONLY` (`fallback: false`), the test clients do too, and
  `packages/transport-gcp/test/noBrowserFallback.test.ts` failed first and passes now. Not run against real Pub/Sub (D9).
- **Not verified:** the CI `transports` job, the nightly workflow and the compose `pubsub` profile were written and YAML-parsed but never run
  (no Docker, no runner). The Pub/Sub emulator suites ran on the host through `gcloud beta emulators pubsub start`.


### 2026-10-15: task 42 wrote the AWS infrastructure and found where the design is GCP-shaped

Not a deviation from a settled interface, but several things in the plan did not carry over to AWS unchanged, and one open question
(RDS Proxy) stays open. Everything below is a **plan** result: `terraform plan` ran with placeholder credentials and never contacted AWS, and
nothing was applied (D9). 685 plan assertions in `bun run check:terraform` cover the example (`infra/aws/README.md`, "Checks that run without a cloud").

- **The tick's `serve` mode cannot be the AWS tick.** `qcloud-tick serve` verifies a Google OIDC token, so EventBridge Scheduler cannot call it.
  On AWS the schedule starts a Fargate task that runs `qcloud-tick run` (one invocation, bounded by `QCLOUD_TICK_MAX_RUN_MS`, one JSON report
  line, exit 0/1/2). Overlap is safe (the lease row) and is counted in the connection budget. A signed-header endpoint (an API destination) was
  the other option in the task; it would need a second authentication scheme in the tick and was not built.
- **The connection budget counts four control processes on AWS, not three**: two ticks that can overlap (a task takes seconds to start, so a
  slow minute overlaps the next) and two Control API instances. The shared module (`infra/modules/budget`, moved out of `infra/gcp`) takes the
  count as an input; the figures in the AWS README are two connections higher than the GCP ones. The TypeScript `budget()` and the module agree
  at 10, 50 and 200 workers (checked).
- **The RDS CA bundle has to be in the image.** Fargate injects secrets as environment variables and cannot mount one as a file, while
  `QCLOUD_DATABASE_TLS_CA_FILE` names a file. No Dockerfile in the repository carries the bundle. Until one does, `database_tls = "unverified"`
  is the only way to run, and that encrypts without verifying the server. **Open: bake the RDS global bundle (and the Amazon roots, for a proxy)
  into the Control API image and the worker example image.**
- **RDS Proxy is off by default, as spike 05 said.** Its pinning list includes `nextval`, which grouped-job admission calls, so how much pooling
  survives is unmeasured. Enabling it sets `QCLOUD_DATABASE_POOLER=transaction` and gives workers a direct `QCLOUD_DATABASE_LISTEN_URL`; the
  budget then counts the proxy's share of `max_connections`. The choice stays "measure first" and needs a real instance (D9).
- **Interface endpoints do not lower the cost floor at small scale.** The task asks for endpoints that avoid NAT charges. At list prices as
  remembered (unverified), two interface endpoints in two zones cost about as much as one NAT gateway, so they trade a per-GB charge for an
  hourly one and pay off only with real traffic. The README says so rather than promising a saving. `egress = "none"` removes the NAT gateway
  and needs five endpoints plus the S3 gateway; the plan refuses it with fewer.
- **Queue policies are stricter than `ensureQueue`'s queues, and untested against SQS.** Each queue denies the four message actions to every
  principal except the two task roles and `additional_principal_arns`, and denies plaintext. Whether the deny interacts with SQS's own redrive,
  with a dead-letter queue under a customer-managed key, and whether `aws:PrincipalArn` of an assumed role is the role ARN as assumed here, are
  **unverified**. If the deny turns out to break redrive, the deny statement is the thing to loosen, not the queue settings.
- **Workers get no `ReceiveMessage` on a dead-letter queue.** A dead-lettered bell is a metric. Peeking at one belongs to the Control API
  (task 43), which is added through `additional_principal_arns`.
- **Not done:** secret rotation (the manual procedure is written down and never exercised), a bastion or other operator access to the private
  database, a migration job on AWS (task 43), `tflint` or any policy scanner (none installed; the plan assertions are the policy scan), and
  Performance Insights (a variable, off, because not every burstable class supports it).
- **The CI `terraform` job now plans both clouds**; the change is unverified on GitHub (no runner). The offline plan sets `offline_plan = true`,
  which makes the provider skip every call; it must never be used for an apply.

### 2026-10-15: task 43 planned the control plane on AWS, closed the CA-bundle gap, and found the data plane must name the API's role first

Nothing was applied (D9). The Terraform root validates and plans offline; the smoke test ran against a local ElasticMQ. No decision of the
design was found wrong; these are the places where AWS asked for something GCP did not.

- **The RDS CA bundle gap of task 42 is closed without a new image layer.** `QCLOUD_DATABASE_TLS_CA` takes the PEM text itself, so Fargate can
  pass it as a plain environment value. The data plane's `database_tls` now defaults to `ca-pem` and needs `database_ca_pem` (the region's
  bundle, at most 16,000 characters, which keeps the task definition under its 64 KiB). Behind an RDS Proxy the value must also hold the
  Amazon root CAs. Exactly one of `QCLOUD_DATABASE_TLS`, `_TLS_CA_FILE` and `_TLS_CA` may be set. **Unverified against a real RDS.**
- **The data plane has to name the API's role before the queues are applied.** The queue policies deny every principal but the two data-plane
  roles and `additional_principal_arns`, and the Control API's role is made by the control plane, which is applied second. The deny names the
  role by ARN (`<name>-api-task`), which holds before the role exists, so the order works. The cost is a coupling by name: a misspelled ARN
  starts a healthy-looking API whose every queue call is denied. A `check` in the control plane asserts the role's name; the Transport page
  shows the error. This is the AWS shape of the GCP data plane's bindings on resources.
- **No tick endpoint check is needed on AWS.** The schedule starts a one-shot task; there is no listener. The task text (a signed request or a
  shared secret) applied to a design that was dropped in task 42. `qcloud-tick serve` stays Google-only.
- **ALB-OIDC is not offered.** It would authenticate the browser at the load balancer but not a bearer-token caller of the API, so the
  application's token check would stay. Public HTTPS with application sign-in is the one implemented mode, with `private` as the alternative,
  as on GCP.
- **The API cannot autoscale.** Its tasks are counted in the connection budget (`api_instances + 2 <= control_processes`, default 4), so a
  fixed count is the honest shape. A burst of console users is served by more CPU per task, not more tasks.
  *Superseded by the scale review (2026-10-24): `api_max_instances` autoscales the API on CPU, and the budget counts the maximum.*
- **`/transport` gained `inFlight`, `delayed` and `approximateCounts`, and the Transport page labels approximate counts.** SQS says its counts
  are approximate and gives both figures; Pub/Sub gives `delayed` as 0 and no in-flight count, and the page shows a column only when some
  queue has a value. This is an additive contract change (`docs/openapi.yaml`);
  `describeTransport` is still the only place a broker's name appears.
- **The smoke steps are one module for both clouds** (`scripts/smoke-steps.ts`), so a check cannot exist for one cloud and drift from the
  other. The cloud-specific parts are two hooks.
- **Control-plane tasks share the data plane's `tasks` security group**, which gains one inbound rule (8080 from the ALB's group). That is a
  change to a group the data plane owns; it is declared in the control plane and removed with it.
- **Still open:** the first apply; a measured ALB-through stream at 600 s; `readonlyRootFilesystem`, WAF and a release role; the cost floor
  (about $75 a month for this root plus a NAT gateway) is list-price arithmetic.

### 2026-10-15: task 50 put flows on the dependency tables, kept the edges, and found three questions the design had left open

The design says flows run on Postgres dependency tables and a parent is promoted by task 14's hook. It holds. Building it settled the following,
and none of it contradicts a Phase 0 finding.

- **A parent is ready when no edge lacks a completion record, and the parent row is the lock.** The edges stay after a child completes and
  readiness is read from the completion records, as upstream's `postgresDependenciesSatisfied` does. Upstream serialises concurrent
  completions with an advisory lock per dependency id; here the parent row is locked `FOR UPDATE` first (lock order is child, parent,
  grandparent; flows are trees, so there is no cycle) and the evidence is read afterwards under read committed, so the second of two
  concurrent completers sees the first's commit and exactly one of them releases the parent. A test completes the last two children together
  1,000 times and the parent is released once each time. The cost: the edges of a finished parent are history, and the completion sweep and
  retention can remove what they point to.
- **The design did not say what a child's failure does after its parent was released.** `continue` releases the parent while its other children
  are still running, so those children can fail later. Decision: a late `continue` or `ignore` failure is still recorded and drops its edge, so
  the parent reads it; a late `remove` drops its edge; a late `fail` does nothing, because the parent has already run or is running. This is
  written down in `docs/compat.md` and covered by `flow.late` and two model rules.
- **The policy lives on the edge, not on the job.** Migration 6 adds `on_failure` (nullable, `fail`, `continue`, `ignore` or `remove`) to
  `qcloud_dependencies`. It is additive and safe with old workers, which write no flows. The four flags are stripped from `job.opts`, so the
  edge is the only record of them.
- **A child that fails with no policy blocks its parent until an operator cancels the parent.** Upstream let a failed child sit and the
  parent wait, and so does this. DLQ retry is closed (task 14 (k)), so there is no way to bring the child back. This is the consistent
  outcome, not a good one: a "drop this edge" or "release this parent" operator action is a v1.1 candidate that depends on the retry decision.
  A child that sets `removeOnFail` must set a policy, or the parent would wait for a job that deleted itself.
- **Operator actions are defined, and each leaves the tables consistent.** Cancelling a child releases its edge (the tick rings the released
  parent, not the cancel). Cancelling or removing a parent deletes its edges and recorded failures and leaves its children running as plain
  jobs, with a stale `parent_id`. Remove, clean, drain, obliterate and DLQ purge or eviction stay guarded by the live-consumer rule for any job
  with an edge from a parent that is waiting, delayed, waiting on children or active.
- **A flow is held to 1,000 jobs, not upstream's 10,000.** It is one transaction that takes one advisory lock per job, so it is held to one
  enqueue batch. The limit is checked before anything is written. Raising it needs a measured lock-count ceiling.
- **`addBulk` is not atomic across flows.** Every flow is validated before the first is written (`planFlow`), so a malformed one adds nothing;
  a taken custom id or a database error after that leaves the earlier flows added. Replay is safe when the roots have custom ids.
- **A bare array parameter to `Bun.SQL`'s `sql.unsafe` fails.** It was found in the inspector's tree query and fixed by binding `sql.array`.
  Any other `unsafe` call that passes an array is suspect; the grep found none.
- **A latent null-parent climb in `resolveFlows` was fixed.** The loop that climbs from a failed parent to its own parent filtered nothing, so
  a failed root was looked up as a child. It now carries only the changes that have a parent, and a test covers it.
- **Doorbells.** An add rings only the claimable children, a parent is rung by the transaction that releases it, and the tick re-rings only
  claimable states, so a `waiting-children` parent never gets a bell. The flow scenarios (4 on each of memory, postgres, Pub/Sub and SQS, with
  duplicate bells injected) pass.
- **The flow model is its own harness** (`test/model/flow/`): a reference model derived from the flow spec, nine checks against the real store,
  14 rules whose coverage the standard run asserts, and four planted bugs it finds with minimised, replayable histories. It found no store
  bug: the store matched the model at the standard count (200 runs of up to 60 commands) and at 1,000 runs of up to 100 commands. It does not
  generate delays, `removeOnComplete`, DLQ retry or purge; `flow.operator` and `flow.policies` cover those. Reaching the late-failure rules takes
  a specific order of failures, so the generator has shapes that make it likely, and the coverage assertion fails if a change to it loses them.
- **Control API:** `FlowError` maps to 400 `flow_invalid`. No endpoint serves it yet; the flow endpoints are task 51.
- **Still open:** the 1,000-job ceiling is not measured against lock counts; a flow bigger than one transaction would need a different design;
  EXPLAIN and the schema snapshot for migration 6 and the three flow query paths were generated on PG 18 and are to be redone on PG 16.

### 2026-10-15: task 51 put flows in the Control API and the panel, and settled what an operator may do to a stuck flow

The design says the panel reads what the Control API serves and that an operator's change is fenced and audited. It holds. Building the flow
endpoints answered the question task 50 left open (what an operator can do about a parent held by a failed child) and moved three
decisions the design had not made. None contradicts a Phase 0 finding.

- **Migration 7 records which flow a job is in.** `flow_root` (the root's id; the root names itself) and `flow_depth` are nullable columns
  on `qcloud_jobs`, written only by `addFlow`, with two partial indexes: `qcloud_jobs_flow_idx (namespace, flow_root, flow_depth, id)` for
  one flow and `qcloud_jobs_flow_roots_idx (namespace, created_at DESC, id DESC) WHERE flow_depth = 0` for the list. Reading one flow, or the
  flows, is a bounded index scan and never a walk up and down `parent_id`. It is additive and safe with old workers: no earlier release
  writes a flow. The DDL snapshot and the plans of the new query paths were generated on PG 18 (below).
- **Flow-scoped retry is allowed; generic retry stays closed.** The design closes retry of a failed job (task 14 (k): `job-retry` and
  `dlq-retry` answer 501). A failed child that holds a parent is different: it is a link a parent waits on, and nothing else can move
  the parent. `retry-failed` puts it back as a fresh job (no attempts used, no error, no DLQ entry) so the parent is released when it
  completes. The rule that keeps it narrow: the child must be `failed`, its parent must still be `waiting-children`, its edge must have no
  policy, and it must not be a parent that never ran. One job that does not meet it refuses the whole request (`flow_not_retryable`).
  A parent that failed because a child failed under `fail` had its edges dropped, so running it again would run its processor with no
  children done; the operator promotes its own parent or removes the flow.
- **`promote` releases a stuck parent, and it does not guess.** A parent is stuck when every child it still waits for has failed with no
  policy. The action treats each of those failures as `ignore` (kept for `getIgnoredChildrenFailures()`, edge dropped) and releases the
  parent. It refuses (`flow_not_stuck`, `details.reason`) while any child is waiting, delayed, active or not yet written
  (`children_unfinished`), when the parent is not `waiting-children` (`not_waiting`), and when nothing holds it (`nothing_blocks`). The
  request must name every failed child that holds the parent, so the parent is not released on a picture that missed one.
- **`remove` takes the whole flow or none of it.** One transaction removes every job, edge, kept failure, log and the completion records of
  the children; a running job refuses it whole (`flow_active`), as does a flow over 1,000 jobs (`flow_too_large`). It needs the root id
  typed back (`confirm`) and the `operator` role.
- **Every action is fenced by versions the caller read.** The request names each job it touches with its `expectedVersion`; a version
  that moved is 409 `version_conflict`, and a job the flow has that the request did not name is `flow_changed` (`unseen`). A flow that grew
  or changed since it was shown is never acted on from the old picture. Each refusal has its own code: `flow_changed`, `flow_active`,
  `flow_not_retryable`, `flow_not_stuck`, `flow_too_large`, with `flow_not_found` for an unknown root. The store's `id_taken` outcome was
  dropped as unreachable. Each call is one audit row (`POST /flows/:id/actions`, target `id=<root> flowAction=<name>`), written by the
  Control API's existing audit hook for write routes.
- **The view is not one snapshot.** `GET /flows/:id` runs a few bounded statements (the jobs top level first with a `LIMIT`, their edges,
  the children removed on completion, the kept failures, a capped count), not one read of a frozen state. A job can move between two of
  them. This is why the action is fenced rather than trusted to the view.
- **A view is capped, and says so.** At most 1,000 jobs by default and 5,000 at most, whole levels from the root down; `truncated` says
  the flow has more and `total` counts up to 50,000. A child removed on completion is a synthetic node (`version: null`, `removed: true`)
  that is not in `total` or in the state counts. The panel disables Remove on a truncated view, because the request could not name every
  job.
- **A new flow detaches the orphans of an old one.** A cancelled or removed parent leaves its children as plain jobs that still name it.
  When a new flow takes that parent's id, `addFlow` clears their `parent_id` and `flow_root` and moves their `version`, so a reused id
  never shows a stranger's children. This closes the stale-`parent_id` caveat task 50 recorded for `getFlow` after a reuse.
- **Job reads carry the flow.** A job has `parentId` and `flowRoot` in every read and `childrenIds` on a single-job read only (a listing
  would pay one query per row); `/jobs/:id/children` now returns real values. `dependsOn` is always `[]`, because the Control API does not
  model that edge. `features.flows` is true when the jobs routes are served, because the flow routes read the same store.
- **The panel is a Control API client and nothing else.** The agent's create form, per-job methods panel, DAG canvas and recents are
  gone, and the `recentFlows` storage key with them; flows are found from `GET /flows` or from a job (`/flows?root=<any job id>` finds the
  root). The tree is windowed, so 5,000 jobs draw a few dozen lines. Remove asks for the root id typed back and Release asks for a second click; both are absent for a
  viewer, whom the server refuses (403) if one is forced.
- **A bug found by the page tests and fixed:** every selection of a job read the flow again, because react-router's `setSearchParams`
  changes identity with the address and sat in the load effect's dependencies. It is read through a ref now, and a test counts the reads.
- **Found while running the e2e, and fixed in the spec:** `operations.e2e.ts` ("enqueues from Add Job…") failed twice on WebKit and
  passed when run alone. The failure's page snapshot reads "1–15 of 27 queues", page 1 of 2: the control Queues page lists 15 queues
  at a time by name, the e2e store is shared by every spec of both browsers (one worker, Chromium first), and the eight `flow-*`
  queues this task added pushed `operations-webkit-0` onto page 2. The page is right; the spec now types the queue name into the page's
  filter (which covers the whole list) before it looks for the link. The fixed run passed 54 of 54.
- **Still open:** EXPLAIN and the schema snapshot for migration 7 and the flow read paths were generated on PG 18, where the completions
  delete can use a skip scan (`schema.indexes.test.ts` accepts that plan as an alternative); redo them on PG 16 with the Docker-backed
  gate. The 1,000-job flow ceiling is still not measured against lock counts. The view is not a snapshot, by design.

### 2026-10-15: task 52 put webhooks on the tick and Postgres, and found that the SSRF defence cannot be a check at registration

The design says outbound webhooks ride the machinery that already exists: Postgres holds the state, the tick does the work, and nothing new
is a moving part. It holds. Deliveries are rows made in the job's own transaction, claimed with `SKIP LOCKED` and sent by a tick step, and
the cost on the job path was measured (below). No Phase 0 finding is contradicted. Building it settled what the task left open and found
one way the obvious approach is unsafe.

- **The SSRF defence is at send time, and `fetch` cannot be the client.** A URL that validates when it is registered can point somewhere
  else when it is used (a name is re-pointed, a redirect leads inside). So the sender validates again, resolves the name once, refuses
  unless every answer is public, and connects to that address. `fetch` resolves the name itself and follows redirects, so it cannot be
  held to the checked address; the request is a small HTTP/1.1 client over a socket with TLS checked against the name the operator wrote
  (`webhookHttp.ts`). Registration validates the string and never resolves the name, so a name that points inward is accepted and every
  attempt then fails with `destination not allowed`. **This is the author's matrix: an independent review stays owed in task 72, and a
  real VPC's egress is untested (D9).**
- **The sender is a tick step at operator scale.** One pass sends at most 50 deliveries, 8 at a time, 60 attempts a minute per webhook,
  and stops starting work after 5 s. A scheduler-only deployment (one tick a minute) therefore sends up to 50 attempts a minute for the
  whole service. A sustained event rate above that grows the backlog until the 24-hour expiry fails what is left. The task's own note
  stands: fan-out and volume belong in a separate delivery queue run by the SDK, not in the tick, and the step was not grown to cover
  them.
- **Delivery is at least once, with no ordering.** An outcome that arrives after its lease lapsed is dropped, so a send can repeat; an
  attempt that was claimed and never answered counts against the budget. The receiver deduplicates on `X-Webhook-Id`. The body carries no
  job data: the receiver reads the job through its own credentials.
- **The retry budget is 63.5 minutes, not hours.** Eight attempts, waits of 30 s, 1 m, 2 m, 4 m, 8 m, 16 m and 32 m; a delivery that has
  not succeeded 24 hours after it was due expires. A manual retry gives a fresh budget and attempt numbers keep rising. A comment and a
  test title had said "about four hours"; both were wrong and are corrected.
- **The trigger is cheap on the job path.** With three webhooks watching a queue (nine delivery rows per job), 8 claimers and 2,000 jobs
  on PG 18.6: about 1.1x on claim and complete and 1.6x to 1.8x on enqueue (two runs). A queue no webhook watches inserts nothing. PG 16 is owed.
- **A webhook watches one queue or all of them.** The task asked for a queues filter; it is a single column, so two queues are two
  webhooks. Unsigned webhooks are allowed and flagged. A signed webhook whose secret cannot be opened is never sent unsigned.
- **The secret is sealed, never read back, and never logged.** AES-256-GCM under `QCLOUD_WEBHOOK_KEY` (32 bytes; the Control API and the
  tick both need it). No route returns it, not even the answer to the create that supplied it. Audit rows name `webhook=<id>` only, and a
  viewer sees a webhook's URL origin and nothing after it. A reference to the cloud secret manager, which the task allowed instead of
  sealing, was not built: the key is an environment value like the connection string.
- **A driver hazard was found.** `Bun.SQL`'s `tx.array(values, type)` throws on a null element for BIGINT and INTEGER and writes the
  text "null" for TEXT with no error. The webhook queries pass one JSON document through `jsonb_to_recordset` instead. The rest of the
  repo was not swept for this and should be.
- **Still open:** EXPLAIN and the schema snapshot for migration 8 and the delivery claim were generated on PG 18; redo them on PG 16 with
  the Docker-backed gate. Real receivers, a public CA chain and the egress of a real VPC were not run.

### 2026-10-16: task 60 put workflow runs in Postgres under a version fence, and found that upstream's `update` cannot be shared

Task 60 replaced upstream's SQLite `WorkflowStore` with a port in `core` and two implementations: an in-memory reference and a Postgres store
(migration 9, two new tables). The design held; five points were settled that the plan left open or got wrong.

- **A blind `update` is wrong for two engines.** Upstream's `update` writes whatever the caller holds, which is right for one process. Two engines on one
  database can read a run, work, and both write; the second silently erases the first's step. `update` is now a compare-and-set on a `version` column
  (0 when saved, one more for every write that moves the run) and the loser gets `ExecutionStaleError` with the version it found. Of 1,000 pairs of
  engines racing on one run, exactly one write landed every time. **This is a behaviour change from upstream, and the engine (task 61) has to handle
  the refusal, not retry blindly.** A signal recorded into a run that is not parked does not change `version`, so a signal never makes an engine's
  update stale.
- **A timeout needs a durable deadline, not a timer.** Upstream arms a `setTimeout` per parked `waitFor` in the engine's memory. A run whose process is gone
  expires only when some process recovers it and re-arms the timer, and two processes can arm one. The deadline is a column (`wait_deadline`), `claimDueWaits` takes the due ones under `FOR UPDATE SKIP LOCKED` and
  stamps a lease (`wait_lease_until`) so two scanners never expire one wait, and `expireWait` settles it in a statement that checks the run is still
  parked on that event at that node. A signal and a timeout racing on one run end in exactly one of resumed or failed (200 rounds).
- **The owner lease in step 5 was not built.** `listRecoverable` takes `idleMs` (0 = no cutoff) and returns runs whose last progress is older than that.
  A lease would need a heartbeat from the engine to be worth anything; recovery by idleness needs none, and the version fence makes a second resumer
  harmless. **A run whose engine is slow but alive can be resumed by a second engine after `idleMs`; the fence stops the second from overwriting, but
  the second may redo a node. Task 61 chooses `idleMs` against the longest node.**
- **A Postgres shape that breaks `LIMIT`.** `UPDATE t SET … FROM (SELECT … LIMIT n FOR UPDATE SKIP LOCKED) due WHERE …` can re-evaluate its subquery, so
  `claimDueWaits({ limit: 2 })` returned three rows. A `WITH due AS MATERIALIZED (…) UPDATE … FROM due` is evaluated once. **The other `SKIP LOCKED`
  statements in the repo use `WITH … MATERIALIZED` or `IN (subquery)` and were not audited for this; a sweep is owed.**
- **Retention can race recovery.** A pick-then-delete cleanup that reads a run as `failed` can delete it after recovery has set it `running`. The delete
  re-checks state and age, so either the run is kept or it is gone and the recovery's `update` is refused as stale; neither can leave a half-moved run
  (100 rounds). Archive moves a run in one statement, and the archive only grows. An id may be archived, saved again and archived again; live and
  archive rows may then coexist, by design.
- **Scale.** At 1,000,000 runs every bounded query is under 3 ms (recovery by one index range per state, 2.5 ms; the wait scan, 0.19 ms). `listActive`
  is unbounded as upstream's is: 101 ms for about 200,000 runs of one workflow. `getArchivedCount` is a full count of the namespace's archive.
- **Smaller points.** Signals stay a column (no `output` column); each encoded column is capped at 16 MiB; the codec no longer preserves cyclic
  references; `failure_reason` is not capped; `findChild` returns the oldest child; the engine-level model is task 61's, and a store-level
  differential model (five checks, five planted bugs) was built instead.
- **Still open:** EXPLAIN and the schema snapshot for migration 9 were generated on PG 18; redo them on PG 16 with the Docker-backed gate. The same
  `Bun.SQL` null-in-typed-array hazard as task 52 applies; the workflow code uses `jsonb_to_recordset`, and the rest of the repo was not swept.

### 2026-10-16: task 61 ran the workflow engine on queue jobs and the tick, and found what a shared store needs that one process did not

Task 61 ported the Workflow Engine onto the SDK `Queue` and `Worker` and the Postgres `WorkflowStorePort`. Every node of a run is a `wf:step` job on
`__wf:steps`; the run's `currentNodeIndex` is the cursor, a pure admission rule drops a stale or duplicate job, and the maintenance tick does the two
things no worker can do for itself (end a wait, take a run whose engine is gone). The design held. These are the points the plan left open or got wrong.

- **A version fence alone made one run's own steps stale each other.** Parallel steps and the node's heartbeat all write the same run. With task 60's
  compare-and-set, the second writer lost to the first even though both belonged to one engine. `RunStorage` is now one serialising writer per run per
  engine that copies the new `version` back after each write; the fence is only between engines (and the tick). A write that loses it raises
  `WorkflowExecutionClosedError` and the work for that run stops: it does not retry, because the run now belongs to someone else.
- **A timeout is a deadline in the database, so a wait ends late by up to a tick.** `waitFor` no longer arms a `setTimeout`. The tick claims overdue
  waits (`claimDueWaits`, on the database's clock, which is why `WorkflowStorePort.now()` was added) and publishes a job flagged `due`; the worker fails
  the gate through `expireWait`, where a signal that arrived first still wins. **The precision of a wait is therefore the tick interval plus the
  transport's delivery, and with no tick running a timed wait never ends.** `docs/limits.md` section 7 and `docs/compat.md` say so.
- **Task 60's "recovery by idleness needs no heartbeat" was wrong for a slow node.** A node that writes nothing for `idleMs` looks dead. A running node
  now writes its run every `heartbeatMs` (10 s); `idleMs` (300 s, `QCLOUD_WORKFLOW_IDLE_MS`) has to exceed the longest gap between two writes, which
  the heartbeat makes the heartbeat period. The heartbeat is stopped before the cursor is written and the next node is published, so it never
  overwrites the move. The tick takes `running`, `compensating` and `failed` runs with a version-checked write (`RecoverableOptions.states` was added
  for this).
- **The tick deliberately skips `waiting` runs, and that leaves one gap.** A store full of old approval gates would fill the recovery batch and hide a
  stuck run behind them. A run that is `waiting` with its signal stored but whose resume was never published (the signalling process died between the
  two) is repaired only by `engine.recover()`. **Open: either the tick takes waiting runs that have a signal recorded (a cheap indexed predicate), or an
  operator runs `recover()`; decide with task 62's operator surface.**
- **A closing or crashed worker does not hand its job to anyone; the tick's re-ring does.** The first model runs showed a child run "never
  published". It was a harness defect, not an engine one: the harness never ran `store.tick`, so a job whose bell a closing worker had spent stayed
  `waiting` with nothing to ring it. The harness now runs the real `runTick`. The finding it led to is a property of the design, not of the harness:
  **after a crash or a forced close, a job is picked up again only when the tick re-rings it (bounded by `reRingAfterMs` plus the tick interval)**, so
  an engine's liveness depends on the tick exactly as a queue's does. No change to `listRecoverable` was needed.
- **A rolling deploy with a changed definition must be refused, not tolerated.** A run is bound to the hash of the definition it started under; an
  engine that registers a different definition under the same name while a live run holds the old one now fails (`WorkflowDefinitionMismatchError`),
  because it would drive an old run with new code. A `compensation-stuck` run does not block registration. This made `register` async.
- **A sub-workflow node polls its child inside the parent's job and holds a worker slot.** That is upstream's behaviour, kept: `concurrency` bounds the
  sub-workflows waiting at once. When the child outlives the node's timeout the parent cannot be rolled back (a live child cannot be), so it parks in
  `compensation-stuck` until an operator lets the child stop and calls `resumeCompensation`. A timed-out child is not killed.
- **Compensation handlers are at-least-once across a crash.** `compensation:completed` is emitted before the outcome is stored (as upstream's is), so
  a crash between the two runs the handler again with the same idempotency key. Once the outcome is stored it never runs again. A `failed` run is
  also stored before its unwind starts, so a `failed` row without `rollbackStatus` is a legitimate transient window. A step that failed after declaring
  `compensate` is compensated too.
- **Three upstream model invariants are relaxed, for windows that exist because an outcome is stored after its effect in a store other engines read.**
  (1) A `failed` run may lack `rollbackStatus` until the run settles; the strict check applies at the end and the liveness gate is unchanged. (2) A
  `running` map record is accepted while its node is current. (3) A map transform may run once per engine generation instead of once overall (a crash that
  loses its completion write re-runs it in the next generation). Every other invariant (I1 to I12) is upstream's, and none was weakened to make a
  failing run pass.
- **Smaller points.** The injected `Clock` replaces upstream's process-global one (two engines in one process can share a simulated clock). `cancel`,
  `startWorkflow`, `listExecutions` and `defineWorkflow` are additions. The maintenance step repeats the job name and payload shape of the SDK because
  `maintenance` may not import it; `test/workflow/tickFormat.test.ts` keeps them equal. Only the upstream scenarios that bear on the engine's semantics
  were derived; the whole upstream test suite was not ported (`docs/compat.md`). The `Bun.SQL` null-in-typed-array hazard and the `UPDATE … FROM
  (subquery LIMIT)` shape were not swept repo-wide.

### 2026-10-16: task 62 put workflow runs in the Control API and the panel, and found that the API can claim a run but never execute it

Task 62 gave the Control API three read routes and one action route for workflow executions, and the panel a Workflows page. The design held (a
Control API with no engine; workers hold the definitions). These are the points the plan left open or got wrong.

- **The Control API cannot run a step, so an action is a claim and a publish.** It holds no definitions, so "cancel" or "send a signal" cannot call the
  engine. Each action is a version-checked write that moves the run (the claim) followed by a `wf:step` job on `QCLOUD_WORKFLOW_QUEUE` (the publish), which
  a worker that has the definition executes; `workflowStepJob` and the queue name moved to `core` so the Control API builds the job the SDK reads. A claim
  that succeeds and a publish that fails leaves the run claimed: the answer is 503 `publish_failed` with `claimed: true`, and the maintenance tick
  publishes the job again once the run has been quiet for `QCLOUD_WORKFLOW_IDLE_MS`, **five minutes in the worst case**. `QCLOUD_WORKFLOW_QUEUE` and
  `QCLOUD_WORKFLOW_IDLE_MS` have to be the same on the Control API, the tick and the workers; a Control API that names another queue publishes jobs nobody
  consumes.
- **The version fence is a compare-and-set for two actions and a read check for three.** `cancel` and `recover` claim with `store.workflows.update`, so a
  run that moved is a 409 `version_conflict` with nothing changed. `signal` (the store's `recordSignal` locks the row), `retry-compensation` and
  `abandon-compensation` check `expectedVersion` against a read first and then let the store judge: a run that moves between the check and the write is
  decided by the store's own rules, not by the version. The acceptance "a stale version is refused and nothing changes" holds for all five at the read; it
  holds as a compare-and-set for two. `docs/limits.md` section 13 says so.
- **The tick's skip of `waiting` runs is closed by an operator action, not by the tick.** Task 61 left a gap: a `waiting` run whose awaited signal is
  recorded but whose resume job was lost is repaired only by `engine.recover()`. `recover` is now one of the five actions and covers exactly that run (and
  refuses a run that showed progress inside the idle window, `workflow_progressing`). The tick still skips `waiting` runs on purpose, so a store full of
  old approval gates cannot fill its batch.
- **A signal restored a wait the store could not see again.** Cancelling or recovering a run parked on a gate left its `signal_wait` unrecorded, so the
  next `recordSignal` for the same event was judged "not awaited". `restoreSignalWait` now puts the wait back, found by a contract test first
  (`test/support/workflow/signals.ts`, which both stores run) and then fixed.
- **The registry of definitions is a table, not a guess.** The panel needs to draw a run's graph and say "no worker serves this definition". Workers
  announce `(name, hash, revision, graph)` every `announceMs` (30 s) into `qcloud_workflow_definitions` (migration 10); migration 11 adds the partial index
  behind `liveDefinitions()`, which counts live runs per hash for the `unserved_definition` warning. Both only add a table or an index; a release that does
  not know them runs unchanged. `features.workflows` is true from migration 10 on. The loop-name helpers (`<step>:<n>`) moved to `core` so the store and the
  Control API read iterations the way the engine writes them. `summaries({ id })` was added so one run is read without a list.
- **A for-each of 10,000 items must be counts, not rows, and the read is still the whole run.** The detail carries the loop as one entry with
  `{ iterations, byStatus, compensation }`, and the iterations are paged through `iterationOf` with a status filter. A seeded run of 10,000 returns a detail under
  50,000 bytes. The counts and the pages are made by the Control API from the run's step records, one pass over them, not by the database: the response is bounded
  and the read is not, so each request loads the whole run (measured, one request at a time on a laptop: 10,000 iterations are 1.1 MB of stored steps and a 5 ms read, 50,000 are 5.6 MB and 20 ms,
  with responses of 1.2 KB and 6 KB). Design consequence: a run of hundreds of thousands of items needs the iterations in rows
  of their own (a table keyed by `(execution, step, n)`) or counts kept by the engine; the plan did not ask for it and this task did not build it.
- **Payloads in the panel are visible to every `viewer`.** Results, errors, inputs and signal payloads are shown as stored, cut at 1,024 bytes in a list and
  256 KiB in a detail with the job inspector's `{ "$type": "truncated" }` marker. Nothing hides them from a viewer. A workflow that carries a secret in its
  input shows it. `docs/limits.md` section 13 says so, and `QCLOUD_API_WORKFLOWS=false` hides the page.
- **Every mutation is audited without its payload.** The audit row is `POST /workflows/executions/:id/actions` with `id=<id> workflowAction=<name>`; the
  event, the payload and the reason are never written (a test reads the rows back after each action).
- **"Rollback" in the panel is two different things.** On a live run it is `cancel` (the engine unwinds what had completed); on a `compensation-stuck` run
  it is `retry-compensation`, with `abandon-compensation` behind a typed confirmation. The words in the panel follow the run's state.
- **The browser run found no panel defect; it found two test-harness ones.** The workflow worker of the e2e runtime is a worker, so it appeared in the
  worker registry that two older specs expect to be empty; it now runs only while the workflow specs do. A spec that reloaded the page lost the bearer token
  (held in memory by design) and met the sign-in dialog; it waits for the page's own refresh instead.
- **Smaller points.** `docs/compat.md` had "Not supported" for the panel's workflow routes and now describes them. A definition that no worker serves is
  listed with a warning and its actions are still offered (the job waits on the queue until a worker has the definition). The upstream archive, maintenance
  and runtime panels are not carried (there is no SQLite archive; retention is the tick's).

