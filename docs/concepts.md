# Concepts

The few ideas that explain how Qelay-Cloud behaves, and why a delayed job can be a minute late on one deployment and
a quarter of a second late on another. Read them once and the rest of the documentation follows. The proofs and the
numbers are in [limits.md](limits.md); the full design is [DESIGN.md](../DESIGN.md).

## Postgres holds the jobs; the cloud queue rings a bell

A job is a row in Postgres. Its state (waiting, delayed, active, completed, failed), its attempts, its lease, its flow and
its history are columns and rows, and every change to it is a transaction. The cloud queue (Pub/Sub or SQS) holds no job
state at all. It carries a **doorbell**: a message that says only "a job may be waiting in this queue". A worker that hears
a bell asks Postgres for the next job in queue order and takes a lease on it.

Why not put the jobs in the cloud queue? Because the things an operator needs once a job exists cannot be done to a message:
promote a delayed job, change its priority, cancel it, find it by id, count jobs by state, let a flow parent wait for its
children. Postgres can do each in a statement, and the panel's lists and counts are consistent reads, not projections.

Why have a cloud queue at all? It wakes workers without polling, it scales Cloud Run or ECS on its depth, it redelivers and
dead-letters poison messages by itself, and it reports depth and age to the cloud's alarms. The `postgres` transport has
no broker: workers poll the database. That is the right choice for development and tests, and the only one that needs no
cloud account.

Three consequences you will meet:

- **Bells are fungible.** A worker need not receive the job a bell named; it takes the next job by priority and order.
  Priorities, groups, rate limits and concurrency stay in SQL.
- **A lost, duplicated or late bell is harmless.** A bell that finds nothing to claim does nothing, and a job whose bell
  was lost is rung again by the tick. A failed publish never fails `queue.add`: the job is stored first, rung after the
  commit.
- **The cloud dead-letter queue holds poison bells only.** It is a metric to alert on, never a place to replay from. A job
  that failed for good is in Qelay's own dead-letter queue, a row you can list in the panel.

## A job's life

```
add ──► waiting ──► active ──► completed
          ▲           │
          │           ├─ fails, attempts left ──► delayed (the backoff) ─┐
          └───────────┼──────────────────────────────────────────────────┘ rung when due
                      └─ fails, attempts used up ──► dead-letter queue
```

A job added with a `delay` starts as `delayed` and joins the same loop when it is due.

- **Add** stores the job, then rings. A `delay`, a `priority`, a `deduplication` key, a `group` are options of the job and
  columns of its row.
- **Claim** takes the next job in queue order and a **lease**: a token and a deadline. A worker renews its lease while the
  processor runs, and a processor receives an `AbortSignal` that aborts when the lease is lost.
- **Complete or fail** is one transaction, applied only if the caller still holds the lease. A worker that stalled and lost
  its lease cannot complete a job someone else now runs. That is the fence: **a job is settled only by the holder of its
  current lease.**
- **Retry** follows `attempts` and `backoff`. An attempt is counted when it ends without success, by failure or by lease
  recovery, never when it is claimed. When attempts run out the job moves to the dead-letter queue with the reason
  `max_attempts_exceeded`. Retrying a dead letter by hand is [not supported in v1.0.0](unsupported.md).
- **Delivery is at least once.** A lease that expires while a job runs hands the job to another worker, so **a handler must
  be idempotent**. Webhooks are at least once too: the receiver deduplicates on `X-Webhook-Id` ([webhooks.md](webhooks.md)).

## The maintenance tick

Something must ring the jobs that are not ready when they are added, and repair what a failure left behind. That is the
**tick**: one idempotent function that is safe to run concurrently with itself. Each run does:

- **Lease recovery.** A job whose worker died is claimable again after its lease, with the attempt counted.
- **Cron.** Due entries create their job and advance their next run in one transaction.
- **Due jobs.** A delayed job or a retry whose time has come is rung. If the transport can hold a bell for a delay (SQS up to
  15 minutes), the tick rings it ahead of time and the broker delivers it on time.
