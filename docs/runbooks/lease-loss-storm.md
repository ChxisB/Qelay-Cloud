# Runbook: a storm of lost leases

**Signal.** Many jobs run twice, workers log `lease_lost`, the counter `qcloud.worker.lease_lost{at}` rises, or jobs fail with
a stall reason after several recoveries. There is no alert by default: it is a counter you can alert on once you export it
([observability](../observability.md)). `heartbeat_failed` rising with it says the worker could not renew.

**What is safe.** A lease is a promise that a worker still holds a job. When it lapses (a crashed worker, a stalled event
loop, a database that did not answer the heartbeat), the tick takes the job back and it runs again: at least once. A handler
that is not idempotent can have side effects twice; that is the cost to weigh. When the lease is lost the worker abandons the
job's settlement, so a late result is dropped, never applied over the newer attempt.

## Check

1. Which of these:
   - **Workers are dying.** Restarts, out-of-memory kills, deploys that stop workers faster than `graceMs`. `GET /workers`
     shows who is alive and when they last beat.
   - **The event loop is blocked.** A synchronous loop in a handler stops the heartbeat. On Cloud Run the worker needs CPU outside
     requests (`cpu_idle = false`, which the module sets); on Fargate check CPU throttling of the task size.
   - **The database is slow or the pool is starved.** A heartbeat is a database statement, so [slow claims](slow-claims.md) and
     [connection exhaustion](connection-exhaustion.md) produce lost leases.
   - **The lease is shorter than the work needs.** The default is 30 s with a beat every third of it.
2. `GET /queues/{queue}/stall-config` shows `maxStalls`, how often a job may stall before it fails with the reason `stalled`.

## Fix

- Make the worker stable first (memory, CPU, restarts), then the database.
- Give long jobs room: `lockDuration` on the worker (and the store's `leaseMs`, which must equal it when you pass a `store`).
  A longer lease also delays the recovery of a job whose worker really died, to the lease plus two tick intervals.
- Make handlers idempotent; use `jobId` or deduplication keys on the add.
- Set `maxStalls` so a job that always kills its worker lands in the DLQ instead of looping
  (`PUT /queues/{queue}/stall-config`).

## Verify

`lease_lost` and `heartbeat_failed` stop rising, no job's attempts grow without an error, and the tick's `recovered` count
falls back to near zero.

## Escalate

Leases are lost on a healthy, idle worker and database: capture the worker log around one `lease_lost` and open an issue.
