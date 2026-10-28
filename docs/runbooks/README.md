# Runbooks

One page per alert. Each says what the alert means, what is safe to do, how to check, how to fix, how to confirm and when to
stop and ask. They assume the jobs are safe: Postgres holds every job, and a bell (the queue message) is only a doorbell the
tick can ring again.

## Before you start

You need the Control API's address and a token with the operator role (`/health` answers without a token, nothing else does):

```bash
API=https://<your control API address>
TOKEN=<an operator token from your identity provider>
curl -s -H "Authorization: Bearer $TOKEN" "$API/deployment"
```

`GET /deployment` is the first call of every runbook: the database state, the connection budget, the tick's last success and the
transport. Do not paste a token or a connection string into a ticket, a log or a runbook.

## From an alert to its runbook

| Alert (GCP policy / AWS alarm) | Runbook |
| --- | --- |
| tick calls failing, tick not running / `<name>-tick-stalled` | [tick stopped](tick-stopped.md) |
| bells waiting, bells waiting and no worker / `<name>-<queue>-queue-age`, `<name>-<service>-no-tasks`, `<name>-workers-idle-with-backlog` | [doorbells piling up](doorbells-piling-up.md) |
| dead-letter bells / `<name>-<queue>-dead-letter-depth`, `-dead-letter-age` | [transport dead letters](transport-dead-letters.md) |
| database connections / `<name>-database-connections` | [connection exhaustion](connection-exhaustion.md) |
| slow claims (optional) / `<name>-slow-claims` (optional), `<name>-database-cpu` | [slow claims](slow-claims.md) |
| jobs failing for good (optional) / `<name>-jobs-failing-for-good` (optional) | [dead-letter queue growing](dead-letter-queue-growing.md) |
| control API errors / `<name>-control-api-errors` | [control API errors](control-api-errors.md) |
| (none on GCP) / `<name>-database-free-storage` | [database storage full](database-storage-full.md) |

The optional ones need a metric you export yourself: [what is not wired for you](../observability.md#what-is-not-wired-for-you).

Without an alert, for a symptom or a planned task:

| Situation | Runbook |
| --- | --- |
| Many jobs lose their lease, workers restart in loops | [lease loss storm](lease-loss-storm.md) |
| Times disagree between hosts, tokens are rejected as early or late | [clock skew](clock-skew.md) |
| A deploy stopped at the migration step | [failed migration](failed-migration.md) |
| The database password changes | [rotate the database secret](rotate-database-secret.md) |
| The database was lost or damaged | [restore from a backup](restore-from-backup.md) |
| Moving a queue to another broker | [drain and cut over a queue](drain-and-cut-over-queue.md) |
| Moving a Pub/Sub consumer's work into a Qelay queue | [import from Pub/Sub](import-from-pubsub.md) |
| A sender's posts to a source fail, a flood of 429s, the ingest is down, a source's secret or URL leaked, a route sends nothing | [inbound source trouble](inbound-source-trouble.md) |
| First deploy | [GCP](deploy-gcp.md), [AWS](deploy-aws.md) |

## What was run

Be exact about what this evidence is:

- The local game day (`bun run test:gameday -- --local`, 18 tests, about a minute) injects each failure into the local stack
  (Postgres, the Pub/Sub emulator and ElasticMQ), reads the signal the runbook names, applies the runbook's fix and checks the
  signal clears. It covers the tick (stopped, failing), bells that are not rung or not taken, drain and cut over, connections near
  the limit and a fleet that does not fit, a lock on the jobs table, an unreachable database behind the Control API, growth and
  `clean`, a migration that is behind, edited or ahead, a lease-loss storm, jobs failing for good, clock skew, a rotated password
  (a throwaway role), a restore (a `pg_dump` loaded into a second database) and a malformed bell on both emulators. It shrinks
  the tick's thresholds to seconds and reads the signals through the Control API in process, so it shows that the signal an
  alert reads appears and that the fix clears it. It does not show that an alert fires.
- **No alert has been seen to fire on a real cloud**, and no runbook has been followed on one: that needs the owner's go-ahead
  for real-cloud runs. Alert thresholds are first guesses, and two alerts depend on cloud behaviour not yet seen
  (a Cloud Run service at zero instances, and a log-based tick signal that is absent for 24 hours). Treat a system as watched only
  after you have seen its alert fire.
- Commands that touch the cloud (`gcloud pubsub subscriptions seek`, `aws sqs purge-queue`, the point-in-time restores, the
  secret rotation in Terraform, the deploy runbooks) are written from the providers' documentation and are untried here. A disk
  that is actually full, a migration step that fails halfway and a Cloud Monitoring reading of Pub/Sub's dead-letter depth were
  also not produced.
