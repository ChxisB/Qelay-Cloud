# Runbook: jobs are failing for good

**Alert.** The optional "<name>: jobs failing for good" policy on GCP, which reads `qcloud.tick.jobs.failed_total`
([observability](../observability.md#what-is-not-wired-for-you)); on AWS there is none by default. Otherwise the Queues page
shows a growing `failed` count, or `GET /queues/summary` does.

This is **Qelay's own dead-letter queue**: jobs that used their last attempt. It is not the broker's
([poison bells](transport-dead-letters.md)).

**What is safe.** The entries are kept, with their error, for the queue's retention (`GET /queues/{queue}/dlq-config`). Reading
changes nothing. Nothing retries an entry by itself ([unsupported](../unsupported.md)): correct the cause, then put the work back
yourself (Fix, below).

## Check

1. Which queue, and how many: `GET /queues/summary`, then `GET /queues/{queue}/dlq/stats`.
2. Why: `GET /queues/{queue}/dlq` lists entries with how each failed. The reason is `max_attempts_exceeded` (the handler threw on
   every attempt: read the message and stack), `timeout`, `explicit_fail`, or `stalled`. One cause across many entries (a changed API, an expired credential, a bad deploy)
   is the common case. `stalled` is a job whose lease lapsed more often than the queue's `maxStalls` allows: see
   [lease-loss storm](lease-loss-storm.md).
3. Since when: the entry's timestamps against your deploys.

## Fix

1. Fix the handler or the dependency, and deploy it.
2. Put the failed jobs back: `POST /queues/{queue}/dlq/{jobId}/retry` for one, or `POST /queues/{queue}/dlq/retry` with
   `{ "confirm": "<queue>", "limit": 100, "reason": "max_attempts_exceeded" }` for many (at most 500, oldest failure first; `reason` is
   optional). They return to `waiting` with the same id and no attempt used, so a handler that is not idempotent must
   be fixed first. `remaining` in the answer is what another call would still retry. A flow member is left in the DLQ:
   retry the flow. The queue's dead-letter page has a Retry button on each entry and one for up to 500.
3. When you no longer need the entries, `POST /queues/{queue}/dlq/purge` deletes **every** entry of that queue's DLQ. Read
   what you are removing first; it cannot be undone.

## Verify

The retried jobs complete, `failed_total` stops rising, and the alert closes when the rate falls under the window.

## Escalate

Entries fail with an error that is not yours (a database error, `SchemaDriftError`, a timeout in the SDK): treat it as an
incident and read [slow claims](slow-claims.md) and [connection exhaustion](connection-exhaustion.md).
