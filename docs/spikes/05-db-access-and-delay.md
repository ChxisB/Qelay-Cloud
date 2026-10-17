# Spike 05: database access and delay precision

- **Task:** [05](../../.claude/.planning/v1.0.0/05-spike-db-access-and-delay.md), run on 2026-10-13.
- **Spike code:** `packages/store-postgres/spike/db-access/` (deleted in task 20, see the [gate](06-phase0-gate.md), "The tick as built"), on top of the
  task 01 port and task 03's doorbell sweep. Task 06 promoted it, and task 11 moved it: the connection code is in
  [`src/connection/`](../../packages/store-postgres/src/connection/), the fault proxy and pooler helpers are in
  [`test/support/`](../../test/support/), and the suites that checked the driver are in
  [`packages/store-postgres/test/connection.*.test.ts`](../../packages/store-postgres/test/). The links below name the new
  places. `claimPath`, `fleet` and `tick` stayed in `spike/db-access/` until task 20 deleted them; the tick is `packages/maintenance` and its numbers were measured again there.
- **Environment:** Postgres 16 from `docker-compose.test.yml` (`max_connections=200`), PgBouncer 1.26.0 (opt-in `pgbouncer`
  profile), a TLS-capable Postgres 16 (opt-in `tls` profile), Bun 1.4.2 with `Bun.SQL`. All on loopback, one machine.