- **Re-ring.** Every claimable job whose last bell is older than `reRingAfterMs` is rung again, with a cap per queue per tick
  so a backlog does not become a bell storm, and a grace period for a bell still in flight.
- **Expiry and retention.** Jobs past their TTL expire, and old completed jobs, events, completion records and group state are cleaned up by the rules of the queue.
- **Workflows.** Waits that have ended are finished and runs whose engine died are taken over ([Flows and workflows](#flows-and-workflows)).

Two things run it, and you choose:

| Where the tick runs | How often | What it means for you |
| --- | --- | --- |
| **Cloud Scheduler or EventBridge Scheduler** calls the tick service | once a minute | Always there, and enough for correctness. A delayed job, a retry's backoff and a cron entry are late by up to a minute (about 30 s on average). Never early. |
| **Inside an always-on worker** (`TickLoop`), as well | every few seconds (5 s by default; at 500 ms the measured mean lateness is 270-292 ms) | Seconds-level delays and backoff. One worker leads through a **lease row** read against the database's clock, not a session lock, so it is safe behind a transaction pooler. A crashed leader is replaced within about three intervals. |

The scheduler stays in both cases: it is the cron source and the safety net if every worker is down. The in-process tick
never replaces it. A scale-to-zero worker that only wakes on a bell gets the one-minute behaviour. The table of measured
lateness for every hosting mode is [limits.md section 1](limits.md#1-delay-precision-by-hosting-mode); read it before you
promise a customer a delay.

Because the tick is the repair, the bounds are in terms of it: no claimable job stays unrung longer than `reRingAfterMs` plus
one tick interval, and a crashed worker's job is claimable again within its lease plus one interval and rung within one more.

## Flows and workflows

- A **flow** is a parent job that waits for its children, which may be parents themselves, in any queues of the namespace.
  `FlowProducer.add` writes the whole flow in one transaction, so all of its jobs exist or none do, and the parent is never
  claimable before its last child is done. A flow holds at most 1,000 jobs and 100 levels.
- A **workflow** is the durable, step-by-step engine of Qelay (steps, branches, loops, signals, waits, compensation). Its runs
  are rows in Postgres behind a version fence, and each step is an ordinary job on one internal queue, so it rides the same
  claim, retry and bell path. The Control API holds no workflow definitions and runs no engine: workers announce the
  definitions they serve and an operator action is a version-checked write followed by a job a worker executes.

## Namespaces, queues and the panel

A **namespace** is the tenant of every row and of every cloud queue name. Workers, the tick and the Control API of one
deployment share one; two deployments on one database use two. A **queue** only sees its own jobs, and job ids are unique
per namespace, not per queue.

**A namespace is a convenience for environments, not a hard multi-tenant boundary.** It keeps `staging` and `production`
from seeing each other's jobs by mistake, and every store query filters on it. Two namespaces on one database still share a
credential, the tables, the connections and the cloud project, so one tenant's code, or one query that forgot its filter,
reaches the other's rows, and one tenant's load slows the other. Tenants that must not see each other need their own
database and cloud project ([threat model](security/threat-model.md#namespaces)).

The **Control API** is a small HTTP service in front of the same Postgres and the broker's metrics. The **panel** is a
single-page app that talks to it. Neither runs jobs. Reads are consistent reads of the store; every action is a transaction
on a row, with a version check for writers that hold no lease, and the API says `501 not_supported` for what the SDK does
not support ([routes](reference/routes.md)).

## What this is not

Qelay-Cloud covers the BullMQ-style core of Qelay. Repeat jobs, job groups' admin methods, manual retry of failed jobs and
DLQ replay, batch processing, the Qelay TCP server and embedded mode are not in v1.0.0. Each one throws
`UnsupportedOptionError` naming the option, or answers `501`; nothing is ignored silently ([unsupported.md](unsupported.md)).

## Where to go next

- [Architecture](architecture.md): the packages, the data flow and the boundaries between them.
- [Operations](operations.md): the connection budget, upgrades and what to watch.
- [Limits](limits.md): sizes, throughput, delivery guarantees and what has not been run.
- [Moving from Qelay](migration.md): what changes in your code.
