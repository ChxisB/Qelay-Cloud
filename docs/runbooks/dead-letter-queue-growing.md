# Runbook: jobs are failing for good

**Alert.** The optional "<name>: jobs failing for good" policy on GCP, which reads `qcloud.tick.jobs.failed_total`
([observability](../observability.md#what-is-not-wired-for-you)); on AWS there is none by default. Otherwise the Queues page
shows a growing `failed` count, or `GET /queues/summary` does.

This is **Qelay's own dead-letter queue**: jobs that used their last attempt. It is not the broker's
([poison bells](transport-dead-letters.md)).

**What is safe.** The entries are kept, with their error, for the queue's retention (`GET /queues/{queue}/dlq-config`). Reading
changes nothing. **Retrying an entry is not supported in v1.0.0** ([unsupported](../unsupported.md)): the fix is to correct the
cause and add the work again.

## Check

1. Which queue, and how many: `GET /queues/summary`, then `GET /queues/{queue}/dlq/stats`.
2. Why: `GET /queues/{queue}/dlq` lists entries with how each failed. The reason is `max_attempts_exceeded` (the handler threw on
   every attempt: read the message and stack), `timeout`, `explicit_fail`, or `stalled`. One cause across many entries (a changed API, an expired credential, a bad deploy)
   is the common case. `stalled` is a job whose lease lapsed more often than the queue's `maxStalls` allows: see
   [lease-loss storm](lease-loss-storm.md).
3. Since when: the entry's timestamps against your deploys.

## Fix

1. Fix the handler or the dependency, and deploy it.
2. Add the work again from the entries you want: read each job's data (`GET /jobs/{id}`) and `POST /queues/{queue}/jobs`, or
   `POST /queues/{queue}/jobs/bulk` for many. They are new jobs with new ids: use a `jobId` or a deduplication key if the
   handler is not idempotent.
3. When you no longer need the entries, `POST /queues/{queue}/dlq/purge` deletes **every** entry of that queue's DLQ. Read
   what you are removing first; it cannot be undone.

## Verify

New jobs complete, `failed_total` stops rising, and the alert closes when the rate falls under the window.

## Escalate

Entries fail with an error that is not yours (a database error, `SchemaDriftError`, a timeout in the SDK): treat it as an
incident and read [slow claims](slow-claims.md) and [connection exhaustion](connection-exhaustion.md).
