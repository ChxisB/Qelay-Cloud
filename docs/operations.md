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
| Ingest | none, or any number (opt-in) | yes | `qcloud-ingest`, the public `POST /s/<token>`. It stores and answers and never calls out, so it needs no outbound network. Each instance counts as a control process in the connection budget. [Runbook](runbooks/inbound-source-trouble.md). |
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
- **So does the Helm chart, at its largest.** Set `database.maxConnections` to the server's `max_connections` and the render
  fails when the fleet at every autoscaler's `maxReplicas` (API, ingest, sender, workers) needs more
  ([quickstart](quickstart-kubernetes.md#4-scale-it)). Left at `0` the guard is off.
- **Tell the Control API your fleet** (`QCLOUD_FLEET_WORKERS` and the variables after it) and `/deployment` and the panel's
  Deployment page show real connection use against the budget, and warn at 80%.
- **Add a pooler above about 80%.** Neither Terraform creates one: it is another paid, stateful service. Behind a
  transaction-mode pooler set `QCLOUD_DATABASE_POOLER=transaction`. Named prepared statements are then off, session
  settings (`search_path` for a non-default schema, `statement_timeout`, `lock_timeout`) belong on the database role
  (`ALTER ROLE ... SET`), and anything that needs `LISTEN` (the local transport) needs a direct `QCLOUD_DATABASE_LISTEN_URL`.
  The cloud transports hold no listener. No session-level advisory lock is used anywhere.
- **Database timeouts are set on the server.** Terraform sets `statement_timeout` 30 s, `lock_timeout` 5 s and
  `idle_in_transaction_session_timeout` 30 s on the database (`database_session_timeouts`, 0 turns one off). The SDK's own
  deadline retires a pool but cannot stop a statement the server already runs; `statement_timeout` is what does, and the
  idle-in-transaction one frees a session that opened a transaction and vanished. The migrator sets `statement_timeout` to 0
  inside its own transaction, so a slow index build is bounded by its deadline and not by the 30 s, and `lock_timeout`
  stays so a DDL that cannot lock gives up and the release step is retried. A one-off long statement you run yourself
  (a manual backfill) needs `SET statement_timeout = 0` in its session.
- **Cap the workers' role, so a runaway fleet cannot take the control plane's connections.** The budget is arithmetic;
  Postgres enforces it only when the workers log in as a role of their own with a `CONNECTION LIMIT`. Terraform does not do
  this: it creates one shared database user for every process and runs no SQL. Its `connection_budget` output has
  `worker_role_limit` (direct: the workers' pools and listeners; pooled: the pooler's server pool plus listeners), and an
  operator runs, once, as the owner of the tables:

  ```sql
  CREATE ROLE qcloud_worker LOGIN PASSWORD '<from the secret manager>' CONNECTION LIMIT <worker_role_limit>;
  GRANT USAGE ON SCHEMA public TO qcloud_worker;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qcloud_worker;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qcloud_worker;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qcloud_worker;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO qcloud_worker;
  ```

  Then point the workers' connection string at that role; the tick and the Control API keep the other one. A role beyond
  its limit is refused with `53300` for that role only, the others still connect. A worker stuck at its limit retries, so
  size the limit with headroom for a rolling deploy (old and new revisions overlap), and change it with
  `ALTER ROLE qcloud_worker CONNECTION LIMIT n` (`workerRoleLimitSql` builds the statement). The default privileges apply
  to tables a later migration creates *as the role that ran this block*: repeat them for the migrating role if it differs.
  Not exercised against a real Cloud SQL or RDS instance (D9). `connection.roleLimit.test.ts` checks the `53300` refusal on
  a local Postgres.
- **The sizes** are in [limits.md](limits.md#2-sizes-and-counts): a payload is at most 1 MiB, `addBulk` takes 1,000 jobs, a
  flow 1,000 jobs.

## Shards

One Postgres has a ceiling (connections, write throughput on its disk). Past it, put namespaces on several databases.
Every table is scoped by namespace and a namespace never spans databases, so the routing is a table you write:

```
QCLOUD_SHARDS=acme=a,globex=b,initech=a
QCLOUD_SHARD_A_DATABASE_URL=...        # from the secret manager, per process
QCLOUD_SHARD_B_DATABASE_URL=...
QCLOUD_SHARD_B_DATABASE_POOL_SIZE=5    # optional: overrides QCLOUD_DATABASE_POOL_SIZE for shard b
```

- **Workers and the SDK:** `new Queue(name, { namespace, shards })` (a `ShardMap`), or the same variables.
- **Control API:** one process per namespace, `QCLOUD_NAMESPACE=acme`. It opens that namespace's shard and holds no other
  shard's URL. A namespace outside the map is refused at start.
- **Migrations:** `qcloud-api migrate` with `QCLOUD_SHARDS` set migrates every shard in turn, names each in its output,
  and stops at the first that fails (exit 1) after the ones before it finished.
- **Tick:** `QCLOUD_SHARD=a qcloud-tick loop` runs one loop per namespace of shard `a` over one pool. Run two for
  failover; the lease is per namespace. The scheduler job still calls `/internal/tick` for one namespace at a time.
- **Connection budget:** work it out per shard (every process that opens that shard, at its pool size).
- **Adding a namespace:** add it to the map everywhere at once, then migrate. A process with the old map refuses it.
- **Moving a namespace** is manual and untested here: stop its writers, copy its rows (every table has `namespace`) to the
  other database, edit the map, restart. Its cloud queue and topic names do not change.
- **Not built:** one API for many namespaces, queries across shards, Terraform for more than one database. Decision D10
  in [DESIGN.md](../DESIGN.md#shards-review-r21).

## Choosing where the tick runs

The one-minute cloud scheduler is always there and is enough for correctness. It sets how late a delayed job, a retry's
backoff or a cron entry can be: up to a minute. If you need seconds, also run the tick inside an always-on worker. Do not
remove the scheduler job; it is the cron source and the safety net. The simplest always-on form is the
`qcloud-tick loop` command: one process (two for failover) with the same environment as `serve`, which beats every second
and gives the lease up on SIGTERM. Both Terraform examples run it for you (`tick_loop`, a fixed count of tasks of the tick image). The measured lateness for each case is
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
- **The ingest** (when you run it). `GET /healthz` is the probe, and it touches no database: a database that is down makes
  the ingest answer `503` with `Retry-After`, which a sender retries, and logs `lookup failed` or `accept failed` at most
  once in ten seconds. A rise in `429` is the rate limits working or a flood; a rise in rejected requests (the panel's
  Requests tab, status Rejected) is a sender whose secret or body is wrong. The cloud load balancer's own 5xx and 429 counts
  are the alert; none is shipped ([known issues](known-issues.md), row 12).
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

**Set a route schedule or a queue run window only after every process runs this release.** A worker or tick from before
versions 22 and 23 does not know them: it claims from a queue whose window is closed, and sends a scheduled route's events at
once. During a rolling upgrade, finish the rollout, then set them. The settings to start with are in
[production settings](production.md).

**Migrations are forward-only.** A migration may add a nullable column, a column with a default, a table or an index. It
never drops, renames or retypes anything the previous release still reads or writes; that takes two releases (stop using it,
then remove it). A shipped migration is never edited: its checksum is recorded, and an edited one stops every process with
`SchemaDriftError`. A bad migration is fixed forward with the next version.

### Rolling back

Because of that rule, rolling back the application is serving the previous revision against the migrated database. The older
build reports the schema as `ahead` and stays ready. **Do not run the older build's migration job**: it refuses a schema
newer than it knows (exit 1) and changes nothing. A column or table the release added stays; the previous release ignores it.

**Rolling back past version 13 (webhook deliveries by day).** Version 13 moves the webhook deliveries to `qcloud_deliveries`,
and moves the ones still to be sent with it. The previous release reads the old table, which gets nothing new: a tick of the
old release sends nothing it has not already, and deliveries made since the migration stay in the new table unsent until the
newer release runs again (they expire after 24 hours, as any unsent delivery does). During a rolling upgrade the same holds for
an old tick that is still running. A delivery that was being sent when the migration ran is moved as `sending` and can be sent
again after its lease lapses: at least once, as always. The old table is dropped by a later release. Day partitions are made
and dropped by the tick (`QCLOUD_WEBHOOK_KEEP_MS`); watch `pg_inherits` for `qcloud_deliveries` if a drop seems late: a day with
a delivery still waiting is kept.

**Rolling back past version 21 (the job events are removed).** Version 21 drops the delivery trigger and its function, the
`qcloud_webhook_writers` table and a webhook's `events`, `queue` and `active_from` columns, and lets a delivery have no job.
It is **not safe with a previous release connected**, and a rollback is a restore from a backup taken before the migration
(nothing in 1.0.0 had shipped when it was decided, D14). Routes that listened to a queue are kept but off, with the reason
"its source, a queue's job events, was removed". The webhook columns version 14 added (`filter`, `shape` and a delivery's
`body`) stay.

**Rolling back past version 15 (webhook pause and rotation).** Version 15 adds six `qcloud_webhooks` columns (the failure
streak, the alert level, the pause reason and time, and the previous sealed secret and its end). The previous release
ignores them, with two consequences: a webhook the newer release paused has `enabled = false`, so the old release
sends nothing for it either and its held deliveries expire; and a secret still in its rotation window signs with
the new secret only. Enable paused webhooks again after the rollback if they should send.

**Rolling back past versions 16 to 19 (the event gateway).** Each adds nullable or defaulted columns or a new table, and the
previous release ignores them:

- **16 (queue destinations).** The previous release cannot send a `queue` route: it fails each event of it without a request,
  and auto-pause then pauses the route. Resume it after the newer release runs again; **Retry all failed** puts its events back.
- **17 (name, description, delay, de-duplication).** The previous release shows no name and ignores `delay_ms` and `dedupe`:
  it sends at once and does not drop repeats. `qcloud_webhook_dedupe` stays and is never pruned
  while the old tick runs; it is small and pruned once the newer release runs again.
- **18 (issues).** Nothing reads or updates `qcloud_webhook_issues`, so its rows stop changing: an issue stays open after its
  connection recovers, and no new one opens. The newer release resolves and opens them correctly on its next settled delivery.
- **19 (saved destinations).** The previous release can neither make a connection from a saved destination nor rewrite a copy,
  so an address edited in the panel does not reach the connections that use it. Connections keep delivering to the copy they
  hold. Do not edit a destination while any worker runs the previous release.

**Rolling back past versions 22 and 23 (schedule, batch, queue policy and run window).** Both add nullable columns and one
index, and the previous release ignores them:

- **22 (route schedule and batch).** The previous release sends each delivery alone, and does not move a new delivery to the
  fire time, so a route with a schedule sends at once and one with a batch sends one request per event. Deliveries made by the
  newer release keep their fire time and are sent at it. `qcloud_deliveries.batch_id` stays.
- **23 (queue policy and run window).** Jobs the previous release enqueues take the built-in attempts, backoff and time limit,
  not the queue's policy. **It claims from a queue whose window is closed**, so every queue with a run window runs jobs at any
  time until the newer release runs again. Remove the windows first if a job must not start outside its window.

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
- **Say how it is backed up.** Qelay takes no backups and checks none. On the panel's Backups page (or `PUT /backup-policy`, an
  operator's call) declare `provider` (Cloud SQL or RDS backups), `external` (your own tooling: name it, and optionally say where
  the copies land) or `none`. Until someone does, `/deployment` and the Home page carry the warning `backup_undeclared`, and
  `backup_none` while the answer is "nothing". The declaration is a record of what you said, not proof that a backup exists or
  restores: test a restore yourself.
- **Retention.** The tick removes completed jobs older than `QCLOUD_COMPLETED_RETENTION_MS` (7 days by default, `0` keeps them for ever;
  one window for every queue, and a job a live flow still needs stays), and old events, completion records, group state and metric buckets by the rules of each queue
  (`POST /queues/{queue}/clean` removes finished jobs on demand). A queue's dead-letter queue keeps its entries for the
  configured time (`/queues/{queue}/dlq-config`).
- **A stored inbound request** (and its rejections) is kept for 2 days (`QCLOUD_WEBHOOK_KEEP_MS`, never less than 48 hours)
  and then deleted by the tick. It holds the body as the sender posted it, so a source whose senders post personal data keeps
  it for that long: a shorter window is the setting above, and a route's `shape` does not change what is stored.
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
