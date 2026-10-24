# Runbook: move a Pub/Sub consumer's work into a Qelay queue

**When.** A service publishes to a Pub/Sub topic and another pulls a subscription of it, and that work is moving to a Qelay queue.
This runbook moves what is waiting in the subscription and sets out the order of the cutover. The jobs, retries and schedule
settings of the queue itself are in [operations](../operations.md).

**What is safe.** The importer reads one subscription and acks a message only after the job is stored in Postgres. Each job's id
is the message id, so a re-run, a crash, or a message delivered twice adds no second job while the first one is live. `--dry-run`
counts and changes nothing: it stores nothing, acks nothing and gives every message back. The importer publishes nothing and
deletes nothing. What it does change: **a message it acks is gone from that subscription**, so run it on a subscription of its own.

## Before you start

1. **A subscription of its own on the old topic**, so the old consumers keep theirs. It sees messages published after it is created,
   so create it before the cutover starts, with an ack deadline of a minute or more:
   `gcloud pubsub subscriptions create qelay-import --topic <topic> --ack-deadline 60`. That is a write to your project: it needs
   the owner's go-ahead.
2. **The Qelay queue is ready** ([deploy](deploy-gcp.md)) and its workers read the job as described below.
3. **The queue's settings match what the old subscription did.** `PUT /queues/{queue}/policy` (or the panel's Retry policy card)
   takes the place of the subscription's retry policy: `maxDeliveryAttempts` becomes `attempts`, `minimumBackoff` and
   `maximumBackoff` become an exponential `backoff` with `delay` and `maxDelay`, and the ack deadline becomes `timeout`. If the old
   consumer only ran at night, `PUT /queues/{queue}/run-window` does the same. Jobs that run out of attempts wait in the
   dead-letter queue, where they can be retried ([dead-letter queue growing](dead-letter-queue-growing.md)).

## What a job looks like

The message **body** is JSON when it parses and text otherwise (bytes are read as UTF-8). The job's `data` is the message
**attributes** as fields and the body as `body`:

| Message | Job `data` |
| --- | --- |
| body `{"id":500,"name":"chris"}`, attribute `tenant=acme` | `{ "tenant": "acme", "body": { "id": 500, "name": "chris" } }` |
| body `hello`, no attributes | `{ "body": "hello" }` |

The job's name is `--job-name` (default `message`): a message has none. The job id is the Pub/Sub message id.

## Cutover

**Drain, when the producers can stop for a moment.**

1. Stop the producers, or point them at the Qelay queue (`queue.add`) and leave the old consumers running.
2. Run the importer until it reports `pulled: 0`.
3. Stop the old consumers. Start the Qelay workers (or `POST /queues/{queue}/resume` if you paused the queue).

**Side by side, when they cannot.**

1. Start the Qelay workers.
2. Switch the producers, one at a time, from the topic to the Qelay queue.
3. Stop the old consumers once the importer's second run in a row reports `pulled: 0`: what was published before the switch is now
   in Qelay. Delete the old topic and subscriptions after your retention period.

**If the handler cannot run twice**, pause the queue while the importer runs (`POST /queues/{queue}/pause`) and resume after.
A message delivered again after its job *finished* adds a new job, because a finished job's id is taken over; with the queue
paused no job finishes inside that window.

## Run it

Credentials come from the environment or the secret manager, never from a ticket or the command line:

```bash
export QCLOUD_DATABASE_URL=...    # the same database the workers use
export QCLOUD_NAMESPACE=prod
export QCLOUD_GCP_PROJECT=<project>
bun packages/transport-gcp/src/importBin.ts --subscription qelay-import --queue orders --job-name order --dry-run
bun packages/transport-gcp/src/importBin.ts --subscription qelay-import --queue orders --job-name order
```

It prints one JSON line: `pulled` (messages seen), `created` (jobs that did not exist) and `acked`. `created` below `pulled`
means messages came again after a crash or a lost ack, and their jobs were already there. `--max N` stops after N messages,
`--wait S` is how long one pull waits (default 5), and two empty pulls in a row end the import. SIGINT stops after the page in hand.

Without `--emulator-host` the tool reaches Google Cloud and refuses to run unless `QCLOUD_REAL_CLOUD=1`, which is the owner's
go-ahead for anything paid or shared. A `PUBSUB_EMULATOR_HOST` left in the environment is refused for the same reason the
transport refuses it.

## What it does not move

- **Ordering keys.** Messages come in the order Pub/Sub hands them out, and Qelay does not keep one: jobs are claimed by priority
  and age. A consumer that needs order per key needs a different design, not this tool.
- **Delays.** A Pub/Sub message has none; a publisher that held messages back some other way must add the delay to the job itself.
- **Message ids, publish time and the dead-letter attributes** are not copied into `data`. An attribute called `body` is replaced
  by the body.
- **Binary bodies.** They are read as UTF-8 text.
- **The old subscription's dead-letter topic.** Its messages stay there; replay them into a subscription and import that.
- **Pub/Sub flow control.** The importer stores a page of 100 in one transaction. A bigger backlog just takes more pages.

## Verify

`GET /queues/{queue}/counts` shows the jobs, the old subscription's backlog is zero (`gcloud pubsub subscriptions describe`, or
`numUndeliveredMessages` in Cloud Monitoring), and a message published to the Qelay queue after the switch completes on a worker.

Run on the Pub/Sub emulator and Postgres only (`packages/transport-gcp/test/import.test.ts`: 250 messages, a second run, a crash
between the store and the ack, the command line, the refusal). Never run against Google Cloud.
