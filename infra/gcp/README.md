# Qelay-Cloud on GCP (Terraform)

Everything a Qelay-Cloud environment needs on Google Cloud: a private Cloud SQL for PostgreSQL 18, a Pub/Sub topic and
subscriptions per queue (the "doorbell"), Cloud Run worker pools for the workers, a Cloud Run service for the maintenance tick, Cloud Scheduler as
the tick's clock, Secret Manager for the connection strings, least-privilege service accounts and alert policies.

Design: [DESIGN.md](../../DESIGN.md) section 7. Postgres is the authority on job state; Pub/Sub only tells a worker that
something may be waiting, and the tick repairs whatever a lost bell leaves behind.

**Status: planned and checked, never applied.** Applying creates paid, shared resources, which the repository's rules
reserve for an explicit go-ahead (decision D9). What was and was not run is listed in [Needs D9](#needs-d9-what-has-never-run).

## Layout

| Path | What it is |
| --- | --- |
| `example/` | A complete environment. Copy it, or call the modules from your own root. |
| `example/ci.tfvars.example` | The values of a fictional project, used by `bun run check:terraform`. Not a real environment. |
| `example/backend.tf.example` | A GCS backend with a partial configuration. |
| `control-plane/` | The Control API, the panel, the optional inbound listener (`ingest`) and the migration job, a separate root that takes this one's `control_plane_inputs` output. Runbook: [docs/runbooks/deploy-gcp.md](../../docs/runbooks/deploy-gcp.md). |
| `modules/network` | VPC, subnet, and the private services peering Cloud SQL needs. |
| `modules/database` | Cloud SQL instance, database, user and generated password. |
| `../modules/budget` | The connection budget (below), shared with `infra/aws`. Refuses a plan that cannot fit. |
| `modules/messaging` | The topics and, per queue, a subscription and a dead-letter subscription. |
| `modules/secrets` | Secret Manager secrets and their versions. |
| `modules/iam` | Three service accounts and every binding between them and the resources. |
| `modules/workers` | One Cloud Run worker pool per entry of `worker_services`. |
| `modules/autoscaler` | Optional: the always-on CREMA service that sets a pool's instance count from its queue's backlog ([Scaling the workers](#scaling-the-workers)). |
| `modules/tick` | The tick's Cloud Run service and the scheduler's right to invoke it. |
| `modules/scheduler` | The Cloud Scheduler job that calls the tick every minute. |
| `modules/monitoring` | Alert policies. |

## What the example creates

| Module | Resources |
| --- | --- |
| network | `google_compute_network`, `google_compute_subnetwork` (private Google access), a reserved global address, `google_service_networking_connection` |
| database | `google_sql_database_instance` (private IP only, `ENCRYPTED_ONLY`, backups with point-in-time recovery, deletion protection, `prevent_destroy`, and managed connection pooling when asked for), `google_sql_database`, `google_sql_user`, `random_password` |
| messaging | two `google_pubsub_topic`; per queue two `google_pubsub_subscription`; the Pub/Sub service agent's grants |
| secrets | `google_secret_manager_secret` and `_version` for the database URL, the CA, the direct URL when a pooler is used, and the webhook key when `webhooks` is on (a `random_id`) |
| iam | `google_service_account` x3 and resource-level IAM members |
| workers | `google_cloud_run_v2_worker_pool` per worker service (a pool has no ingress and no port) |
| autoscaler | only when a pool sets `autoscaling`: a service account, a Parameter Manager parameter and version, five kinds of grant, and one always-on `google_cloud_run_v2_service` (8 resources for one pool) |
| background | only when `tick_loop` or `webhook_sender` is set: a `google_cloud_run_v2_worker_pool` each, of the tick image, on the tick's service account, with a fixed count |
| tick | `google_cloud_run_v2_service` (one instance, public URL, OIDC only), `google_cloud_run_v2_service_iam_member` |
| scheduler | `google_cloud_scheduler_job` with an OIDC token |
| monitoring | `google_monitoring_alert_policy` x6 (x8 with the two exported-metric alerts) |

With the CI values this is 67 resources to add (75 with one pool autoscaled); 61 of them are there without the webhook key, the loop and the sender.

## Quick start

1. **Prerequisites.** Terraform 1.5 or later, `gcloud` signed in, a project with billing, and permission to create the
   resources above. The project number is not looked up (so a plan needs no credentials):
   `gcloud projects describe PROJECT_ID --format='value(projectNumber)'`.
2. **Push the images first.** `worker_image` and `tick_image` must exist before Cloud Run can start a revision. The tick
   runs `qcloud-tick serve` (the `maintenance` package): it is in the Control API's image
   (`packages/control-api/Dockerfile`), so set `tick_image` to that and `tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`.
   The worker image is yours and runs the SDK's `Worker`.
3. **Write your variables.** Start from `example/ci.tfvars.example`, change `project_id`, `project_number`, `region`,
   the images, `namespace`, `queues` and `worker_services`. Name the file anything ending `.tfvars` (the repository
   ignores those).
4. **Initialise with state in a bucket** (see State and safety):

   ```bash
   cd infra/gcp/example
   cp backend.tf.example backend.tf
   terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=qcloud/<environment>"
   terraform plan -var-file=my.tfvars -out=plan.tfplan
   ```

5. **Read the plan, then apply.** The first apply takes the longest at the database (several minutes) and the private
   services peering. `apply` is the step that needs the go-ahead.

   ```bash
   terraform apply plan.tfplan
   ```

6. **Check it.** `terraform output tick_url`, then trigger the scheduler job once and watch the tick's logs and the
   `scheduler_failures` alert stay quiet.

Apply order is Terraform's, and it is explicit where it matters: the APIs, then the network and peering, then the
database; messaging and secrets; the service accounts and their bindings; the Cloud Run services (which depend on the
bindings and subscriptions existing); the scheduler job last.

### Required APIs

`compute`, `servicenetworking`, `sqladmin`, `run`, `pubsub`, `secretmanager`, `cloudscheduler`, `monitoring`, `parametermanager`
(only the autoscaler reads it) and `iam` (`*.googleapis.com`). The example enables them and leaves them enabled on destroy. Set `enable_apis = false` if your
organisation enables APIs elsewhere.

## Variables of the example

| Variable | Default | Meaning |
| --- | --- | --- |
| `project_id`, `project_number`, `region` | required | The project and where regional things go. Put the workers near the database. |
| `name` | `qcloud` | Prefix of every resource, 2 to 20 characters. |
| `namespace` | `default` | `QCLOUD_NAMESPACE`: tenant of every row and of every Pub/Sub name. Letters, digits, dashes. |
| `queues` | `{ default = {} }` | One entry per queue that gets a doorbell. Per queue: `ack_deadline_seconds` 30, `max_delivery_attempts` 5, `min_backoff_seconds` 1, `max_backoff_seconds` 10. |
| `worker_image`, `tick_image` | required | Container images. A worker service may set its own `image`. |
| `tick_command` | null | Overrides the tick image's entrypoint (the Control API's image needs it; see Quick start). |
| `worker_services` | `{ worker = { max_instances = 10 } }` | `min_instances` 1 (the pool's count at creation, and the autoscaler's floor), `max_instances` required (the budget counts it; only the autoscaler enforces it), `pool_size` 2, `listen_connections` 0, `cpu` 1, `memory` 512Mi, `env`, `autoscaling` null (`{ queue, backlog_per_instance = 10 }` adds the autoscaler). |
| `autoscaler_image` | CREMA 1.3 | The image of the autoscaler service. **Pin a digest for anything that lives:** the service may update the pools (`run.developer`), so a tag that moves is a way to run code as the workers. |
| `control_processes`, `control_pool_size` | 3, 2 | Other processes that hold a pool: the tick, each Control API instance at its `api_max_instances` and each ingest instance at its `ingest.max_instances` (the control plane's plan refuses more). The panel holds no connection. Deploying the ingest adds its instances: raise this by `ingest.max_instances`. |
| `database_tier` | `db-custom-1-3840` | Machine tier. The database is the cost floor. |
| `database_edition` | `ENTERPRISE` | `ENTERPRISE_PLUS` needs a `db-perf-optimization` tier and is what managed pooling runs on. |
| `database_session_timeouts` | `{ statement_ms = 30000, lock_ms = 5000, idle_in_transaction_ms = 30000 }` | Server-wide `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`, in milliseconds, 0 = off. The migrator lifts the statement timeout for its own transaction, so a slow index build is bounded only by its own deadline. Whether the cloud accepts all three flags was not run (`terraform plan` only). |
| `database_managed_pooling` | false | Cloud SQL's connection pooling in transaction mode (private IP, port 6432). See the connection budget. Exclusive with `pooler`. |
| `database_high_availability` | false | A regional standby. |
| `database_disk_size_gb` | 10 | Disk size. |
| `max_connections` | 100 | The flag value, and what the budget is checked against. |
| `database_deletion_protection` | true | See Teardown. |
| `database_tls` | `ca-file` | `ca-file`, `unverified` or `off` (the last only with a pooler). |
| `pooler` | null | `{ host, port = 6432, server_pool_size = 20 }` of a PgBouncer you run. |
| `webhooks` | false | Generates `QCLOUD_WEBHOOK_KEY` into Secret Manager (secret `webhook-key`). The tick, the loop, the sender and the control plane's API read it; no worker does. |
| `tick_loop` | null | `{ instances = 1, pool_size = 2, cpu = "1", memory = "512Mi", env = {} }`: an always-on worker pool that runs `qcloud-tick loop`. Null: no loop. |
| `webhook_sender` | null | `{ instances = 2, pool_size = 2, cpu, memory, env }`: a worker pool that runs `qcloud-tick send`. Needs `webhooks`. Fixed count: nothing scales it on a backlog. |
| `subnet_cidr` | `10.10.0.0/24` | The workers' subnet. Checked against the instance count. |
| `abandon_peering_on_destroy` | false | Teardown aid. |
| `scheduler_schedule` | `* * * * *` | Cron expression of the scheduler job, UTC. |
| `notification_channels` | `[]` | Channel ids for the alert policies. Empty: they show incidents and notify nobody. |
| `runbook_base_url` | `docs/runbooks` | Where the runbooks are published. Every alert's text ends with a link to its runbook under this address. |
| `claim_latency_metric_type`, `failed_total_metric_type` | null | The Cloud Monitoring metric types your OpenTelemetry pipeline gives `qcloud.worker.claim_ms` and `qcloud.tick.jobs.failed_total`. Null: no "slow claims" or "jobs failing for good" alert ([observability](../../docs/observability.md#what-is-not-wired-for-you)). |
| `deployer_members` | `[]` | Who runs Terraform. Each gets `iam.serviceAccountUser` on the three service accounts. |
| `enable_apis`, `labels` | true, `{}` | Enable the APIs; extra labels. |

Outputs: `connection_budget`, `database_connection_name`, `database_private_ip`, `topic_name`,
`dead_letter_topic_name`, `subscription_names`, `dead_letter_subscription_names`, `tick_url`, `tick_audience`,
`worker_services`, `service_accounts`, `secret_ids`, `alert_policy_ids`, and `control_plane_inputs` (which carries the webhook key's secret id and version, never its value). None is secret.

## The connection budget

Every process holds a pool, and Postgres has a fixed number of connections. The budget module counts them from the
configuration and **refuses to plan** a fleet that needs more than `max_connections`; a warning appears above 80%.
It is the same arithmetic as `budget()` in `packages/store-postgres/src/connection/budget.ts`, and
`bun run check:terraform` compares the two for 10, 50 and 200 workers.

```
direct = sum over services of max_instances x (pool_size + listen_connections)
         + control_processes x control_pool_size + 6 reserved
pooled = pooler server_pool_size + sum of max_instances x listen_connections + 6 reserved
```

The six reserved connections are for administration, replication and the console. `LISTEN` connections cannot go through
a transaction pooler, so they count in both figures. On GCP nothing holds one: the Pub/Sub transport rings by message and
`QueueEvents` polls (one pooled statement per read), so `listen_connections` stays 0 unless a service runs the local
`postgres` transport or its own listener.

| Worker processes | Direct (pool 2, 3 control processes at 2) | Pooled (server pool 20) |
| --- | --- | --- |
| 10 | 32 | 26 |
| 50 | 112 | 26 |
| 200 | 412 | 26 |

Reading it: with the default `max_connections = 100`, a direct fleet tops out at 44 worker processes (pool 2: 2 x 44 + 6 + 6 = 100). 50
workers needs `max_connections` of at least 112 or a pooler; 200 workers needs a pooler. The ratio is the point: the
pooled figure does not grow with the fleet. A 25-connection shared-core tier would fit about 9 processes by the same
arithmetic. That is derived, not measured, and shared-core tiers have no SLA, which is why the default is
`db-custom-1-3840`.

**Recommendation:** add a pooler above about 80% of `max_connections`. This configuration does not create one (it would
be another paid, stateful service to own); set `pooler = { host = ... }` and it switches the processes to
`QCLOUD_DATABASE_POOLER=transaction`, gives each worker a direct URL in `QCLOUD_DATABASE_LISTEN_URL`, and counts the
pooled budget. Behind a transaction pooler, settings that a startup parameter cannot carry
(`search_path` for a non-default schema, `statement_timeout`, `lock_timeout`) belong on the database role with
`ALTER ROLE ... SET`; the driver refuses them as options and says so. This configuration runs no SQL, so it does not set
them per role: it sets the same three timeouts server-wide as database flags (`database_session_timeouts`), and the defaults
(schema `public`, the SDK's own deadlines) need nothing more. `database_tls = "off"` exists for a plaintext hop to a pooler on the private network only; the instance
itself always refuses plaintext.

**Managed pooling.** `database_managed_pooling = true` (with `database_edition = "ENTERPRISE_PLUS"`) turns on Cloud SQL's own pooler instead of one you run. Every process gets `QCLOUD_DATABASE_POOLER=transaction` and the pooler's port, and the budget counts Google's default of 50 server connections. The module sets only the on switch and does not set a pool size: Google's flag names for the size could not be checked here. It is the same transaction-mode discipline as above, and a feature Google lists as unsupported behind the pooler is the check to make before turning it on.

**The loop and the sender.** Each is a worker pool of the tick image with a fixed count, and each holds a pool of its own that the budget counts: `tick_loop.instances x pool_size` and `webhook_sender.instances x pool_size`. They log in with the same database user as the workers, so they also count against `worker_role_limit`.

**Capping the workers.** The `connection_budget` output has `worker_role_limit`, the worker share of the budget. Nothing here
creates a role or runs SQL (every process shares one database user), so the cap is an operator step: create a role for the
workers with `CONNECTION LIMIT` set to that value and point their connection string at it. The statements are in
[operations](../../docs/operations.md#connection-budget).

The value Cloud SQL accepts for `max_connections` depends on the tier's memory. An unsupported value fails at apply, not
at plan.

## Identities and roles

There is no project-level IAM and no primitive role (`owner`, `editor`, `viewer`) anywhere. Every binding is on one
resource. Five predefined roles are used:

| Service account | Role | On | Why |
| --- | --- | --- | --- |
| `<name>-workers` | `roles/pubsub.subscriber` | each queue's main subscription | Pull bells. |
| `<name>-workers` | `roles/pubsub.publisher` | the bells topic | A worker enqueues too (a job adds a job), and a retry rings a bell. |
| `<name>-workers` | `roles/secretmanager.secretAccessor` | the database URL, its CA, the listen URL | Read the connection strings. |
| `<name>-tick` | `roles/pubsub.publisher` | the bells topic | Ring bells for waiting and due jobs. |
| `<name>-tick` | `roles/secretmanager.secretAccessor` | the database URL and its CA, and the webhook key when `webhooks` is on | Same. The loop and the sender run as this account. |
| `<name>-scheduler` | `roles/run.invoker` | the tick service only | Call `POST /internal/tick`. |
| `deployer_members` | `roles/iam.serviceAccountUser` | the three service accounts | Deploy Cloud Run services that run as them. |
| Pub/Sub service agent | `roles/pubsub.publisher` / `subscriber` | the dead-letter topic / each main subscription | Dead-lettering is done by the service itself. |

Things that are deliberately absent:

- **No Cloud SQL role.** The workers connect to the private IP with a password over TLS, which Cloud SQL IAM does not
  govern. The Auth Proxy or the `/cloudsql` socket would need `roles/cloudsql.client`; this design uses neither.
- **No role to create subscriptions.** The SDK does not create them lazily in production (see Queues).
- **The control plane's identities** are in `control-plane/`, not here: `<name>-api` (publish to the bells topic, pull from
  the dead-letter subscriptions only, read its two secrets, and read Pub/Sub metrics through one custom role holding the
  single permission `monitoring.timeSeries.list`, the only project-level grant anywhere), `<name>-migrate` (read the direct
  URL and the CA), `<name>-panel` (no grants) and, when `ingest` is set, `<name>-ingest` (read the database secrets and the
  webhook key; no Pub/Sub role, since it stores what it is sent and rings nothing). `allUsers` holds `run.invoker` on the API,
  the panel and the ingest, by design: the application checks the token (the API) or the source's address and verification
  (the ingest), and `/health` and the ingest's `/healthz` are the only routes without one.

The webhook key is read by the tick account (the tick, the loop and the sender), by the control plane's API account and by the ingest's account, and by no worker account: a job's code cannot read the key that seals webhook secrets. It is a Terraform `random_id`, so it is in the state, like the database password. Back the state up: a lost key leaves every stored webhook secret unreadable until each is rotated.

The tick's URL is public, because Cloud Scheduler calls it from outside the VPC, but it accepts only an OIDC token
issued for the scheduler service account: Cloud Run IAM checks `run.invoker`, and the application checks the audience
(`QCLOUD_TICK_AUDIENCE`, the service URL) and the caller's email (`QCLOUD_TICK_ALLOWED_EMAILS`). The workers have
internal ingress only.

## Queues

Adding a queue is an infrastructure change: add it to `queues` and apply. The doorbell path (a subscription with a
filter, a dead-letter policy and a retry policy) must exist before a worker can hear that queue, and a queue not listed
has none. Names follow the transport's encoding, so a queue name is limited to letters, digits and dashes (the plan
refuses others).

- Names: topic `qcloud.<namespace>.bells`, dead-letter topic `qcloud.<namespace>.bells-dlq`, subscription
  `qcloud.<namespace>.sub.<queue>`, dead-letter subscription `qcloud.<namespace>.dlq.<queue>`. The plan check asserts
  these equal what `packages/transport-gcp` computes.
- A queue with `hot = true` has its own topic, `qcloud.<namespace>.hot.<queue>`, and an unfiltered subscription of the same name
  (the dead-letter side stays shared). The module's `hot_queues` output is the value of `QCLOUD_GCP_HOT_QUEUES`, which the
  example sets on every process and hands to the control plane (`hot_topic_names`). A subscription cannot change topic, so
  flipping `hot` replaces it: the tick rings what it held. Do it for a queue whose traffic makes the shared topic's filters cost.
- Each other subscription filters on `attributes.route = "<namespace>.<queue>"`. **A subscription's filter cannot be changed**,
  so changing it replaces the subscription; any bells in it are lost, and the tick re-rings what is waiting.
- Defaults: acknowledgement deadline 30 s, five delivery attempts then the dead-letter topic, retry backoff 1 to 10 s,
  no ordering, no exactly-once delivery, seven days of retention.
- The subscriptions never expire (`expiration_policy { ttl = "" }`). The SDK's dev helper `ensureQueue` does **not** set
  this, so a subscription it creates is deleted by Pub/Sub after 31 days without a pull. Use the Terraform for anything
  that lives.
- A dead-lettered bell is not a lost job: the job stays in Postgres and the tick rings it again. The `dead_letter_depth`
  alert fires because bells should not need dead-lettering at all.

## Scaling the workers

The workers are Cloud Run **worker pools**: instances that pull and need no request, no port and no ingress. A pool does
not scale by itself; it runs the instance count it was given (`manual_instance_count`). Terraform sets that count once,
from `min_instances`, and then ignores it (`ignore_changes`), so a later `apply` never undoes a scale-up. Three ways to
move it:

- **By hand:** `gcloud run worker-pools update <name>-<service> --region REGION --instances N` (read
  `gcloud run worker-pools update --help` for your gcloud version; the command may sit under `beta`).
- **From the backlog:** give the service `autoscaling = { queue = "default", backlog_per_instance = 10 }`. That adds
  Google's CREMA autoscaler (`modules/autoscaler`): one always-on Cloud Run service that, every 30 s, reads the queue's
  subscription backlog from Cloud Monitoring and sets the pool to `ceil(backlog / backlog_per_instance)`, between
  `min_instances` and `max_instances`. The config is generated from the same variables as the pool, so the two cannot
  disagree. The queue must exist in `queues`; the plan refuses a typo.
- **Not at all:** a fixed `min_instances` is the cheapest design for steady load.

**There is no hard ceiling on a pool.** Cloud Run ignores `max_instances` in manual mode, so the connection budget's
`max_instances` holds only while the autoscaler is the one setting the count and nobody runs `--instances` above it. A
person who does can take Postgres past `max_connections`. The `qcloud-max-instances` label on the pool records the figure
the budget counted, for whoever is about to do that. Cloud SQL's own connection limit is then the backstop, and what it
does at the limit is a refusal for the next connection, not an outage of the ones held.

## Delay precision

Cloud Scheduler's finest period is a minute, so with only the scheduler a delayed job can be up to a minute late. For
better, set `tick_loop = {}`: a worker pool runs `qcloud-tick loop`, a beat every second (`QCLOUD_TICK_INTERVAL_MS`, through the pool's `env`) with the retention steps every 30 s. The loop elects one leader with a lease on the
database clock, so any number of instances is safe; `instances = 2` gives failover, since only the lease holder ticks. The scheduler job stays: it is the cron source and the safety net if the loop is down. Measured
lateness for the loop is in [docs/spikes/06-phase0-gate.md](../../docs/spikes/06-phase0-gate.md).

## The container contract

What the services give a process (the names and meanings are those of `packages/maintenance/src/env.ts`):

| Variable | Set by | Value |
| --- | --- | --- |
| `PORT` | Cloud Run | The tick service only. A worker pool listens on nothing and gets no port. |
| `QCLOUD_DATABASE_URL` | Secret Manager | The connection string. Never in plain environment, logs or output. |
| `QCLOUD_DATABASE_POOL_SIZE` | Terraform | The service's `pool_size`: the number the budget counts. |
| `QCLOUD_DATABASE_POOLER` | Terraform | `none`, or `transaction` with `pooler`. |
| `QCLOUD_DATABASE_TLS_CA_FILE` | Terraform | `/etc/qcloud/db-ca/ca.pem`, a secret mounted as a file (mode 0400), for `ca-file`. |
| `QCLOUD_DATABASE_TLS` | Terraform | `unverified` or `off`, instead of the CA file. The two are mutually exclusive. |
| `QCLOUD_DATABASE_LISTEN_URL` | Secret Manager | The direct URL, when a pooler is used. |
| `QCLOUD_NAMESPACE`, `QCLOUD_TRANSPORT`, `QCLOUD_GCP_PROJECT` | Terraform | The tenant, `gcp-pubsub`, and the project. |
| `QCLOUD_TICK_AUDIENCE`, `QCLOUD_TICK_ALLOWED_EMAILS` | Terraform | The tick service only. |

The tick service has fixed one instance (`min 0`, `max 1`) and counts as one of the control processes. It runs the
maintenance CLI (`qcloud-tick serve`), from its own image or, with `tick_command`, from the Control API's. The worker image
is yours: it must read these variables and run the SDK's `Worker`. A worker pool has no ingress, so it needs no listener,
and its CPU is always allocated, because a worker polls and claims between requests. Cloud Run sends SIGTERM and waits a
fixed 10 s on a pool, less than the SDK's 20 s `close()` default: see [limits](../../docs/limits.md#6-delivery-guarantees).

## State and safety

- **The state contains secrets.** The database password and the Secret Manager values are in it, in plain text. Keep it
  in a bucket only operators can read, with object versioning on (`backend.tf.example`). Never commit a state file or a
  plan file; the repository ignores `*.tfstate`, `*.tfplan` and `*.tfvars`.
- **The database has `prevent_destroy`**, deletion protection in Terraform and in the API, and point-in-time recovery.
  A plan that would replace it is refused rather than executed.
- **Image rollout is a variable.** Change `worker_image` or a service's `image` and apply; Cloud Run starts a new
  revision of the pool. Rolling back is applying the old value. Workers claim with leases, so a
  revision that stops mid-job loses nothing: the lease expires and the tick returns the job to the queue.
- **Migrations are forward-only and safe with old workers connected**, so a rollout does not need a stop.
- A subnet that is too small is refused at plan: Direct VPC egress gives each instance an address, and a rollover
  briefly runs old and new revisions together, so the check is `2 x (sum of max_instances + 1)` against the subnet's
  usable addresses.

## Cost drivers

No prices are quoted here; they change. In order of weight:

1. **The database** is the floor and runs always. `database_high_availability` roughly doubles the instance cost. Disk,
   backups and point-in-time recovery logs add to it.
2. **Always-on worker CPU.** A worker pool bills its instances continuously, and a pool at zero instances wakes for
   nothing, because a polling worker has no request to wake it: the count is the cost. Start with `min_instances = 1`.
   The autoscaler is one more always-on instance (1 CPU, 512 Mi), about the price of one worker, so leave `autoscaling`
   off for a fleet of one or two and turn it on when the backlog is bursty and the fleet large.
3. **Pub/Sub, Secret Manager, the scheduler and monitoring** are small at this scale.

A pooler is a further service to run if you add one.

## Alerts

The six default policies: dead-lettered bells, bells waiting, database connections, scheduler job errors, scheduler job silent
(`tick_absent`) and bells waiting with no worker instance running. The first four read Google's own metrics; `tick_absent`
reads the scheduler job's log entries and `workers_idle_with_backlog` pairs the oldest bell with the workers' instance count.
Each links its runbook ([the index](../../docs/runbooks/README.md)). None has been seen to fire on a real project, the
thresholds are defaults, and a Cloud Run worker pool at zero instances and a log signal absent for a day are behaviours this
repository has not observed. The Control API's own alert (5xx) is in `control-plane/alerts.tf`.

## Teardown

The protections are on purpose, so destroying takes four deliberate steps:

1. Set `database_deletion_protection = false` and apply (the API flag changes in place).
2. Remove `prevent_destroy = true` from `modules/database/main.tf`. This is a lifecycle setting Terraform reads from
   source, so it cannot be a variable.
3. If the private services peering refuses to delete (Cloud SQL can release its end slowly, and `destroy` then fails
   with an error that the producer service is still using the connection), set `abandon_peering_on_destroy = true`, apply that, and then
   destroy. The peering is forgotten, not deleted; delete it by hand once the instance is gone.
4. `terraform destroy`. Take a backup you want to keep first: the backups go with the instance.

The enabled APIs stay enabled.

## Checks that run without a cloud

```bash
bun run check:terraform
```

Runs `terraform fmt -check`, `init -backend=false`, `validate`, a plan of `example/` with `ci.tfvars.example`, and 202
assertions on the plan and its variations (then the same for `control-plane/`, 131 more, see the runbook): the resources and their safety settings (private IP only, `ENCRYPTED_ONLY`, backups on, deletion
protection on, no public ingress for workers), the roles (only the five above, only on resources), the Pub/Sub names
against `packages/transport-gcp`, the budget against `budget()` in TypeScript, and the refusals: 60 instances over
`max_connections`, plaintext without a pooler, a subnet too small, a queue name the transport would encode.

It is hermetic: every `GOOGLE_*` and `CLOUDSDK_*` variable is dropped and the provider gets a placeholder token, so a
developer's real credentials are never used and nothing reaches a project. Without `terraform` installed it is skipped
with a warning, unless `QCLOUD_REQUIRE_TERRAFORM=1` (CI sets it). The provider lock file is committed for linux and
macOS, amd64 and arm64.

## Needs D9: what has never run

`terraform apply` has never been run: no resource was created. These facts can only be established against a real
project, and each is a step of the first apply:

1. **TLS hostname verification.** With `ca-file` the process verifies the server certificate against the mounted CA.
   Cloud SQL's certificate has its common name set and no usable subject alternative name, so whether verification with
   a private IP passes is unproven. If it does not, the fallback is `database_tls = "unverified"` (encrypted, not
   verified), and the finding goes in the gate document.
2. **Direct VPC egress to the private IP.** That a Cloud Run revision in the subnet reaches Cloud SQL through the peering.
3. **Dead-lettering with the service agent's grants.** That an unacknowledged bell reaches the dead-letter subscription
   after `max_delivery_attempts`.
4. **`max_connections` accepted** for the chosen tier.
5. **The tick's audience.** The OIDC audience is the deterministic URL `https://<name>-<project_number>.<region>.run.app`.
   A `check` block compares it with the service's real `uri` after apply and warns if they differ.
6. **OIDC accepted twice.** By Cloud Run IAM (the invoker role) and by the application (audience and email).
7. **`ttl = ""`** (never expire) accepted on the subscriptions by the provider and the API.
8. **The subnet sizing figure**, which is derived from the instance count, not measured on Cloud Run.
9. **The alert metric filters**: that each policy's metric and resource type exist and match what the services emit.
10. **The secret mount**: that the CA file appears at `/etc/qcloud/db-ca/ca.pem` with mode 0400 and the process can read
    it.
11. **The worker pool itself.** That the provider's `google_cloud_run_v2_worker_pool` creates with Direct VPC egress, the
    secret mounts and a manual count, that `ignore_changes` on the count keeps a later apply from resetting it, and how
    the pool replaces instances on a new revision (and so how many addresses a rollover needs).
12. **The autoscaler.** That CREMA 1.3 starts from this config, reads a Pub/Sub backlog with the service account's
    grants and sets the count. The resource path is written `workerPools` (the Admin API's spelling); Google's codelab
    writes `workerpools`. The image is a tag and not a digest. Its two project-wide read grants (every Parameter Manager
    parameter, and metrics) are broader than the rest.
13. **Shutdown inside 10 s.** That a worker given a SIGTERM and a fixed 10 s hands its leases back or leaves them to the
    stall check, and that the idle alert (`cloud_run_worker_pool`, `worker_pool_name`) matches what a pool emits.

14. **The loop and the sender.** That a worker pool starts the tick image with `args = ["loop"]` and `["send"]` over the image's entrypoint, reaches the database and Pub/Sub on the tick's account, and holds its fixed count.
15. **Managed pooling.** That Cloud SQL accepts `connection_pool_config` on this tier and edition, that the pooler listens on 6432 with the 50 server connections the budget counts, and what it does with this repo's statements. Enterprise Plus pricing and the pool-size flags were not looked up.
16. **The webhook key's secret.** That the loop, the sender and the API read it at start, and that the workers' account is refused.

The task's Result in `.claude/.planning/v1.0.0/21-infra-gcp.md` records what was run instead.
