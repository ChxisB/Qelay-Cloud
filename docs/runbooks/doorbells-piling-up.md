# Runbook: bells are piling up, or no worker takes them

**Alert.** GCP: "<name>: bells waiting" and "<name>: bells waiting and no worker running". AWS: `<name>-<queue>-queue-age`.
`GET /deployment`: warning `doorbells_overdue`. The Transport page shows a queue with depth and an old oldest-bell age.

**What is safe.** A bell is not a job. The jobs are in Postgres, and a bell only wakes a worker. Waiting longer loses
nothing; the cost is latency. Do not purge the broker's queue to make the number go down: the tick rings the jobs again, but
you have destroyed the evidence.

## Check

Two different problems look the same from outside. Tell them apart:

1. **Bells are rung but nobody takes them** (broker depth and age grow). `GET /transport` shows depth, in-flight and the
   oldest age per queue; `GET /queues/{queue}/counts` shows how many jobs wait. No worker means: scaled to zero or crashed,
   the service has no ready revision, the queue is **paused** (`GET /queues/{queue}/paused`), or the workers do not
   listen to this queue.
   - GCP: `gcloud run services describe <name>-<service> --region REGION` (latest ready revision, instance counts) and the
     service's log.
   - AWS: `aws ecs describe-services --cluster <cluster> --services <name>-<service>` (running against desired, recent
     events).
2. **Jobs are claimable but no bell was rung** (broker empty, jobs wait). `doorbells_overdue` in `/deployment` is this: the
   oldest claimable job has waited longer than a tick interval for its bell. The tick is behind or stopped:
   [the tick has stopped](tick-stopped.md).
3. **Workers run and take bells but do nothing useful.** The jobs are active and slow, or jobs fail and retry. Compare
   `counts` (active) with the worker count in `GET /workers`, and read the job's attempts with `GET /jobs/{id}`.

## Fix

- No worker: bring one up (scale `min_instances` / `desired_count`, roll back a bad revision, fix the image or the secret it
  cannot read). On GCP the workers pull from Pub/Sub, so an instance scaled to zero hears nothing: keep
  `min_instances` at 1 or more.
- Paused queue: `POST /queues/{queue}/pause` was called and `POST /queues/{queue}/resume` undoes it. Resume rings nothing
  itself; the tick rings what was held, within its interval.
- Too few workers for the load: raise `max_instances`, and re-check [the connection budget](connection-exhaustion.md)
  first, because each process holds a pool.

## Verify

The oldest-bell age falls on the Transport page (the broker's number is approximate and can lag by about a minute), the
queue's `counts` of waiting jobs fall, and the alert closes.

## Escalate

Workers are healthy and bells are taken but claims are slow: [slow claims](slow-claims.md). Bells reach the broker's
dead-letter queue: [poison bells](transport-dead-letters.md).