- **Not run: anything in a cloud account** (D9). No Cloud SQL, RDS, RDS Proxy, Cloud Tasks, Cloud Scheduler or
  EventBridge. Every cloud statement below is tagged **documented** (from the vendor's docs, not run) or **not verified**.
  Statements tagged **measured** were run in this spike, locally.

## Verdict

1. **Default per-process pool: 2 connections. Worker `concurrency` is not in the connection formula.** The SDK holds a
   connection for one statement or one short transaction, never while user code runs. Measured: 50 concurrent jobs on one
   pool of 2 never held more than 2 server connections. Connections scale with **processes**, not jobs.
   See [Connection budget](#connection-budget).
2. **Hitting the cap is a hard failure, not a queue.** Direct to Postgres, connections beyond `max_connections` (or a
   role's `CONNECTION LIMIT`) fail with SQLSTATE `53300`. Behind a transaction pooler the same load queues and succeeds.
   Cap the fleet in the deployment (max instances x pool), and use a pooler when that product exceeds the instance.
3. **A transaction-mode pooler works with the SDK, with three configuration rules.** Measured against PgBouncer: the
   ported claim and complete path ran 200 jobs across 4 claimers exactly once each. The rules:
   `prepare: false` (or a pooler with `max_prepared_statements > 0`), no session-timeout startup parameters, and the
   schema and timeouts set on the **role**, not by `search_path` in the connection. See [Pooling](#pooling).
4. **The ported code is pooler-safe by construction.** It takes only transaction-level advisory locks and issues `NOTIFY`
   inside transactions. It takes no session-level lock and never `LISTEN`s. The one thing that must **not** go through a
   transaction pooler is a `LISTEN` connection (`QueueEvents`, the `local` transport). One caveat for RDS Proxy only:
   grouped-job admission calls `nextval`, which RDS Proxy documents as a pinning event
   ([RDS Proxy and the ported code](#rds-proxy-and-the-ported-code)).
5. **`Bun.SQL` 1.4.2 has no bound on a silent connection.** A query on a connection that goes quiet (packets dropped by a
   failover, a dead NAT mapping) never settles, `cancel()` does not help, and `close()` without a timeout never returns.
   The task needs a deadline wrapper (`ResilientPool` in the spike) plus `maxLifetime` as a backstop. Resets and refusals
   are handled well by the driver. See [Driver behaviour](#driver-behaviour).
6. **Delay and tick: no Cloud Tasks relay in v1.0.0. Ship an opt-in in-process tick for always-on workers, leader by lease
   row, not by advisory lock.** The in-process tick fixes delay, retry backoff and rate-limited queues together, which the
   relay does not, and needs no new cloud resource or IAM. Cloud Scheduler stays as the safety net. See
   [Delay and tick](#delay-and-tick).

**One open question changes item 6:** worker hosting (DESIGN.md open question 1). With scale-to-zero push handlers there
is no always-on process to tick, and the relay becomes the only way to get second-level delay precision on GCP.

## Connection budget

### Formula

```text
application = sum over process kinds of  count x (pool + listen)
direct      = application + reserved                       (max_connections needed, no pooler)
pooled      = poolerPoolSize + listeners + reserved        (server connections behind a transaction pooler)
```

| Term | Meaning | Default |
|---|---|---|
| `pool` | Connections one SDK process may open: claim, heartbeat, settle, event writes | **2** |
| `listen` | One dedicated `LISTEN` connection per `QueueEvents` consumer (cannot use a transaction pooler) | 0, or 1 |
| process kinds | workers, `QueueEvents` consumers, Control API and tick processes (default 2 API + 1 tick) | |
| `reserved` | `superuser_reserved_connections` (3) plus a migration, monitoring and an operator | 6 |
| `poolerPoolSize` | Server connections the pooler may open per database-and-user pair | 20 |

Computed by [`budget.ts`](../../packages/store-postgres/src/connection/budget.ts) and printed by
[`scripts/connection-budget.ts`](../../scripts/connection-budget.ts) (`bun scripts/connection-budget.ts`):

| Worker processes | pool 2 (default) | pool 5 | pool 10 | pool 2 + 1 listener per 10 workers | behind a pooler (20) |
|---|---|---|---|---|---|
| 10 | **32** | 71 | 136 | 33 | 26 |
| 50 | **112** | 271 | 536 | 117 | 26 |
| 200 | **412** | 1,021 | 2,036 | 432 | 26 |

What those numbers mean for an instance (**documented**; `max_connections` defaults by size, check the current page):

- **Cloud SQL for PostgreSQL** defaults: 25 (0.6 GB shared core), 50 (1.7 GB), 100 (3.75 to under 6 GB), 200 (6 to under
  7.5 GB), 400 (7.5 to under 15 GB), 500 (15 to under 30 GB), 600, 800, 1,000 above that. 200 worker processes
  at the default pool need 412, so a 15 GB instance, or a pooler.
- **RDS for PostgreSQL** default `LEAST(DBInstanceClassMemory / 9531392, 5000)`: at most about 112 for 1 GiB, 225 for
  2 GiB, 450 for 4 GiB, 901 for 8 GiB (an upper bound: the memory RDS reports is below the nominal size).
  Small RDS instances run out at around 50 processes.

### Why 2

- It is enough: concurrency 50 on a pool of 2 claimed 200 jobs at p50 70 ms and p99 231 ms (loopback). Each statement is
  short, so two connections pipeline many in-flight jobs.
- Upstream Qelay defaults to 4 for one long-lived server. The cloud SDK runs as many small processes, and the budget is
  the product, so the per-process default is halved. It is a setting (`poolSize`), not a constant.
- A pool of 1 would serialise the lease heartbeat behind a claim. A pool of 2 keeps a connection free for it. This is
  reasoning, not a measurement.

### Measured: a fleet of worker processes

Real processes (`fleetWorker.ts`, one `bun` process each) running the ported claim and complete path, 5 concurrent jobs
each. Peak is server connections of the fleet's role from `pg_stat_activity`, sampled every 20 ms.
Latencies are loopback and the table was produced by the fleet suite on its own: **compare rows, do not quote them as
absolute numbers.** (Run in parallel with the other suites, p50 and p99 rose 6 to 14 times for the direct rows and the
connection counts did not change.)

| Scenario | Peak server connections | Formula | Claim p50 / p99 | Errors |
|---|---|---|---|---|
| 10 workers x pool 2, direct, 300 jobs | **20** | 20 | 15.7 / 120 ms | 0 |
| 50 workers x pool 2, direct, 1,000 jobs | **100** | 100 | 67 / 638 ms | 0 |
| 50 workers x pool 2, behind PgBouncer (pool 10), 1,000 jobs | **10** | 10 | 369 / 546 ms | 0 |
| 1 worker, pool 2, **concurrency 50**, 200 jobs | **2** | 2 | 70 / 231 ms | 0 |
| 200 pools x 2 against a role limit of 40, direct, 400 operations | 40 | | | **326 to 336 of 400 operations failed, SQLSTATE 53300** (64 to 74 settled) |
| the same 200 pools behind PgBouncer (pool 10) | 10 | | | 0, all 400 settled |

Reading the table:

- **The measured peak equals the formula** for 10 and 50 workers, direct and pooled.
- **The pooler trades latency for connections.** Claim p50 goes up about 5 times on loopback, because 100 client
  connections share 10 server connections. The p99 is no worse (546 against 638 ms), because the pooler queues instead of the database
  context-switching 100 backends. On a real network the pooler adds one hop on top.
- **At the cap, direct fails, pooled queues.** 53300 `too_many_connections` is raised at connect time. The SDK cannot
  retry its way out of it, because the whole fleet is retrying. See [Findings](#findings-for-other-tasks) for the rule.

## Pooling

### What breaks behind a transaction pooler

Measured against PgBouncer 1.26.0 in `pool_mode = transaction`, Postgres 16, `Bun.SQL` 1.4.2
([`connection.pooler.test.ts`](../../packages/store-postgres/test/connection.pooler.test.ts)). Two PgBouncer instances differ
only in `max_prepared_statements`: 200 and 0.

| Primitive | Behind the pooler | Consequence for the SDK |
|---|---|---|
| Named prepared statements (`Bun.SQL` default) | **Fail** with `max_prepared_statements = 0`: `prepared statement "..." already exists`, 30 of 40 statements over 4 connections (`ERR_POSTGRES_SERVER_ERROR`). Work with 200. | Set `prepare: false`, or require a pooler with `max_prepared_statements > 0`. The failure is loud. |
| Session timeouts as startup parameters (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) | **Rejected** at connect: `unsupported startup parameter`. | The spike's `spikeContext` (upstream's session limits) cannot be used. Put them on the role. |
| `search_path` as a startup parameter | **Accepted but not applied reliably.** Three clients a, b, a on one server connection saw a, b, **b**. `track_extra_parameters` did not fix it. | Never rely on it behind a pooler. Schema-qualify, or `ALTER ROLE ... SET search_path`. |
| `ALTER ROLE ... SET` (`search_path`, `statement_timeout`) | **Reaches every pooled connection.** | The supported way to set session defaults. |
| Session `SET` | **Leaks** to the next client of the same server connection. | Never use plain `SET`. `SET LOCAL` inside a transaction does not leak (measured). |
| Session advisory lock (`pg_try_advisory_lock`) | **Two holders at once** (direct: the second is refused). | Never use for leader election or mutual exclusion. |
| Transaction advisory lock (`pg_advisory_xact_lock`) | **Excludes correctly** across clients. | Safe. This is all the ported code uses. |
| `LISTEN` | **Subscribes "successfully" and never receives anything.** Silent. | `QueueEvents` and the `local` transport need a direct connection. |
| `NOTIFY` | **Reaches direct listeners.** | Safe inside a transaction. The ported code does exactly that. |
| Lease-row upsert (the in-process tick's election) | **Works** through the pooler. | Preferred leader election. |

### Which SDK features depend on pooler-sensitive primitives

From the ported code (`packages/store-postgres/spike/ported/`, searched for locks, `NOTIFY`, `LISTEN`, `SET` and
prepared statements):

| SDK feature | Primitive | Pooler status |
|---|---|---|
| Claim, complete, fail, retry, DLQ | `FOR UPDATE SKIP LOCKED` in short transactions, `pg_advisory_xact_lock*` | **Safe** |
| Groups, batch admission, flow failures, dependency promotion, queue lifecycle, event retention, schema initialisation | `pg_advisory_xact_lock*`, `pg_try_advisory_xact_lock*` | **Safe** |
| Event journal commit sequencer | Deferred trigger under `pg_advisory_xact_lock` | **Safe** |
| Event publication | `NOTIFY` inside the transaction (`tx.notify`) | **Safe** |
| Event **consumption** (`QueueEvents`, `local` transport) | `LISTEN` | **Needs a direct connection** |
| Upstream's session limits (`statement_timeout`, `lock_timeout`, idle-in-transaction) | Startup parameters | **Rejected**. Move to the role. |
| In-process tick leader | (spike) lease row | **Safe**. A session advisory lock would not be. |
| Anything that wants `SET` or `SET search_path` | Session state | **Do not use** |

**The one design consequence:** the event-consumer connection is a separate, direct connection with its own URL. It is
not in the pool. That is also why the budget has a separate `listen` term.

### Options per cloud

| | Where it sits | Pooling | TLS and auth | Fit | Cost |
|---|---|---|---|---|---|
| **GCP: Cloud SQL connector / Auth Proxy** | In the process or as a Cloud Run socket (`/cloudsql/<instance>`) | **None.** It is a secure tunnel, not a pool | TLS and IAM database auth handled for you | Direct, so everything works, at `direct` connection counts | No extra charge (**documented**) |
| **GCP: Cloud SQL managed connection pooling** | In front of the instance (**documented**) | Transaction mode (the default) or session mode. **Enterprise Plus edition only**, Auth Proxy 2.15.2 or later, and enabling it restarts the instance (**documented**) | Same as direct | Follows the table above. **Documented** unsupported in transaction mode: `SET`/`RESET`, `LISTEN`, `PREPARE`, session advisory locks. `max_prepared_statements` defaults to **0**, `max_pool_size` to 50 per database and user pair | Edition price. The page states no separate charge (not verified) |
| **GCP: PgBouncer sidecar** | A container beside each Cloud Run instance | Only inside the instance. With a pool of 2 per process it **pools nothing** | You configure it | Poor: reduces nothing at pool 2 | A container per instance |
| **GCP: PgBouncer shared service** | GCE, GKE or Cloud Run service in front of the database | Fleet-wide, transaction mode | You configure TLS to the database and to clients | As measured here, exactly | A VM or service, an HA story, one more hop |
| **AWS: RDS Proxy** | Managed, between the app and RDS or Aurora | Multiplexing, with **pinning** (**documented**): after a pinning event the client connection keeps one database connection until it ends. For PostgreSQL: `SET`/`set_config`, `PREPARE`/`DEALLOCATE`/`EXECUTE`, `LISTEN`, **`nextval`/`setval`**, session advisory locks (not transaction-level ones), temp objects, cursors and any statement over 16 KB | IAM auth and TLS (**documented**) | Works if the SDK never pins. See [RDS Proxy and the ported code](#rds-proxy-and-the-ported-code) | Per vCPU of the database (**documented, not verified**) |
| **AWS: PgBouncer on ECS** | Service in the VPC | As the GCP shared service | You configure | As measured here | A task, an HA story |

### Recommendation

- **Direct, pool 2, is the default on both clouds.** At the sizes the first release targets (tens of worker processes) the
  budget is 30 to 120 connections, which a single mid-size instance serves. It has the fewest moving parts and every
  primitive works.
- **Switch to a pooler when `direct` exceeds about 80% of `max_connections`**, not before. On GCP, managed pooling is
  **Enterprise Plus only**, so for the other editions the pooler is a shared PgBouncer service. On AWS use RDS Proxy,
  after a real run confirms what pins (below). A per-instance PgBouncer sidecar is not worth it at pool 2.
- **Make the SDK pooler-compatible by configuration**, not by auto-detection: a `pooler: 'transaction'` setting that sets
  `prepare: false`, drops startup parameters and requires a separate direct URL for `LISTEN`.

### RDS Proxy and the ported code

The RDS Proxy pinning list (**documented**) matches the table above except in two places, and one is a finding:

- **`nextval` pins.** The ported admission path calls `nextval('qcloud_group_order_seq')` inside the insert for every
  job that has a `group_id` (`admission.ts`, `batchAdmission.ts`). PgBouncer does not care: a sequence is global state, not
  session state (the claim path ran through it). RDS Proxy may pin the client connection on first use, after which it
  holds one database connection until the client disconnects. **Worst case it degrades to the `direct` numbers for
  processes that enqueue grouped jobs. It is a capacity effect, never a correctness one.** `BIGSERIAL` defaults do not
  appear in the statement text, so they are less likely to be detected (**not verified**). The group order can be
  allocated without a sequence call: `groupClaims.ts` already advances `group_sequence` in `qcloud_queue_state`.
- **`prepare: false` is not proven to avoid pinning.** The docs list `PREPARE`, `DEALLOCATE` and `EXECUTE` **commands**.
  They do not say what Parse and Bind messages do, named or unnamed. **Not verified.**
- The proxy's **initialization query** can carry the role's `SET`s once for every new database connection, so session
  defaults need not pin. Role-level `ALTER ROLE ... SET` also works there.
- Statements over 16 KB pin. A bulk insert that inlines large payloads in the statement text would; parameters do not
  count as statement text (**not verified**).

## Driver behaviour

### TLS and authentication

Measured against Postgres 16 with a self-signed certificate
([`connection.tls.test.ts`](../../packages/store-postgres/test/connection.tls.test.ts) and
[`connection.socket.test.ts`](../../packages/store-postgres/test/connection.socket.test.ts)):

| Setting | Result |
|---|---|
| No TLS option | **Plaintext, even when the server offers TLS.** Confirmed with `pg_stat_ssl`. |
| `tls: true`, or `?sslmode=require` | Encrypted, **nothing verified** (any certificate accepted). |
| `tls: { ca }` with the server's CA | Encrypted, chain and hostname verified. |
| `tls: { ca }` with an unrelated CA | Fails. |
| `tls` with no `ca`, verification on | Fails. |
| `tls: { ca, serverName: 'wrong' }` | Fails. The hostname failure is an `Error` with an **empty message**, errno 0 and no code. Handle it by catch-all. |
| `checkServerIdentity` | **Ignored.** |
| `password: () => string` (sync or async) | **Called for every new connection**, including reconnects. A fresh IAM token can be minted this way. A rejected password is a server error, not a hang. |
| Unix socket, `path` option (a directory or the `.s.PGSQL.5432` file) | Works. This is the Cloud Run `/cloudsql/<instance>` shape. `?path=` in the URL works too. |
| libpq-style `?host=/dir` | **Silently read as a TCP host** and refused. Do not use it. |

What this means:

- The SDK must pass `tls: { ca }` (or the equivalent URL option) explicitly. The driver default is not secure.
- For IAM auth the SDK passes `password` as a function. It works, and it is called per connection. Token caching is the
  SDK's job.
- **Not verified (needs D9):** Cloud SQL's server certificate against `Bun.SQL`'s hostname verification. Cloud SQL server
  certificates have historically carried the instance name in the CN only, which a verifier that requires a SAN rejects.
  The connector and the Cloud Run socket sidestep this, because the proxy terminates TLS. Direct TLS needs a real run.
- **Not verified (needs D9):** IAM database authentication end to end, managed pooling, RDS Proxy.

### Failure behaviour

Measured through a loopback TCP proxy that can reset, refuse and blackhole
([`connection.driver.test.ts`](../../packages/store-postgres/test/connection.driver.test.ts),
[`connection.fault.test.ts`](../../packages/store-postgres/test/connection.fault.test.ts),
[`tcpProxy.ts`](../../test/support/tcpProxy.ts)):

| Fault | What `Bun.SQL` does | Needs |
|---|---|---|
| Connections reset while idle | **Invisible** to the next query if the pool has seen the close (about 20 ms). A query in the **same instant** fails once with `ERR_POSTGRES_CONNECTION_CLOSED`. | One retry, for idempotent operations |
| Connection reset mid-query | That query fails with `ERR_POSTGRES_CONNECTION_CLOSED`, in under 1.5 s. Nothing else is affected. | Outcome unknown: the SDK's lease- and token-guarded writes are safe to retry |
| Database down (refused) | Fails fast (under 500 ms, `ERR_POSTGRES_CONNECTION_REFUSED` or `_CLOSED`). The **same pool recovers** when the database is back. | Backoff in the worker loop |
| **Silent stall (packets dropped)** | **A query on it never settles.** `cancel()` does nothing. A server-side `statement_timeout` is irrelevant (the server never sees the statement). Removing the fault does not unstick it. `close()` without a timeout hangs. | A deadline wrapper |
| `maxLifetime` | An age-based backstop: after it, the stuck query errors with `ERR_POSTGRES_LIFETIME_TIMEOUT` and the pool recovers. | Set it (for example 5 minutes) |
| `idleTimeout` | Reaps an idle connection. The next query opens a new one. | Set it below any NAT or proxy idle limit |
| `close({ timeout })` | Returns in about 1 s even on a stalled connection. | Always pass a timeout |

**The stall is the finding that matters.** It is the shape of a Cloud SQL HA failover that drops packets, and of a
NAT mapping that expired under an idle connection. A worker that hangs there does not heartbeat and does not fail:
it looks alive, and its lease expires under a job that is still "running".

`ResilientPool` ([`resilient.ts`](../../packages/store-postgres/src/connection/resilient.ts)) bounds it:

- every operation runs under a deadline and fails with `OperationDeadlineError` (`OPERATION_DEADLINE`);
- a deadline that fires **retires** the pool (once, however many operations hit it together), opens a fresh one and
  closes the old with `{ timeout }`;
- the caller treats the error as "outcome unknown", like a lost response.

Measured: with a stalled connection the deadline fires and the next call works on the new pool, and 8 concurrent
operations that all hit the deadline retire the pool once. Use it with a deadline of a few seconds per statement or transaction. The backstop under it is
`maxLifetime`, not a replacement for it.

### Restart

A Postgres container restart under load (a probe, not a committed test): operations in flight failed, 0 to 2 per run,
inside a window of about 1 to 1.5 s, and the pool then recovered with no intervention. This is a **restart**, not an HA
failover. **Not verified (needs D9):** Cloud SQL or RDS failover timing and whether it resets or stalls. Plan on the
stall.

## Delay and tick

### The three options

| | Precision (lateness of a delayed job) | New moving parts | IAM | Cost | Works with scale-to-zero |
|---|---|---|---|---|---|
| **A. Tick only** (Cloud Scheduler, 1 minute) | U(0, 60 s) plus the tick's run time: mean about 30 s, max about 60 s, never early | None | Scheduler to the tick endpoint (already needed) | Negligible | Yes |
| **B. Cloud Tasks relay** | Seconds (the task fires at `scheduleTime`) | A Cloud Tasks queue, a relay target that publishes the bell, task names for de-duplication, a second path to keep consistent with `run_at` | Enqueuer needs `cloudtasks.enqueuer`, the queue needs an identity that can publish or an OAuth token for a Google API | **Documented:** a billable operation is an API call or a push delivery attempt, so about 2 per delayed job. $0.40 per million after 1 million free per month. Payload is metered in 32 KB chunks | Yes |
| **C. In-process tick** on always-on workers, leader by lease row | `interval` plus the tick's run time, a mean of about half the interval plus about 100 ms. 500 ms: mean 343, max 577. 2 s: mean 1,190, max 2,066 | One lease row, one timer in each worker | None | One cheap query set per interval, from one leader | **No** |

Measured for C (the spike's `tick.test.ts`, since deleted; task 20's numbers for the real loop are in the [gate](06-phase0-gate.md)):

| Interval | Lateness mean (model T/2) | p50 | p95 | max | Tick duration |
|---|---|---|---|---|---|
| 500 ms | 343 ms (250) | 362 | 554 | 577 | 7 ms |
| 2,000 ms | 1,190 ms (1,000) | 1,134 | 2,024 | 2,065 | 6 ms |

- **Never early**, which is the property that matters: `run_at` is a floor.
- The offset of about 100 ms is the harness (clock sampling and the doorbell round trip), not the tick.
- **Takeover after a leader crash:** about 1.02 to 1.04 s after the last renewal with a 1 s lease. That is the lease
  length. A graceful stop releases the lease and a follower leads within one tick.
- The election was measured both direct and through PgBouncer, and is identical.

**B was not prototyped.** There is no Cloud Tasks emulator worth trusting for timing, and no account (D9). The figures
for B are **documented** (read 2026-10-13): a task can be scheduled up to 30 days ahead, a queue is limited to 500 tasks
per second (fixed, more queues for more), a deleted task's name is refused for up to 24 hours, and a task is at most
1 MiB. A relay for delays beyond 30 days would need the tick as well.

### Why C beats B for v1.0.0, and what it does not do

Task 03 found **three** paths that wait for the tick on GCP (no per-message delay on Pub/Sub): rate-limited queues, retry
backoff and lease recovery. The relay fixes only delay, and retry if the worker also creates a task for it. The
in-process tick fixes all three at once, with the same sweep that Cloud Scheduler already runs, and needs nothing new in
the cloud.

What C does **not** do:

- It does nothing without an always-on process. Under scale-to-zero push handlers there is no ticker.
- It is an efficiency device, not a correctness one. The tick is idempotent and safe to run concurrently
  (DESIGN.md), so two leaders after a lease expiry or a bug do duplicate work, not damage.
- Cloud Scheduler's 1-minute tick **stays**: it is the floor when every worker is down, and the only thing that
  recovers jobs then.

### Recommendation for v1.0.0

1. **No Cloud Tasks relay.** Keep it out of `transport-gcp` and out of the Terraform. Record it as the answer if D1 closes
   as scale-to-zero push handlers, where it is the only way to second-level delay.
2. **Cloud Scheduler tick at 1 minute: required**, as designed.
3. **In-process tick: opt-in, off by default, recommended for always-on pull workers.** Interval default 5 s
   (a tick takes about 7 ms), lease TTL about 3 intervals so one slow tick keeps it, leader by **lease row with the
   database clock**, never a session advisory lock. Document 1-minute precision as the default and seconds as the opt-in.
4. **Cron stays at the 1-minute floor** unless the in-process tick is on, in which case it catches up per tick as
   designed.
5. Say plainly in the docs: delay precision is `max(tick interval, broker delay granularity)` and never early.

## Findings for other tasks

- **Task 06 (gate), D1 worker hosting.** Items 5 and 6 of the verdict depend on it. Always-on pull workers get seconds
  precision for free. Scale-to-zero gets 1 minute, or the relay. Close D1 with that in view.
- **Task 06, DESIGN.md section 7.** "Cloud SQL, accessed through the Cloud SQL connector or a pooler" should say that the
  connector is not a pooler, and give the budget formula. Risk "Connection pressure" is **reduced**: measured and bounded.
- **Task 11 (schema).** Create one role per deployment with `ALTER ROLE ... SET search_path` and the statement,
  lock and idle-in-transaction timeouts. Schema-qualify names in migrations. Table prefix stays `qcloud_*`.
- **Task 13 and 14 (store).** The connection-level `statement_timeout`, `lock_timeout` and
  `idle_in_transaction_session_timeout` of `spikeContext` must not be startup parameters. Use role-level settings, and
  `SET LOCAL` inside a transaction where a statement needs a tighter value.
- **Task 17 (transport-gcp) and 19 (SDK).** `QueueEvents` and the `local` transport take their own direct `listenUrl`.
  Wrap the pool in the deadline wrapper, and set `maxLifetime`, `idleTimeout` and `close({ timeout })`.
  An `OperationDeadlineError` and a same-instant `ERR_POSTGRES_CONNECTION_CLOSED` are retried once, because every write
  is lease- or token-guarded.
- **Task 19 (worker).** Surface connection-cap errors (SQLSTATE `53300`) as a distinct, non-retried startup error with
  the formula in the message. Do not retry-storm: the whole fleet is retrying.
- **Task 20 (tick).** Implement the lease row, with the database clock and `expires_at`, in the schema. Run it from an
  opt-in in-process loop and from the Cloud Scheduler endpoint through the same sweep. Both must be safe when
  concurrent.
- **Task 21 (infra).** Expose `max_instances x pool` as a computed budget and fail the plan when it exceeds
  `max_connections - reserved`. Mount the Cloud SQL socket on Cloud Run. Optional shared PgBouncer behind a variable.
- **Task 12 (enqueue).** Grouped-job admission calls `nextval('qcloud_group_order_seq')` per job. Decide whether to keep
  it (PgBouncer and direct are fine) or allocate from `qcloud_queue_state.group_sequence`, which RDS Proxy would not pin.
- **Task 42 (AWS infra).** RDS Proxy pinning must be measured before it is recommended as the default: `nextval`, and
  what Parse and Bind do with `prepare: false`. Fall back to a shared PgBouncer on ECS if it pins.
- **Task 21 (GCP infra), edition.** Managed pooling needs Cloud SQL Enterprise Plus. For the other editions the pooler is
  a shared PgBouncer, which is a service to run and an HA story to write. Budget for that in the Terraform, or size the
  instance for `direct`.

## What ran, what did not

| Step | Status |
|---|---|
| 1. Connection budget and default cap | Done. Formula, generated table, default 2. |
| 2. Pooling options per cloud | Done as analysis. **Measured** against PgBouncer only. Cloud SQL managed pooling and RDS Proxy are **documented, not run**. |
| 3. `Bun.SQL` over TLS, auth, failover | **Local only.** TLS, unix socket, password function, reset, refuse, stall and restart measured. Cloud SQL, RDS, IAM auth, HA failover **not run (D9)**. |
| 4. Measured fleet test on a real instance | **Not run (D9).** Local fleet of up to 50 processes against Postgres 16 and PgBouncer instead. |
| 5. Delay relay | **Analysis and documented figures only.** Cloud Tasks not prototyped. |
| 6. In-process tick with leader | Done locally, direct and pooled. |
| 7. This document | Done. |

Nothing was created in any cloud account. Local containers (Postgres, PgBouncer x2, TLS Postgres) are the ones from
`docker-compose.test.yml`. Roles and schemas the suites create are dropped by the suites.

## Reproduce

```bash
docker compose -f docker-compose.test.yml --profile pgbouncer --profile tls up -d --wait \
  postgres pgbouncer pgbouncer-noprep postgres-tls
QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PGBOUNCER=1 QCLOUD_REQUIRE_TLS=1 \
  bun test packages/store-postgres/test/connection
bun scripts/connection-budget.ts
```

Without the `QCLOUD_REQUIRE_*` variables the suites skip with a warning when their service is down. The fleet suite takes
about 40 s and spawns up to 50 `bun` processes.

## Sources

The pages the **documented** figures come from. Fetched on 2026-10-13: Cloud SQL managed connection pooling, Cloud Tasks
quotas, Cloud Tasks pricing (through a search summary) and RDS Proxy pinning. The rest (`max_connections` tables, Cloud
Scheduler, EventBridge Scheduler, Cloud SQL connector behaviour) were not re-fetched when this was written. Limits,
defaults and prices change: re-check before relying on any of them.

- Cloud SQL for PostgreSQL: [database flags (`max_connections`)](https://cloud.google.com/sql/docs/postgres/flags),
  [connection overview](https://cloud.google.com/sql/docs/postgres/connect-overview),
  [managed connection pooling](https://docs.cloud.google.com/sql/docs/postgres/managed-connection-pooling),
  [connect from Cloud Run](https://cloud.google.com/sql/docs/postgres/connect-run).
- Cloud Tasks: [quotas and limits](https://docs.cloud.google.com/tasks/docs/quotas),
  [pricing](https://cloud.google.com/tasks/pricing).
- Cloud Scheduler: [cron job schedules](https://cloud.google.com/scheduler/docs/configuring/cron-job-schedules).
- Amazon RDS: [`max_connections` for RDS for PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html),
  [RDS Proxy pinning](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-pinning.html).
- EventBridge Scheduler: [schedule types](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html).
- PgBouncer: [configuration reference](https://www.pgbouncer.org/config.html) and
  [features](https://www.pgbouncer.org/features.html), version 1.26.0 (the version run here).
- PostgreSQL 16: [`ALTER ROLE`](https://www.postgresql.org/docs/16/sql-alterrole.html),
  [advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS),
  [`NOTIFY`](https://www.postgresql.org/docs/16/sql-notify.html).
