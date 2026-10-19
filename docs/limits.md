# Limits

What Qelay-Cloud promises, what it does not, and which numbers behind that were measured, derived or never run. Every
figure names its source. "Not run" means the real service was never touched (no `terraform apply`, no cloud account), so
the claim is a design claim until it is run; the emulators and local Postgres stand in for it in the tests, and an
emulator result is not evidence about the real service's redelivery, backoff or dead-lettering.

What each broker does, side by side (delay mechanism, at-least-once, dead-lettering, `stats` freshness, emulator gaps,
cost drivers), and which test pins it, is in [transports.md](transports.md). Its delay-precision figures are compared
with section 1 below by `test/contract/matrix.test.ts`.

Measured on PostgreSQL 18.6 on one developer machine, Bun 1.4.2. The PostgreSQL 16 run is owed (see
[What has not been run](#8-what-has-not-been-run)).

## 1. Delay precision, by hosting mode

Read this first. A delayed job, a retry's backoff, a rate-limited queue resuming and a cron entry all wait for the same
thing: a bell rung at the right moment. **What rings it is the tick, and how often the tick runs sets how late the job
is.** `run_at` is a floor: no job was ever claimed early in any run.

| Hosting mode | What rings the delayed job | Lateness | Evidence |
| --- | --- | --- | --- |
| **Tick only on Cloud Scheduler** (Pub/Sub; a scale-to-zero push handler gets this) | The scheduler, once a minute | Uniform over a minute: **mean about 30 s, worst about 60 s**, plus Pub/Sub's own delivery time. Never early | By construction of the one-minute period. The scheduler's own jitter was not run |
| **Always-on worker with the in-process tick, interval 500 ms**, Pub/Sub or any transport with no delivery delay (window 0) | `TickLoop`, which rings a job once it is due | mean **270-292 ms**, p95 **479-513 ms**, max 488-495 ms (one run 1,165 ms, not reproduced) | `scripts/measure-tick-lateness.ts`, 60 jobs a row, three runs; no early bell |
| The same, **interval 2,000 ms** | as above | mean **1,080-1,113 ms**, p95 **1,950-1,956 ms**, max 1,993-2,004 ms | same |
| A transport that can deliver a bell later (a delivery window): the tick rings ahead | The broker, at the due time | mean **6-8 ms** after due, p95 8-15 ms, on top of the broker's own lateness | same script, windowed rows: the tick's share only |
| **Local transport** (`postgres`: NOTIFY plus a poll) | The poll loop of each worker | The poll interval: default **1,000 ms, jittered plus or minus 20 %**. A lost NOTIFY is repaired by the poll within 50-100 ms in the tests (poll 50 ms) | task 16; `transport-local` tests |
| **SQS** (task 40; `QCLOUD_TRANSPORT=aws-sqs`) | The queue, for a delay inside its **900 s** window (`DelaySeconds`, rounded **up** to a whole second); the tick for the rest. A delay past 900 s is `delay-too-long` and is never clamped | The broker's, inside the window, plus up to 1 s from the rounding. Never early on the emulator. Real SQS not measured | `packages/transport-aws/test/delay.test.ts`, **emulator** (ElasticMQ 1.7.1) only |

**What this means for you.**

- **Seconds-level delay, retry backoff and rate-limit resumption need an always-on worker running the in-process tick**
  (`TickLoop` in the worker's host, with `QCLOUD_TICK_INTERVAL_MS` or the option). A scale-to-zero push handler gets
  the minute. The scheduler job stays in both cases: it is the cron source and the safety net if every worker is down.
  The loop needs no web server or worker code: `qcloud-tick loop` is one always-on process (one instance, or two for
  failover; the lease picks the leader; `tick_loop` in either Terraform example runs it) that beats every second and runs the retention steps every 30 s, so the beats
  between cost only recovery, crons, promotion, expiry and the ring query. Its cost per beat on a real database is not
  measured; the lease row is one write per beat.
- On Pub/Sub, delay, retry backoff and rate-limit resumption **all run at tick speed**: Pub/Sub has no per-message delay
  and no backoff the application controls, so the doorbell for a delayed or retried job is rung when the tick sees it due.
- **Worst cases, not means:** a doorbell that was lost (a publish that failed, a bell dropped) is rung again after
  `reRingAfterMs` plus one interval; a crashed worker's job is recovered after its **lease plus two intervals**; with no
  always-on worker the floor for everything is the scheduler's one minute. In the chaos test the observed worst gap was
  1,717-1,743 ms against a bound of 2,250 ms (interval 1,000 ms), and 3,222 ms against 3,750 ms (interval 2,000 ms).
- **Cron has a one-minute floor on a scheduler-only deployment.** A five-field cron entry fires at its minute boundary
  and at most as late as the tick that finds it. A six-field (seconds) expression or `repeatEvery` below a minute is
  accepted, but fires no more often than the tick runs. **A late occurrence is not made up:** after an hour of downtime
  a cron fires once, not sixty times.
- Add the broker's own latency on a real queue; the table is the tick's share.
- **On AWS the scheduler can run slower than a minute** (`scheduler_schedule = "rate(N minutes)"`) to save the tick's task
  launches, about 43,200 a month at one a minute. That moves the floor above from one minute to N minutes for everything
  that waits for the tick, so do it only when the workers run `TickLoop`. The `tick-stalled` alarm follows the rate. Plan-checked,
  never run.

## 2. Sizes and counts

| What | Limit | Where it comes from |
| --- | --- | --- |
| Job payload | **1 MiB** (1,048,576 bytes) once encoded; larger is refused with `PayloadTooLargeError`, nothing written | `MAX_PAYLOAD_BYTES` in the store |
| A job's result | the same 1 MiB | the store, on completion |
| Values in a payload or result | **20,000** (values and object keys together), nesting at most **64**; more is refused with `PayloadTooComplexError` (API: 413 `payload_too_large` with `kind`, `limit`, `index`), nothing written. Options `maxPayloadNodes` and `maxPayloadDepth` | `MAX_PAYLOAD_NODES` and `MAX_PAYLOAD_DEPTH` in the store; at enqueue, data edit and completion |
| Jobs in one `addBulk` | **1,000** | `MAX_BATCH`; one transaction |
| Delay, `repeatEvery` | at most **365 days**; longer throws `UnsupportedOptionError` | `core` options |
| Bells per publish | the transport's `maxRingBatch` | `DeliveryTransport` |
| A listing | `getJobs` window of at most **1,000**; no call reads a whole queue | [docs/compat.md](compat.md) |
| A flow | **1,000** jobs and **100** levels; an action on a flow names at most 1,000 jobs | `MAX_FLOW_JOBS`, `MAX_FLOW_DEPTH` |
| A flow in the Control API | `GET /flows/:id` returns **1,000** jobs by default and at most **5,000**, top level first, with `truncated`; `GET /flows` pages of at most **100** | `DEFAULT_FLOW_VIEW_NODES`, `MAX_FLOW_VIEW_NODES`; every statement has a `LIMIT` |
| Webhooks | **100** per namespace; a URL of at most **2,048** characters; a secret of **16 to 256** characters; a delivery's history keeps its last **20** attempts and its error **500** characters; a deliveries page is at most the store's `MAX_DELIVERY_PAGE` | `MAX_WEBHOOKS`, `MAX_WEBHOOK_URL_CHARS`, `WEBHOOK_HISTORY_ENTRIES`; see [webhooks.md](webhooks.md) and section 12 |
| Doorbell content | a bell carries no payload and no job id: it says only that a queue has work | design (fungible bells) |

## 3. Throughput and latency (load check)

`bun run scripts/load-check.ts` (task 22). 100,000 jobs over 5 queues, 16 in-process `Worker`s at concurrency 10,
100-byte payload, bulk of 100, one bell per job, on one machine with the database on the same machine. The producers,
workers and the tick share one event loop and one CPU, so **these are a floor for a fleet of separate processes**, and
the database round trip is local (about a tenth of a millisecond), so on a cloud database each claim costs its network
round trip more. Every drain ended in a reconciliation: the rows are exactly the jobs added, all completed, none ran twice.
Ranges are over the runs made on the final code (the no-tick, hot-queue and rate-limit rows over two to four runs,
the tick rows over three), because the figures with the tick on vary a lot from run to run (see finding 1).

| Run | Admit | End to end | Claim latency (mean / p50 / p99 / max) | Bells by the tick |
| --- | --- | --- | --- | --- |
| No tick | 16.8-17.7k jobs/s | **3,130-3,295 jobs/s** | 23.1-24.4 / 22.7-23.6 / 48.3-53.5 / 77-106 ms | 0 |
| Tick every 5 s (default) | 16.3-17.2k/s | 1,725-2,090 jobs/s | 32.6-39.5 / 31.9-35.1 / 62-113 / 171-283 ms | 147,606-181,036 |
| Tick every 1 s | 17.3-21.8k/s | 1,632-1,955 jobs/s | 37.3-39.0 / 33.9-35.5 / 96-116 / 270-332 ms | 180,162-197,788 |
| One hot queue, 20,000 jobs, no rate limit | 29.8-33.6k/s | 3,054-3,102 jobs/s | 21.8-22.0 / 19.4-19.7 / 57.4-65.7 / 136-192 ms | 0 |
| The same with a rate limit that never binds | 41.3-42.0k/s | **1,313-1,361 jobs/s** | 84.8-87.8 / 80.9-84.3 / 145-151 / 520 ms | 0 |

For reference, `../qelay/bench/comprehensive.ts` runs 1k to 50k jobs in memory with a bulk of 100, concurrency 10 and a 100-byte
payload. Those are in-memory numbers with no network or durability, so they are not comparable with the table, which has a
Postgres commit behind every claim and every completion.

**Findings.** The first two are the price of a design choice, the next three are serialization points in code ported from
Qelay, and the last one was a bug that this check found and that is fixed. None is a failure: every drain reconciled.

1. **The tick re-rings a deep healthy backlog.** A tick pass is capped per queue (`maxRingsPerQueue`, default 100), but a
   beat repeats passes while work is left, for up to its interval. A backlog whose bells are older than `reRingAfterMs`
   (default: the interval) is therefore rung again in full, every interval. A tick cannot tell a bell that is waiting in a
   broker from one that was lost: bells are fungible and carry nothing to tell them apart. For a lost bell that is exactly
   right; for a deep healthy backlog it is waste. A 100k drain cost **1.5 to 2 tick bells per job** (148-198k), at 5 s and
   at 1 s alike, and ran **a third to a half slower** than with no tick (1,632-2,090 against 3,130-3,295 jobs/s), with a
   99th-percentile claim about 1.1 to 2.4 times slower. The figures are noisy because the effect feeds itself: a
   slower drain leaves more bells old enough to re-ring. **Mitigation today:** do not run a short `reRingAfterMs` or
   interval against a backlog of thousands; with Cloud Scheduler (60 s, the managed tick) the cost is about one re-ring per
   job per minute of backlog. Lowering the per-queue ring cap or `maxRunMs` lowers the cost per beat.
   **Added since, not yet measured on a real backlog:** `QCLOUD_TICK_MAX_STALE_RINGS_PER_QUEUE` caps the re-rings of a queue
   separately from the first rings (default: the same cap, so nothing changes until it is set), and the producer's
   `ringCoverMs` plus the worker's `claimAgain` (on by default) let one bell serve a backlog. Both are recorded in
   [the gate document](spikes/06-phase0-gate.md) as open decisions.
2. **A rate limit, or a global concurrency limit, serializes the claims of its queue on one row.** The claim has to
   read and update the limiter's counter exactly, so claims of a rate-limited queue queue up on that row (about 27 waiting
   statements per poll against about 1 on an unlimited queue; `Lock:tuple`). The measured price is about **2.3 times
   slower** on one hot queue (1,313-1,361 against 3,054-3,102 jobs/s) even when the limit never binds. This is inherent to an exact
   limit, and a limit low enough to matter (a rate limit exists to hold throughput down) is far below 1,300 claims per
   second, so it was **left as it is, not partitioned**: a partitioned counter would only approximate the limit.
   **If you need both a rate limit and high throughput, spread the work over queues.** Five queues with no limit ran
   at about 1 lock waiter per poll.
3. **Completions of one queue serialize on its metrics rows.** The per-queue counters (`qcloud_metric_buckets` and
   `qcloud_metric_totals`) are updated in each completion's transaction, last, so two completions of one queue wait for
   each other until the first commits. On one hot queue the sampler saw about 14.5 `Lock:transactionid` waiters per poll
   (against 1 across five queues) and still 3,054-3,102 jobs/s on a local database. **Expectation, not measured:** on a
   managed database a commit takes longer than it does here, so the completion rate of a single queue is bounded by one
   commit time. Spread hot work over queues, or turn on the worker's `groupComplete` option (off by default): jobs that
   finish while another finish is being stored share one transaction, so a burst pays one commit and one set of counter
   rows instead of one per job. A worker that finishes one job at a time is unchanged. The saving on a managed database
   is **not measured**; `qcloud.worker.complete_group_size` and `qcloud.worker.complete_ms` show it. Old minute buckets
   are no longer deleted by the completion: the tick does it (`maxMetricBuckets`), so a complete takes no delete on the
   counter rows, and `throughput` hides a bucket past the retention until the tick has removed it.
4. **Every commit that writes events serializes per namespace.** The event journal gives each commit its position at
   commit time, under one advisory lock per namespace (`Lock:advisory`, with the committing session waiting in `COMMIT`:
   0.9 to 1.2 waiters per poll at about 3,000 jobs/s). This is how the ported journal keeps its order, and it bounds the
   namespace's commit rate to the rate one lock can be passed. Separate namespaces do not share it. A batch is one pass, not one
   per job (`journal.lockPasses.test.ts`), so `addBulk`, `completeMany` and the worker's `groupCommit` and `groupComplete`
   lower the passes per job. Replacing the lock is designed and not built: it would weaken the order of one job's events and
   let a long write transaction stall every reader ([spike 07](spikes/07-journal-order.md)).
5. **Retention keeps up per pass, not per burst.** A tick pass trims at most `maxItems` (default 200) events or commit
   envelopes. A 100k burst writes about 300,000 events and 200,000 commit envelopes, far above the default cap of 10,000
   events per queue, so the journal sits above its cap for a while after a burst, then comes down over later beats. It is
   storage, not correctness: a reader behind a trimmed event is told with `gap`. Raise `maxItems` (`QCLOUD_TICK_MAX_ITEMS`) if that matters.
6. **Two statements of the tick were quadratic, and are fixed.** The first runs of the check at a 1 s tick showed the
   retention step exceeding its 10 s deadline. One statement scanned every live commit envelope on every pass (now a
   bounded round-robin window, `eventCommitPrune.ts`), and one folded the retention counts through a join that
   the planner ran as a nested loop on a table it had no statistics for (790 million join-filter rows and 32 s for 40,000
   counts; now a delete by key). Each came with a failing test first (`journal.retention.test.ts`) and a plan row.

**Contention and plans (100k rows, `EXPLAIN (ANALYZE, BUFFERS)`):** the FIFO claim reads the ready index in 0.024-0.076 ms with no
sort; the LIFO claim 0.004-0.005 ms; the never-rung ring query 0.121-0.165 ms, the stale-bell ring query 0.276-0.333 ms (100 rows
each); the promotion queries 0.002-0.006 ms, index only. The "next queue with work" hop of the ring query uses
`qcloud_jobs_state_idx` index-only (0.016-0.030 ms), not the ring index the plan test names; both are fast. No sequential
scan on a claim path. `pg_stat_activity` over a drain shows the claim's advisory lock and about one waiter per poll on an
unlimited five-queue run, so the claim path does not contend with itself across queues.

**The per-queue ring cap on a 100k backlog nobody rang** (every publish failing, one tick pass):

| `maxRingsPerQueue` / `maxItems` | One pass | Bells | Passes to ring everything once |
| --- | --- | --- | --- |
| 100 / 200 (the default) | 65-102 ms | 500 | 200, that is **1,000 s at a 5 s interval** |
| 1,000 / 200 | 154-175 ms | 5,000 | 20 (100 s) |
| 1,000 / 100,000 | 287-337 ms | 5,000 | 20 (100 s); `maxItems` does not cap the rings |

The default is therefore a safe floor for a healthy system and a slow repair of a catastrophe: a broker that lost a 100k
backlog's bells is repaired at 500 bells per pass, and passes repeat within a beat (finding 1) until the beat's
interval is spent. Raise `QCLOUD_TICK_MAX_RINGS_PER_QUEUE` if a large unrung backlog is a risk you accept; it costs about
0.3 ms per extra bell in one pass.

**The local transport's fan-out** (`bun run scripts/load-local.ts`, 10,000 jobs on one queue, each worker with its own
`LISTEN` connection, two runs): 1 worker 1,064 and 1,586 jobs/s, 4 workers 2,435 and 2,270, 16 workers 1,973 and 1,518.
One worker is bound by its own concurrency of 10; past four workers the fan-out (every bell reaches every listener:
10,000 bells are 160,000 notifications at 16 workers) and the shared CPU of this one process cost more than another
worker adds. This is a measurement of a development transport in one process, not of a fleet; it is the reason it is
documented as a development and small-fleet transport (section 9).

**Vacuum on the hot tables (migration 12).** The jobs, queue-state, metric and webhook-delivery tables are set to
`fillfactor = 80` and `autovacuum_vacuum_scale_factor = 0.01`, so an update that changes no indexed column stays on its
page and vacuum starts at 1% dead rows, not 20%. The setting applies to pages written after the migration, and nothing
here measured the effect: a drain with `pg_stat_user_tables` (`n_tup_hot_upd`, `n_dead_tup`, `last_autovacuum`) on a
real instance is part of the load check owed under section 8. Raising the instance's `autovacuum_max_workers` and
alerting on dead rows are instance settings, not schema, and are not made by the migration.

**Webhook delivery writer (migration 14).** A namespace that runs `qcloud-tick webhook-writer on` has its deliveries made from
the event journal by a pass of at most 500 events, in one transaction that also moves its cursor, instead of by the trigger in
the job's transaction. Deliveries then appear a few seconds after the job's commit, and a webhook can have a `filter` and a
`shape`. A shaped body is made once and stored (at most 64 KiB; a larger one is recorded as a failed delivery). If the journal's
retention removes events before the writer reads them, those events make no deliveries (gauge `webhooks.writer_gaps`).
Not measured: the writer's throughput and lag at volume, and what the lock taken by `off` costs on a busy namespace on Cloud SQL
or RDS. Tested on PostgreSQL 18.6 on one machine only.

**Webhook deliveries by day (migration 13).** `qcloud_deliveries` is partitioned by `created_at` (the event's time), one
partition a day (`qcloud_deliveries_YYYYMMDD`, UTC) plus a default partition. The tick makes today and the next three
days (`ATTACH PARTITION`, which lets inserts through on the parent) and drops a day once its end is
`QCLOUD_WEBHOOK_KEEP_MS` (2 days) old and it holds nothing waiting or being sent. A write for a day with no partition lands
in the default partition, so a write never fails for a missing one, and that partition keeps the row-by-row retention. What
this does not cover: the partition functions wait at most one second for a lock and try again on the next pass, so a long
transaction on the table can delay the creation or the drop; creating a partition checks the default partition, which holds
little, under a lock that a write landing there waits for; a day partition is dropped with `DROP TABLE`, which takes a lock
on the table for an instant. All of this ran on PostgreSQL 18.6 on one machine; the lock behaviour on Cloud SQL and RDS is not
measured. The **events** table is not partitioned: its retention is a cap per queue (the oldest events beyond it), a rule a
partition cannot express, and its position reader needs one ordered key.

## 4. Connections

The SDK holds a database connection only for one statement or one short transaction, never while your code runs, so a
worker's `concurrency` is **not** in the formula. Source: `packages/store-postgres/src/connection/budget.ts`, which
`bun run check:terraform` compares with the Terraform for 10, 50 and 200 workers.

```
direct = sum over processes of (pool_size + listen_connections) + 6 reserved
pooled = pooler server pool size + listen connections + 6 reserved
```

Defaults: pool size 2 per process, 3 control processes (two API and one tick), 6 reserved, a pooler server pool of 20.

| Worker processes | Direct (pool 2) | Pooled |
| --- | --- | --- |
| 10 | 32 | 26 |
| 50 | 112 | 26 |
| 200 | 412 | 26 |

With the default `max_connections` of 100, a direct fleet tops out at **44 worker processes**. When the connection
options carry a `fleet` plan (process counts and the database's `max_connections`), a plan that cannot fit throws
`ConnectionBudgetError` where the connection is configured, before anything connects, instead of failing at random with
Postgres's 53300. Without a `fleet` plan nothing is checked; `infra/gcp` checks the same formula in its Terraform plan.

**Pooler rules.** Behind a transaction pooler set `QCLOUD_DATABASE_POOLER=transaction`:

- `LISTEN` cannot go through it, so the local transport needs `QCLOUD_DATABASE_LISTEN_URL`, a direct URL. On Pub/Sub
  nothing holds one, and `QueueEvents` never does: it polls the journal with one pooled statement per read.
- Session settings cannot ride a startup parameter: `search_path` for a non-default schema, `statement_timeout` and
  `lock_timeout` belong on the database role (`ALTER ROLE ... SET`). The driver refuses them as options and says so.
- **Admission control.** One process has at most `maxInFlight` store operations at once, running or waiting for a
  connection (default 64 per pooled connection, so 128 at the default pool of 2). The next one is refused at once with
  `StoreOverloadedError` (`STORE_OVERLOADED`, the API's `503 store_overloaded`): nothing was sent, so it is safe to retry
  after a pause. A stalled database then costs a bounded queue instead of unbounded memory and a wall of deadline errors.
  A worker whose completion is refused reports it as an unconfirmed outcome and the tick recovers the lease. It is an option
  of `openDatabase`, with no environment variable, and the number was chosen, not measured.
- The server-wide timeouts are not session settings the process sends, so they work behind a pooler: Terraform sets
  `statement_timeout` 30 s, `lock_timeout` 5 s and `idle_in_transaction_session_timeout` 30 s on the database. Only the
  plan was checked; no database was created with them.
- No session-level advisory lock is used anywhere (`pg_advisory_xact_lock` only). Named prepared statements are on only
  without a pooler (`prepare` is off behind `transaction`). Against a real RDS Proxy, whether anything still pins a
  session (including `nextval`) was not run.

## 5. What is not supported (decision D6)

The core is the BullMQ-style set: queues, workers, retries with backoff, delays, priorities, cron entries, rate limits,
pause and resume, DLQ, events. Everything not in it fails loudly with `UnsupportedOptionError` naming the option and the
advice, never a silent no-op. [docs/compat.md](compat.md) lists every public method of `Queue`, `Worker` and `QueueEvents`
against Qelay's with its status; the headlines are:

- No Qelay TCP server, embedded mode, `connection`, `autoBatch` or `prefixKey` (use `databaseUrl`, `database` and `namespace`).
- Every `Queue` method is async. The SDK has no cron API of its own: crons are in the store (`store.crons`).
- Manual retry of a failed job, DLQ auto-retry, `getCountsPerPriority`, `extendJobLock` and job groups are not supported.
- `FlowProducer` is supported, with a flow held to 1,000 jobs and 100 levels (Qelay allows 10,000 jobs), written in one
  transaction; [docs/compat.md](compat.md#flowproducer) lists the rest. The Workflow Engine is supported ([docs/compat.md](compat.md#workflow-engine)).
- A `Queue` sees only its own queue; job ids are unique per namespace.

## 6. Delivery guarantees

- **At least once**, and a handler must be idempotent: a lease that expires while a job runs (a crashed or stalled worker)
  hands the job to another. The reconciliation of the load check counts runs per job and found none twice in a healthy
  fleet; the chaos and scenario suites kill workers mid-job and the job runs again, with `attempts` equal to the deaths.
- A doorbell is **never** the source of truth. A lost, duplicated or late bell is repaired by the tick or ignored (a bell
  that finds nothing to claim does nothing); jobs are never lost by a broker.
- A producer's `add` stores the job first and rings after the commit. A ring that fails leaves the job unrung and the
  tick rings it (the scenario "publish failure repaired by the tick").
- A job that exhausts its attempts goes to the DLQ with the reason `max_attempts_exceeded`.
- A webhook delivery is **at least once** too: it is created in the job's own transaction, retried 8 times over 63.5
  minutes of waiting, and can reach a receiver twice (a slow answer at the timeout, a sender that died before it recorded
  the answer). The receiver deduplicates on `X-Webhook-Id`. There is no ordering guarantee. Details in
  [webhooks.md](webhooks.md).
- **Shutdown has a deadline, and the platforms differ.** Cloud Run sends `SIGTERM` and ends the instance 10 s later, a
  fixed window for services and worker pools
  ([container contract](https://docs.cloud.google.com/run/docs/container-contract)). ECS waits
  `stop_timeout_seconds` (default 60, at most 120 on Fargate). `Worker.close()` returns within
  `graceMs + 2 × timeout`, which is **20 s by default** (10 s and 5 s), so on Cloud Run call
  `worker.close({ graceMs: 4_000, timeout: 2_000 })` (8 s at worst) from the `SIGTERM` handler. A job that is still
  running when the instance ends keeps its lease until it expires, then the stall check hands it to another worker:
  that costs latency and one more attempt, not the job. Not run on Cloud Run (D9).

## 7. Configuration read from the environment

The tick service (`qcloud-tick run | serve`) and the examples read these; no flag carries a secret or a connection string.
A wrong value throws `UnsupportedOptionError` naming the variable and never repeating the value.

| Variable | Meaning | Default |
| --- | --- | --- |
| `QCLOUD_DATABASE_URL` | The Postgres connection string. **Required.** From the environment or a secret manager, never a repo | none |
| `QCLOUD_DATABASE_POOLER` | `none` or `transaction` | `none` |
| `QCLOUD_DATABASE_TLS` | `unverified` (encrypted, not verified) or `off` (plaintext, for a private hop to a pooler only) | unset: plaintext to a loopback host only; any other host is **refused** until you choose `unverified`, `off` or a CA |
| `QCLOUD_DATABASE_TLS_CA_FILE` | A CA file to verify the server with. Conflicts with `QCLOUD_DATABASE_TLS` | unset |
| `QCLOUD_DATABASE_TLS_CA` | The CA bundle itself (PEM text), for a platform that injects environment variables but cannot mount a file (ECS Fargate). A certificate is public, so this is not a secret. Conflicts with `QCLOUD_DATABASE_TLS` and `QCLOUD_DATABASE_TLS_CA_FILE`; empty is refused | unset |
| `QCLOUD_DATABASE_LISTEN_URL` | A direct URL for `LISTEN`. Only with `QCLOUD_DATABASE_POOLER=transaction`; refused without a pooler. Without it, a pooled connection cannot `LISTEN` | unset |
| `QCLOUD_DATABASE_POOL_SIZE` | Connections per process, a positive integer; the number the budget counts | 2 |
| `QCLOUD_NAMESPACE` | Isolates one deployment's jobs inside one database | `default` |
| `QCLOUD_TRANSPORT` | `gcp-pubsub`, `aws-sqs` or `postgres` | `gcp-pubsub` |
| `QCLOUD_GCP_PROJECT` | The GCP project for Pub/Sub | unset: the Pub/Sub client resolves it from its credentials |
| `QCLOUD_GCP_HOT_QUEUES` | Queues with their own Pub/Sub topic (`qcloud.<ns>.hot.<queue>`) and an unfiltered subscription; a comma separates names, so a name has none (the encoding allows only letters, digits and dashes anyway) | unset: every queue on the shared topic |
| `QCLOUD_AWS_REGION` | The AWS region of the SQS queues. **Required** with `aws-sqs`: it is never read from `AWS_REGION` or the machine. Credentials come from the default AWS chain (task role, environment, profile) and are never logged | none |
| `QCLOUD_AWS_SQS_ENDPOINT` | An SQS endpoint, for ElasticMQ or LocalStack. Unset: the regional AWS endpoint | unset |
| `QCLOUD_TICK_INTERVAL_MS` | The tick's period | 60,000 here (the scheduler's minute); the in-process `TickLoop` option defaults to 5,000; `qcloud-tick loop` defaults to 1,000 |
| `QCLOUD_TICK_RE_RING_AFTER_MS` | How old a bell must be before the tick rings it again; at most the interval | the interval |
| `QCLOUD_TICK_RING_GRACE_MS` | How long a new job is left alone, in case its own publish is in flight | 2,000 |
| `QCLOUD_TICK_WORST_LATENESS_MS` | The lateness the delivery window must cover | 1,000 |
| `QCLOUD_TICK_RING_WINDOW_MS` | The delivery window for delayed bells, clamped to the transport's | interval plus worst lateness |
| `QCLOUD_TICK_MAX_RINGS_PER_QUEUE` | Bells per queue per pass (see section 3) | 100 |
| `QCLOUD_TICK_MAX_STALE_RINGS_PER_QUEUE` | Of those, bells to jobs rung once before (section 3, finding 1) | the line above |
| `QCLOUD_TICK_MAX_ITEMS` | Items per pass (does not cap the rings) | 200 |
| `QCLOUD_TICK_MAX_PASS_MS` | The most one pass may take | 5,000 |
| `QCLOUD_TICK_MAX_RUN_MS` | The most one invocation may take (never past the interval for one loop beat) | 20,000 |
| `QCLOUD_TICK_UPKEEP_EVERY_MS` | How often a looping process runs the retention steps; the beats between skip them | 0 (every beat); 30,000 for `qcloud-tick loop` |
| `QCLOUD_TICK_AUDIENCE` | The OIDC audience the endpoint requires; with `QCLOUD_TICK_ALLOWED_EMAILS` (service accounts, comma separated) | unset |
| `QCLOUD_TICK_SHARED_SECRET` | A development secret for `POST /internal/tick` (at least 24 characters). Not for production | unset |
| `QCLOUD_WEBHOOK_KEY` | The key webhook secrets are sealed with (32 bytes, 64 hex digits or base64). Read by the Control API **and** the tick. Without it a webhook cannot be given a secret | unset |
| `QCLOUD_WEBHOOK_DEV_MODE` | `true` allows `http:` and private destinations for webhooks. **Development only** | `false` |
| `QCLOUD_WEBHOOK_BATCH`, `_CONCURRENCY`, `_BUDGET_MS`, `_TIMEOUT_MS`, `_LEASE_MS`, `_RATE_PER_MINUTE` | The sender: deliveries per pass (**0 turns sending off**), requests in flight, the time after which no new chunk starts, the bound on one attempt, a claim's lease (at least the timeout plus 5,000), attempts per webhook per minute | 50, 8, 5,000, 10,000, 30,000, 60 |
| `QCLOUD_WEBHOOK_MAX_ATTEMPTS`, `_BASE_DELAY_MS`, `_MAX_DELAY_MS` | The retry policy | 8, 30,000, 3,600,000 |
| `QCLOUD_WEBHOOK_DISABLE_AFTER` | Failed deliveries in a row after which a webhook is paused (0 never) | 20 |
| `QCLOUD_WEBHOOK_KEEPALIVE_MS`, `_DNS_TTL_MS`, `_PER_DESTINATION`, `_BREAKER_FAILURES`, `_BREAKER_COOLDOWN_MS`, `_IDLE_MS` | `qcloud-tick send` only: how long a connection to a receiver is kept (0 off), how long a name's addresses are kept (0 off), requests in flight to one host and port, failed attempts in a row that pause a destination (0 never), how long it stays paused, the wait when nothing is due | 15,000, 30,000, 4, 5, 30,000, 500 |
| `QCLOUD_WEBHOOK_KEEP_MS` | How long a finished webhook delivery stays readable; the tick only. With several ticks the shortest decides | 172,800,000 |
| `QCLOUD_WORKFLOW_QUEUE` | The queue the workflow engine's node jobs travel on. Must be the name the `Engine` was given (`queueName`) | `__wf:steps` |
| `QCLOUD_WORKFLOW_BATCH` | Workflow runs the tick looks at per pass, for due waits and for recovery each (**0 turns the step off**) | 100 |
| `QCLOUD_WORKFLOW_IDLE_MS` | How long a `running`, `compensating` or `failed` run may show no write before the tick takes it over. Must exceed the longest gap between two writes of a live run (a running node writes every `heartbeatMs`, 10,000 by default) | 300,000 |
| `QCLOUD_WORKFLOW_WAIT_LEASE_MS` | How long a claimed wait whose expiry job was published is left alone before the tick publishes it again | 30,000 |
| `QCLOUD_API_WORKFLOWS` | `false` hides the Workflows page and its routes' capability (`features.workflows`); `true` or unset leaves it to the schema | unset |
| `QCLOUD_API_WORKFLOW_SERVED_MS` | How long after its last announcement a workflow definition counts as served by a worker. At least twice the engines' `announceMs` (30,000) | 120,000 |
| `PORT` | The port of `qcloud-tick serve` | 8080 |

**Derived: how late a workflow wait ends.** A `waitFor` timeout is a deadline stored in the database, and only the tick ends
it. The wait ends on the first pass that runs after the deadline, so it is late by up to one tick interval (60 seconds
behind Cloud Scheduler's minute, 5 seconds for an in-process `TickLoop` at its default) plus the pass itself and the
transport's delivery of the job that fails the gate; a pass that cannot publish it (a broker error) leaves the wait claimed
for `QCLOUD_WORKFLOW_WAIT_LEASE_MS` (30 seconds) and the next pass after that tries again. A signal does not wait for the
tick: it resumes the run at once. A run whose engine died is taken by the pass that follows `QCLOUD_WORKFLOW_IDLE_MS` of
silence, and the job a crashed worker spent is re-rung after `QCLOUD_TICK_RE_RING_AFTER_MS`. `bun run scripts/measure-tick-lateness.ts`
measures the pass; it does not measure the workflow step on its own.

`POST /internal/tick` authenticates before it reads the method, answers a bare 401 to anything else, and returns counts
and milliseconds only: no ids, queue names, payloads or error text.

## 8. What has not been run

None of this touched a real cloud service. Each line says what the tests and the local emulators did prove, and what is
left for the first real run (decision D9: nothing paid or shared is created without your say-so).

| Area | Proven (where) | Not run |
| --- | --- | --- |
| **Core queue semantics** | Postgres store against the model: 500 runs of 150 commands, green on the in-memory fake, on Postgres and on Postgres with workers; 36 end-to-end scenarios (12 scenarios on the memory, Postgres and Pub/Sub-emulator stacks) | PostgreSQL 16 (all of the above ran on 18.6) |
| **Cloud SQL and RDS** | TLS and a pooler on local Postgres; `connection.*` suites | TLS **hostname verification** against Cloud SQL's CN-only certificate; IAM authentication; HA failover (reset or stall); managed pooling; RDS Proxy pinning, including `nextval` and `prepare: false`; a measured fleet on a real instance |
| **Pub/Sub** | The transport against the emulator: publish, filter by queue, ack and redeliver, dead-letter wiring, `stats`; monitoring metric names against a **stub** | Exponential retry backoff (the emulator's is not exponential); dead-lettering under real IAM; throughput; streaming pull across Cloud Run restarts; that a busy worker holds at most `maxHeld` bells (the emulator ignores flow control, a `test.todo`); the official client under Bun against the real service; the real metric names and filters |
| **Pub/Sub `stats`** | `inFlight` is unknown and `delayed` is 0; `stats` lag about 5 minutes plus the cache | the real lag |
| **SQS** | The transport against **ElasticMQ 1.7.1** (the JVM jar; the compose native image is for the end of the plan): the contract suite, every doorbell fault scenario of spike 04 (publish lost, bell delivered twice, paused and rate-limited queues, crashed and stalled workers, delay window, database outage, queue A never reaches queue B), the dead-letter queue as a metric, request counts per job (section 11). Every result is labelled "emulator" | **A real SQS account (D9)**: stale-handle deletes, broker-side duplicates, attribute-count lag, `Failed[]` on a real partial batch, receive counts and short polls, redrive timing, CloudWatch names and lag, IAM, the real price. `bun scripts/sqs-fidelity.ts --real --region <r>` is the probe set for that run. D2 ("per job") is now closed on Pub/Sub data **and** SQS emulator request counts, not on a real SQS bill |
| **Delay** | The in-process tick, measured (section 1) | Cloud Tasks precision and cost; Cloud Scheduler jitter |
| **Terraform (`infra/gcp`)** | `terraform fmt`, `init`, `validate` and a **credential-free `plan`**, 161 assertions in `bun run check:terraform`: safety settings, Pub/Sub names the transport expects, the budget against the TypeScript budget, refusals | `terraform apply`, ever; the thirteen items under "Needs D9" in [infra/gcp/README.md](../infra/gcp/README.md): TLS hostname, VPC egress to the private IP, dead-lettering with the service agent's grants, `max_connections` accepted, the tick's audience, OIDC accepted twice, `ttl = ""`, subnet sizing, alert filters, the secret mount, the worker pool, the CREMA autoscaler, shutdown inside 10 s |
| **The example on GCP** | on the local transport, as a test and a demo (`examples/orders`) | the GCP path: no worker image is built anywhere in the repository yet (task 36) and nothing was applied |
| **Control API and panel** | A scripted operator walkthrough and its failure drills through the real panel on Chromium (and WebKit for the walkthrough), a sweep of every documented operation for authentication, roles, headers and secrets ([docs/security/phase2-pass.md](security/phase2-pass.md)), and reads on 149,000 jobs over 50 queues (section 10) | Firefox (it would not launch in the build sandbox); any deployed environment; a real OIDC provider; IAP; a container scan; reads on a managed database or on PostgreSQL 16; an independent security review (task 72) |
| **Webhooks** | The store (57 tests), the sender over real sockets and through the tick (a flaky receiver, the backoff schedule, a signature vector, four concurrent ticks, an SSRF matrix with a redirect and a rebinding resolver, TLS against a test CA), the routes and their audit rows, and the panel page on Chromium and WebKit, all on PostgreSQL 18.6 | PostgreSQL 16; a receiver across the internet; a public CA's certificate chain; the resolver and egress of a real VPC (Cloud NAT, a NAT gateway: whether the cloud metadata address and internal names are in fact unreachable from the tick); an independent review of the SSRF defences (task 72) |
| **PgBouncer, TLS and PG 16** | suites written (`connection.pooled`, `maintenance/pooled`, `connection.tls`) | run at the end of the plan, with the Docker profiles |

## 9. Emulator gaps worth knowing

- The Pub/Sub emulator ignores flow control (the `maxHeld` test is a `test.todo`), has no exponential retry backoff, and
  its dead-letter and IAM behavior is not the service's. A green emulator suite says the wiring is right.
- ElasticMQ is not SQS: it says nothing about throughput, latency, IAM, CloudWatch or the bill. The behaviors
  where it is known to differ, each one a place a green emulator suite does not carry over:
  - A **stale receipt handle**: ElasticMQ answers `ReceiptHandleIsInvalid` to a delete and leaves the message;
    real SQS may answer success without deleting. The transport treats a stale handle as harmless either way.
  - **Redrive**: ElasticMQ moves a message to the dead-letter queue as soon as it has been received
    `maxReceiveCount` times; real SQS moves it on the next receive, and counts the dead-letter retention from the
    message's original enqueue time.
  - **Attribute counts** are exact on ElasticMQ and approximate (up to about a minute stale) on SQS. `stats` says so
    in `source`, `observedAt` and `maxStalenessMs`.
  - **Duplicates**: ElasticMQ never duplicates a message; a standard SQS queue is at-least-once. The duplicate-bell
    scenario rings the same bell twice from the producer to cover the result, not the cause.
  - **Short receives**: ElasticMQ fills a receive to 10 when it can; real SQS may return fewer from a sparsely
    populated queue, so a busy worker may do more receives per bell than section 11 says.
  - **Limits** (`DelaySeconds`, batch size) are enforced only with `sqs-limits = strict`, which the test config sets.
  - ElasticMQ has **no CloudWatch**, so `stats` age and the dead-letter metric are tested against a stub client.
- **A bell that beats its own `markRung`.** The claim skips a row another transaction holds (`FOR UPDATE SKIP LOCKED`),
  and right after a ring that transaction is `markRung`, so a bell that arrives at once finds its job locked: an
  empty claim and a spent bell. The worker's one recheck after 25 ms, when a job of the queue is still waiting
  (`packages/sdk/src/workerClaim.ts`, task 20), is the answer, and it holds on SQS: a burst of 50 jobs on ElasticMQ
  (delivery in about a millisecond) needed it for **6 bells**, on three runs, and every job completed with no tick.
  Without the recheck a locked bell leaves its job to the tick's re-ring. Real SQS takes 10 to 30 ms to deliver,
  so it should need the recheck less; **not measured on a real queue**. A consumer that claims on a bell and does
  not recheck depends on the tick.

## 10. Control API reads on a large store (task 37)

`bun run scripts/perf-control-api.ts`: 149,000 jobs over 50 queues (one big queue of 100,000 and 49 of 1,000, each
70 % waiting, 20 % completed and 10 % delayed), the Control API over a loopback socket against PostgreSQL 18.6 on the
same machine, so the database round trip is about a tenth of a millisecond and **a managed database adds its network
round trip to every row below**. Each read is 40 requests in a row after 3 warm-ups, then 40 with 8 callers at once
(what a few open panels look like). The target set in task 31 is **500 ms at the 95th percentile** for a list page; the
script exits non-zero if any read misses it. Seeding took about 1.2 s.

Uncached (the summary cache off, so every request reads the database), serial:

| Read | Size | p50 | p95 | 8 at once, p95 |
| --- | --- | --- | --- | --- |
| Dashboard | 640 B | 17.0 ms | 17.9 ms | 53.1 ms |
| Queues summary | 6.0 KB | 18.6 ms | 20.6 ms | 23.6 ms |
| Dashboard queues, a page of 50 | 3.8 KB | 35.9 ms | 37.1 ms | 64.7 ms |
| Dashboard queues, the big queue | 3.9 KB | 20.3 ms | 24.7 ms | 68.2 ms |
| Stats | 453 B | 17.1 ms | 17.4 ms | 47.5 ms |
| Queue counts, the big queue | 142 B | 12.5 ms | 13.2 ms | 28.2 ms |
| Job list, first page (50 jobs) | 26.3 KB | 19.4 ms | 25.5 ms | 38.4 ms |
| Job list, 500 jobs | 263.6 KB | 22.1 ms | 24.3 ms | 42.2 ms |
| Job list, waiting only (50) | 26.3 KB | 20.9 ms | 23.0 ms | 37.8 ms |
| Job list, offset 50,000 | 26.6 KB | 21.5 ms | 26.0 ms | 41.3 ms |
| Job list, delayed only (50) | 26.9 KB | 14.3 ms | 15.9 ms | 21.5 ms |
| Job list, a small queue (50) | 26.3 KB | 1.0 ms | 1.2 ms | 3.3 ms |
| Dead-letter stats | 132 B | 0.1 ms | 0.2 ms | 0.7 ms |
| Metrics | 95 B | 17.1 ms | 17.5 ms | 49.9 ms |
| Workers | 74 B | 0.2 ms | 0.2 ms | 0.9 ms |
| Crons | 50 B | 0.2 ms | 0.2 ms | 1.0 ms |

**Every read met the target by more than an order of magnitude.** With the summary cache at its default (2 s per
instance) the Dashboard, queue summary, stats and metrics reads answer from memory in about 0.1 ms; the rest are
unchanged. The slowest read is the Dashboard's queue page at 37 ms (it counts every queue on the page).

What this does not say: the figures are one machine, one run of the script, PostgreSQL 18.6 and a loopback database.
Only one volume was run, so how the counts reads grow past 149,000 jobs is not measured. A list page is bounded at
1,000 rows (section 2) and `/dashboard/queues` takes an offset of at most 10,000. The panel's own render time (the
browser) was not measured: the e2e walkthrough proves the pages work, not that they are fast.

## 11. Cost of the doorbell on SQS (task 40)

`packages/transport-aws/test/cost.test.ts` counts the requests the transport sends for 100 jobs against ElasticMQ, one
producer and one consumer process. **These are client-side counts on the emulator**; the count carries over to SQS,
the price does not get measured until the real-account run (D9).

| Worker | Sends | Receives | Deletes | Heartbeats and nacks | Requests per job |
| --- | --- | --- | --- | --- | --- |
| Room for 10 bells at once (concurrency 10) | 10 (a `SendMessageBatch` of 10 is one request) | 78 to 83 | 15 to 19 (100 bells) | 0 | **1.07 to 1.14** |
| One slot (concurrency 1), the worst case | 10 | 101 | 42 to 48 (100 bells) | 0 | **1.55 to 1.61** |

- Deletes are batched (`DeleteMessageBatch`, up to 10 bells, sent when 10 are waiting or 5 ms after the first). A bell is
  deleted a few milliseconds after its ack, and a worker that closes sends what it holds first. Before this the table was
  100 deletes per 100 jobs and 1.94 to 1.99 requests per job (2.13 with one slot). **How many bells share a delete depends
  on how close together the acks are**: a burst of 10 bells is one delete, bells that are acked more than 5 ms apart each
  pay their own. The emulator answers a receive in about a millisecond; real SQS takes longer, so expect fewer bells per
  delete there until the real-account run measures it.
- A receive is demand-driven: it asks for what the worker has free, so a busy worker does about one receive per bell.
  Only an idle worker gets full batches of 10.
- A heartbeat (`ChangeMessageVisibility`) is sent every third of the claim window while a handler runs, and a job claims
  in milliseconds, so none were sent. A `nack(retryInMs)` is one more request.
- A bell that finds an empty claim (a re-ring of a job already running, a paused queue, a rate limit) is one more send
  share, one receive and a delete share: about 1.1 to 2.1 requests.

**Arithmetic.** At the list price of **$0.40 per million requests** (the first million a month free, a payload up to
64 KB is one request; the price tiers down to about $0.24 per million at volume; **the live price page was not
checked**):

| Jobs a month | Requests at 1.6 per job (the one-slot figure; a busy wide worker was 1.1) | List price | After the free million |
| --- | --- | --- | --- |
| 1,000,000 | 1.6 million | **$0.64** | **$0.24** |
| 100,000 | 0.16 million | $0.06 | $0 |

- **Idle polling** is a floor: a long poll of 20 s is 3 requests a minute, about 130,000 a month per subscribed queue
  per worker process, about **$0.05**. Ten worker processes on three queues is 30 subscriptions, about $1.50.
- The dead-letter queue and CloudWatch are not in the table. CloudWatch `GetMetricData` for `stats` is billed
  separately: one call per queue per cache period (60 s by default), and only where `stats` is asked for, which is
  the Control API.
- Per-job request counts have no tick term: the tick rings what the store returns and sends nothing when nothing is due.

**On Pub/Sub (read from Google's docs, not measured).** One topic carries every queue's bells of an environment, and each
queue has a subscription with a filter on the bell's route. For a subscription with a filter Google says the messages
that do not match are acknowledged by Pub/Sub itself with no outbound fee, but "you incur message delivery fees and
seek-related storage fees for these messages"
([subscription filters](https://docs.cloud.google.com/pubsub/docs/subscription-message-filter)). So the delivery cost
of one bell is paid once per queue of the environment, not once: **it grows with the number of queues**, and a queue
added to a busy environment raises the bill of the others. No price is quoted here because the pricing page, with the
rates and the per-request minimum size, could not be read. The first real-account run (D9) is where to measure it.

**A hot queue** (`hot = true` in the Terraform, `QCLOUD_GCP_HOT_QUEUES`, `ensureQueue(…, { hot: true })`) has its own topic
`qcloud.<ns>.hot.<queue>` and an unfiltered subscription of the same name. Its bells are delivered once, not once per queue
of the environment, and the other queues' bells no longer pass through its subscription. The cost is one more topic and
one more publish target per hot queue. Pub/Sub allows 10,000 subscriptions per topic and project: the shared topic
holds the long tail, and a hot queue's own topic holds one. Past about 5,000 queues use another project (not built).
Rolling it out: a subscription cannot change its topic, so a queue is moved by removing its subscription (what it held
is rung again by the tick) and creating it again, and **every process must name the same hot list** or its `ring`
publishes to the shared topic and nobody hears it until the tick re-rings (and the tick must have the list too).
`ensureQueue` refuses to reuse a subscription that is on the other topic. Not measured: the emulator does not bill.

## 12. Webhooks (task 52)

What the delivery path costs and where it stops. The design is in [webhooks.md](webhooks.md). Measured on PostgreSQL 18.6
on one developer machine, Bun 1.4.2; PostgreSQL 16 is owed.

**Measured: the trigger on the job path.** `packages/store-postgres/test/webhook.cost.test.ts`: 8 claimers push, claim and
complete 2,000 jobs in a queue three webhooks watch (pushed, started, completed: nine delivery rows per job) and in a queue
none watch.

| Path | With webhooks, against without |
| --- | --- |
| Claim and complete | about **1.1x** (1.10x and 1.09x in two runs) |
| Enqueue | about **1.6x to 1.8x** (1.61x and 1.83x) |

A queue no webhook watches pays for the trigger's lookup and inserts nothing. The figures are from two runs on one
machine, the enqueue ratio moves between them, and a timing bound would be a flaky test, so the test prints them and asserts
correctness only.

**Derived: what the sender sends.** One pass sends at most `QCLOUD_WEBHOOK_BATCH` (50) deliveries, in chunks of
`QCLOUD_WEBHOOK_CONCURRENCY` (8), and starts no chunk after `QCLOUD_WEBHOOK_BUDGET_MS` (5 s); one webhook gets at most
`QCLOUD_WEBHOOK_RATE_PER_MINUTE` (60) attempts in a fixed minute. A pass can overrun its budget by one request timeout
(10 s). So with a tick every minute (a scheduler-only deployment) the ceiling is **50 attempts a minute for the whole
service**; with the in-process loop at 5 s it is 50 per 5 s, still **60 a minute per webhook**. Raise the batch and the
rate for more, and past operator scale use a delivery queue of your own (webhooks.md, "Volume"). These are arithmetic on
the settings, not a load test. `qcloud-tick send` is not bound by the batch or the budget: it keeps
`QCLOUD_WEBHOOK_CONCURRENCY` requests in flight and refills as they finish, so its ceiling is concurrency divided by the
time of one request (8 in flight at 200 ms a request is about 40 a second), and the per-webhook rate still applies.
That too is arithmetic.

**What this does not promise.**

- **A sustained event rate above the sender's rate grows the backlog** until the 24-hour expiry fails what is left.
  `job.progress` makes that easy: subscribe to it only where updates are rare.
- **A late outcome after a lease lapse is dropped**, so a send can repeat. An attempt that was claimed and never answered
  (a dead sender) counts against the delivery's attempt budget.
- **The claim serialises per webhook** between concurrent claimers (a webhook row is locked while its deliveries are
  taken); with many webhooks the claimers pass each other by (`SKIP LOCKED`).
- **No ordering**, and the body has no job data.
- A **test event** uses the full retry policy: a test to a receiver that is down is retried for 63.5 minutes.
- Registration validates a URL and does not resolve it; a name that points at a private address is accepted and every
  attempt then fails with `destination not allowed`.
- A store error in the sender fails the tick; a failing receiver does not.

## 13. Workflows in the Control API and the panel (task 62)

- **Reads are paged.** A step list is 50 items by default, at most 500 (`maxPageSize`), and an offset of at most 100,000
  (`offset_too_large` past it). A for-each or map is returned as counts by status, `{ iterations, byStatus, compensation }`,
  and its iterations are read through `iterationOf`. A seeded for-each of **10,000 iterations** returns a detail
  response under 50,000 bytes (`packages/control-api/test/workflows.fanout.test.ts`; the browser run is in
  `packages/panel/e2e/workflows.e2e.ts`). **The response is bounded; the read is not.** The counts and the pages are
  made by the Control API from the run's step records, so every request loads the whole run (one record per
  iteration, results included) and makes one pass over it. A run costs time and memory in proportion to its
  iterations on each request: measured on a laptop with Postgres on loopback, one request at a time (median of 7), a run of 1,000 iterations is 107 KB of stored
  steps and answers in 1 ms, 10,000 iterations is 1.1 MB and 5 ms, 50,000 iterations is 5.6 MB and 20 ms, while the
  response stays about 1.2 KB for a detail and 6 KB for a page of 25. These are single-request times, not a throughput
  figure: a panel reads a run again every few seconds for each open tab. The run list does not read steps. The engine
  writes the same record on each step, so a run of hundreds of thousands of iterations is a problem for the engine
  before it is one for the panel.
- **Payloads are cut.** A step's result in a list is cut at **1,024 bytes**, in a detail at **256 KiB**; an error at 2,000
  characters; a run's failure reason at 1,000; at most 50 signals and 100 children are listed. A cut value carries
  `{ "$type": "truncated", kind, length, maxBytes }` and the panel says so. **The panel shows these payloads to every
  `viewer`.** The input, the results and the signal payloads of a workflow are readable by anyone who may open the
  panel: a workflow that carries a secret in its input exposes it there. Keep secrets out of workflow input (pass a
  reference) or do not enable the Workflows page (`QCLOUD_API_WORKFLOWS=false`).
- **A payload can take far more memory decoded than its 1 MiB, and a page is decoded whole.** The cap on encoded bytes
  does not bound it: a payload of one million `null`s is 1 MiB and decoded to about **19 MB**, one of a million empty
  arrays to about 70 MB, and a Control API list page that held 20 of the first kind grew the process by **357 MB** in
  300 ms. So enqueue, a data edit and a completion also refuse a payload or result with more than **20,000** values
  (object keys count) or nesting deeper than **64** (`PayloadTooComplexError`; options `maxPayloadNodes`,
  `maxPayloadDepth`). Measured on the codec: up to 70 bytes of heap a value (empty objects and arrays), 8 for a number
  or a short string, so a payload decodes to at most about 1.4 MB. The list route still decodes every job of a page
  before it cuts each to 1,024 bytes: a page of 500 jobs that each hold the worst case takes about **700 MB**, so keep
  `QCLOUD_API_MAX_PAGE_SIZE` to what the API's memory allows. Jobs enqueued before the limit are not rechecked. Workers
  are not affected (each decodes one payload at a time). Finding F-2 of [the security review](security/review-v1.0.0.md)
  is narrowed, not closed: the number and a lazy list decode are the owner's call.
- **An action is a claim and a publish.** The version fence (`expectedVersion`) is a compare-and-set for `cancel` and
  `recover`; for `signal`, `retry-compensation` and `abandon-compensation` it is a check made before the store's own row
  lock, so a run that moves in between is judged by the store, not by the version. A request body is at most 1 MiB, an
  event name 256 characters, a reason 500. If the publish fails after the claim the answer is 503 `publish_failed` with
  `claimed: true`, and the job is published again by the maintenance tick once the run has been quiet for
  `QCLOUD_WORKFLOW_IDLE_MS` (300,000 ms by default: **five minutes in the worst case**).
- **The tick does not look at `waiting` runs.** A waiting run whose awaited signal is recorded but whose job was lost
  stays waiting until an operator uses `recover` on it (or sends the signal again). A wait that times out is ended by
  the tick as before (section 7).
- **`QCLOUD_WORKFLOW_QUEUE` and `QCLOUD_WORKFLOW_IDLE_MS` must be the same on the Control API, the tick and the
  workers.** A Control API that names another queue publishes jobs nobody consumes; a shorter idle window lets an
  operator take a run an engine is still writing.
- **A definition is "served" while a worker announces it.** A run whose definition hash no worker announced within
  `QCLOUD_API_WORKFLOW_SERVED_MS` is listed with an `unserved_definition` warning, and the panel says "no worker serves
  it" on the definition and the run. The actions are still offered: the job waits on the queue until a worker that has
  the definition starts, and an action on a live run that no worker serves therefore does nothing until then.

## 14. Several databases (shards, review R21)

- **A namespace lives on one database.** The journal lock, the tick lease and the transport names are per namespace, so one
  busy namespace cannot be spread over shards. Several namespaces can.
- **Routing is the map, nothing else.** A namespace the map does not list is refused. Nothing moves a namespace for you.
- **No query crosses shards.** The panel and the Control API show one namespace; a total over all of them is yours to add up.
- **Connections add up per shard**, not across them ([section 4](#4-connections)): each shard has its own budget.
- **One loop per namespace, one pool per shard.** `QCLOUD_SHARD=a qcloud-tick loop` runs its namespaces' loops in one
  process, so hundreds of busy namespaces on a shard want several processes.
- **Tested** on two schemas of one Postgres standing in for two databases: a queue writes only to its namespace's shard,
  `migrate` names each shard, and one loop ticks two namespaces over one pool and leaves the other shard alone.
  **Not run** on two real database servers and **not measured** under load, so the gain is a design property, not a number.
