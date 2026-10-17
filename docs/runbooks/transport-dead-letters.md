# Runbook: bells in the broker's dead-letter queue

**Alert.** GCP: "<name>: dead-letter bells". AWS: `<name>-<queue>-dead-letter-depth` and `-dead-letter-age`.

**What is safe.** A dead-lettered bell is not a lost job. The bell is the broker's note "something is waiting in queue Q";
the job itself is in Postgres, and the tick rings every claimable job whose last bell is older than the re-ring interval.
**Never replay a dead-letter queue by moving its messages back**: it adds nothing the tick does not already do, and a worker
that fails on a bell can fail on it again. Nothing here changes a job.

## Check

1. Which queue, and what is in it. The sample is a peek, at most 50 entries, nothing is acknowledged or removed; it needs the
   operator role:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/transport/dead-letters?queue=$QUEUE" | jq '.items[] | {jobId, deliveryCount, ageMs, jobExists}'
   ```

   `available: false` says why (`not_supported` for the `postgres` transport, `unreachable` when the broker could not be
   read). It is never an empty list that means "fine".
2. `jobExists: false` is a bell for a job that was removed (cleaned, drained, obliterated): harmless, and the only thing to
   do is clear it. `jobExists: true`: read the job, `GET /jobs/{jobId}`. If it has run or is running, the bell was redundant.
   If it is still waiting, the tick will ring it again.
3. Why did delivery fail five times? A bell fails when no worker acknowledges it in time: workers crashing before they
   acknowledge, a worker pool that is too small, a worker that throws while claiming (a database problem). Compare with the
   [slow claims](slow-claims.md) and [connection](connection-exhaustion.md) runbooks and the worker log.

## Fix

- Fix the cause first. The "redrive" is the tick: once workers are healthy, the next tick rings the claimable jobs again and
  they run. You can trigger it ([the tick has stopped](tick-stopped.md#fix)).
- Then clear the leftovers so the alert can close. This deletes only the notes:
  - GCP: `gcloud pubsub subscriptions seek qcloud.<namespace>.dlq.<queue> --time=$(date -u +%Y-%m-%dT%H:%M:%SZ)` discards the
    messages published before that time.
  - AWS: `aws sqs purge-queue --queue-url <dead-letter queue URL>` (allowed once a minute; the URL is in the Terraform
    output for the queue).

## Verify

`GET /transport/dead-letters` shows no entries and the alert closes; after the next tick, the queue's waiting jobs run.

Not run on a real cloud ([limits](../limits.md)). The game day sends a malformed bell to the Pub/Sub and the SQS emulators: it ends
in the dead-letter queue, the route above lists it with `jobId` null, the SQS `deadLetterDepth` in `GET /transport` shows it, and
the job behind it runs once. The two clearing commands (`seek`, `purge-queue`) were not run, and Pub/Sub's depth, which comes from
Cloud Monitoring, was not read.

## Escalate

The same bells come back after a clear: the cause is not fixed. Look at one `jobId` through its attempts and the worker log.
