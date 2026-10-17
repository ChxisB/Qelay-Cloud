# Operations

What to size, what to watch and how to change a running deployment. It assumes the deployment of
[GCP](quickstart-gcp.md) or [AWS](quickstart-aws.md); the exact commands are in the
[GCP](runbooks/deploy-gcp.md) and [AWS](runbooks/deploy-aws.md) runbooks. Settings are in the
[configuration reference](reference/configuration.md), limits and guarantees in [limits.md](limits.md).

**Nothing here has run on a real cloud.** The figures are derived from the code or measured on a local Postgres and an
emulator; where a number is a threshold you must tune, it says so.

## What runs

| Process | Count | Holds a database pool | Notes |
| --- | --- | --- | --- |
| Workers (your code, the SDK's `Worker`) | as many as you need | yes | Scale on the queue's depth. A worker's `concurrency` does not change its connections. |
| The tick | one at a time is enough; two may overlap | yes | Called once a minute by the cloud scheduler; see [the maintenance tick](concepts.md#the-maintenance-tick). |
| Control API | at least one, always on (event streams) | yes | `qcloud-api serve`; the release step is `qcloud-api migrate`. |
| Panel | any | no | Static files plus `/config.json`. |
| Postgres | one | - | The only state. Back it up. |

## Connection budget

Postgres has a fixed number of connections, and at the limit the failure is a hard `53300` error, not a queue. Every process
holds a small pool, and the SDK keeps a connection only for one statement or one short transaction, never while your code
runs. So the formula counts processes, not concurrency:

```
direct = sum over processes of (pool_size + listen_connections) + 6 reserved
pooled = pooler server pool size + listen connections + 6 reserved
```

The 6 are for administration, replication and the console. The default pool is 2 per process (`QCLOUD_DATABASE_POOL_SIZE`).

| Worker processes | Direct (pool 2, 3 control processes) | Behind a pooler (server pool 20) |
| --- | --- | --- |
| 10 | 32 | 26 |
| 50 | 112 | 26 |
| 200 | 412 | 26 |

With the default `max_connections` of 100 a direct fleet tops out at about 44 worker processes.

- **Terraform checks it for you.** Both data planes refuse to plan a fleet that needs more than `max_connections`
  and warn above 80%. Count the tick and every Control API instance in `control_processes`.
- **Tell the Control API your fleet** (`QCLOUD_FLEET_WORKERS` and the variables after it) and `/deployment` and the panel's
  Deployment page show real connection use against the budget, and warn at 80%.
- **Add a pooler above about 80%.** Neither Terraform creates one: it is another paid, stateful service. Behind a
  transaction-mode pooler set `QCLOUD_DATABASE_POOLER=transaction`. Named prepared statements are then off, session
  settings (`search_path` for a non-default schema, `statement_timeout`, `lock_timeout`) belong on the database role
  (`ALTER ROLE ... SET`), and anything that needs `LISTEN` (the local transport) needs a direct `QCLOUD_DATABASE_LISTEN_URL`.
  The cloud transports hold no listener. No session-level advisory lock is used anywhere.
- **The sizes** are in [limits.md](limits.md#2-sizes-and-counts): a payload is at most 1 MiB, `addBulk` takes 1,000 jobs, a
  flow 1,000 jobs.

## Choosing where the tick runs

The one-minute cloud scheduler is always there and is enough for correctness. It sets how late a delayed job, a retry's
backoff or a cron entry can be: up to a minute. If you need seconds, also run the tick inside an always-on worker. Do not
remove the scheduler job; it is the cron source and the safety net. The measured lateness for each case is
[limits.md section 1](limits.md#1-delay-precision-by-hosting-mode). The tick's own settings (`QCLOUD_TICK_*`) are in the
configuration reference; the defaults suit the one-minute scheduler.

## What to watch

You have three views: the cloud's alarms, the panel and the Control API's `/deployment`.

- **The dead-letter queue of the broker is a metric, not a to-do list.** Any bell in it means delivery failed repeatedly.
  The job is still in Postgres and the tick rings it again; the alarm tells you how often it happens. Never replay it.
- **The oldest bell's age** says no worker takes bells for a queue (scaled to zero, crashed, paused).
- **Database connections** above 80% mean the budget no longer holds, or something leaks.
- **The tick.** On AWS an alarm fires when no tick reported `ok` for five minutes; on GCP it fires when the scheduler job
  logs errors. While the tick is stopped, delayed jobs past the broker's window, cron and lease recovery do not run.
  `GET /deployment` records the last tick and whether the deployment is keeping up.
- **The failed jobs** of each queue are in Qelay's own dead-letter queue (`GET /queues/{queue}/dlq`, or the panel). They are
  yours to read; the reason `max_attempts_exceeded` means the job used up its attempts.

Each alert has a [runbook](runbooks/README.md); the metrics, logs and traces behind them, and what is not wired for you, are in
[observability](observability.md). The alarm names, thresholds and what each means are in [infra/gcp](../infra/gcp/README.md) and
[infra/aws](../infra/aws/README.md#alarms). The thresholds are defaults, unproven against real load. Alarms notify nobody
until you give them notification channels (`notification_channels` on GCP, `alarm_actions` on AWS).

## Upgrading

Releases are built to be rolled out with the previous version still connected.

1. **Build and push** the new images (by digest) and set them in the variables.
2. **Migrate first.** `qcloud-api migrate` is a release step, run as a Cloud Run job on GCP and a one-off task on AWS, never
   on start. Re-running it is a no-op; it exits 0 when the database is current. The services never migrate, so a service
   that starts before the migration answers `/health` 200 and `/health/ready` 503 with the schema `behind`, and becomes ready
   by itself once the migration is done.
3. **Apply** the control plane (and the data plane when its variables changed). A new revision receives traffic only after
   its startup probe passes, and the old one keeps serving until then.
4. **Workers** roll one at a time. A worker given a stop signal stops taking bells, gives the jobs it holds `graceMs` to
   finish, then aborts the rest and releases their leases without counting a failure, and closes (the in-process tick
   stops after the release). A released job runs again; if the release itself fails, the tick recovers the job after its
   lease. Set the grace longer than your longest job to avoid the rerun.

**Migrations are forward-only.** A migration may add a nullable column, a column with a default, a table or an index. It
never drops, renames or retypes anything the previous release still reads or writes; that takes two releases (stop using it,
then remove it). A shipped migration is never edited: its checksum is recorded, and an edited one stops every process with
`SchemaDriftError`. A bad migration is fixed forward with the next version.

### Rolling back

Because of that rule, rolling back the application is serving the previous revision against the migrated database. The older
build reports the schema as `ahead` and stays ready. **Do not run the older build's migration job**: it refuses a schema
newer than it knows (exit 1) and changes nothing. A column or table the release added stays; the previous release ignores it.

### Rotating the database secret

The password is a generated secret that each service pins by version, so a rotation rolls new revisions: change it in the
data plane, then re-export the control plane's inputs and apply. Existing connections stay open and reconnects fail for a
few minutes; the SDK retries with backoff and the tick repairs the gap. Treat the procedure as unproven until it has run
against a real project. The steps are in the [GCP runbook](runbooks/deploy-gcp.md#rotating-the-database-secret) and the
[AWS runbook](runbooks/deploy-aws.md#rotating-the-database-secret).

## Data

- **Back up Postgres.** It is the only state: the queues hold bells, not jobs. Both data planes turn on backups with
  point-in-time recovery and database deletion protection. Bells are not state: after a restore the tick rings every
  claimable job again.
- **Retention.** The tick removes old completed jobs, events, completion records and group state by the rules of each queue
  (`POST /queues/{queue}/clean` removes finished jobs on demand). A queue's dead-letter queue keeps its entries for the
  configured time (`/queues/{queue}/dlq-config`).
- **A webhook delivery** is retried 8 times over about an hour and can reach a receiver twice; deduplicate on `X-Webhook-Id`
  ([webhooks.md](webhooks.md)).

## Security you own

The Control API accepts OIDC tokens in production and refuses the development token when `NODE_ENV=production` and when it
listens beyond loopback. Roles come from a claim in the token: `operator` writes, `viewer` reads. Secrets are read from the
cloud's secret manager and never appear in the repository, logs or the Control API's responses. The tick endpoint accepts
only the scheduler's identity token (a shared secret exists for development only). Review the [threat model](security/threat-model.md) and the [security review](security/review-v1.0.0.md) (a self-review, with its open finding) before you expose the panel; [who may call what](security/routes.md) is generated from the code.

## Teardown

Destroy the control plane first. The database has deliberate protections (deletion protection and a lifecycle block), so
removing it takes explicit steps; take a backup you want to keep first, because automated backups go with the instance. See
[GCP](../infra/gcp/README.md#teardown) and [AWS](../infra/aws/README.md#teardown).
