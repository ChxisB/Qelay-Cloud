# Qelay-Cloud on AWS (Terraform)

Everything a Qelay-Cloud environment needs on AWS: a private RDS for PostgreSQL 16, an SQS queue and dead-letter queue per
Qelay queue (the "doorbell"), ECS Fargate services for the workers, a one-shot Fargate task for the maintenance tick with
EventBridge Scheduler as its clock, Secrets Manager for the connection string, least-privilege roles, and CloudWatch alarms.

Design: [DESIGN.md](../../DESIGN.md) section 7 (cloud specifics). Postgres is the authority on job state; SQS only tells a worker that
something may be waiting, and the tick repairs whatever a lost bell leaves behind.

**Status: planned and checked, never applied.** Applying creates paid, shared resources, which the repository's rules
reserve for an explicit go-ahead (decision D9). What was and was not run is listed in [Needs D9](#needs-d9-what-has-never-run).

## Layout

| Path | What it is |
| --- | --- |
| `example/` | A complete environment. Copy it, or call the modules from your own root. |
| `example/ci.tfvars.example` | The values of a fictional account, used by `bun run check:terraform`. Not a real environment. |
| `example/backend.tf.example` | An S3 backend with a partial configuration. |
| `modules/network` | VPC, private subnets, optional NAT, the S3 gateway endpoint, interface endpoints, the task and endpoint security groups. |
| `modules/database` | RDS instance, parameter group, subnet group, generated password, optional RDS Proxy. |
| `../modules/budget` | The connection budget (below), shared with `infra/gcp`. Refuses a plan that cannot fit. |
| `modules/messaging` | A queue and a dead-letter queue per Qelay queue, and the KMS key that encrypts them. |
| `modules/secrets` | Secrets Manager secrets and their versions. |
| `modules/iam` | Five roles, every policy on them, and the policy on every queue. |
| `modules/workers` | One ECS service per entry of `worker_services`, with optional queue-depth scaling. |
| `modules/tick` | The tick's task definition and log group. |
| `modules/scheduler` | The EventBridge Scheduler schedule that runs the tick every minute. |
| `modules/monitoring` | CloudWatch alarms and the tick's success metric. |
| `control-plane/` | The Control API and the panel as Fargate services behind one load balancer, and the migration as a one-off task. A root of its own, applied after this one: [README](control-plane/README.md). |

## What the example creates

| Module | Resources |
| --- | --- |
| network | `aws_vpc`, `aws_subnet` (private per zone; public per NAT zone), `aws_internet_gateway`, `aws_nat_gateway` and `aws_eip`, route tables, `aws_vpc_endpoint` (S3 gateway; SQS and Secrets Manager interface), `aws_security_group` x2 and their rules, `aws_default_security_group` with no rules |
| database | `aws_db_instance` (private, encrypted, backups, deletion protection, `prevent_destroy`) and `aws_db_parameter_group`; with `database_cluster`, `aws_rds_cluster` and `aws_rds_cluster_parameter_group` in their place; `aws_db_subnet_group`, `aws_security_group`, `random_password`; with `rds_proxy`: `aws_db_proxy` and its target group, target, role, secret and security group |
| messaging | `aws_sqs_queue` x2 per queue, `aws_sqs_queue_redrive_allow_policy`, `aws_kms_key` and alias (unless `queue_kms_key_arn` is given) |
| secrets | `aws_secretsmanager_secret` and `_version` for the database URL (and the direct URL with a proxy, and the webhook key with `webhooks`, a `random_id`) |
| iam | `aws_iam_role` x5, `aws_iam_role_policy` x7, `aws_sqs_queue_policy` on every queue and dead-letter queue |
| workers | `aws_ecs_service`, `aws_ecs_task_definition`, `aws_cloudwatch_log_group`, `aws_appautoscaling_target` per service; scaling policies and alarms for a service with `autoscaling`; Fargate Spot for a service with `spot` |
| tick | `aws_ecs_task_definition`, `aws_cloudwatch_log_group` |
| background | only with `tick_loop` or `webhook_sender`: the workers module again, once each, for the tick image (`aws_ecs_service`, `aws_ecs_task_definition`, `aws_cloudwatch_log_group`, `aws_appautoscaling_target` at one count) on the tick's roles |
| scheduler | `aws_scheduler_schedule` |
| monitoring | `aws_cloudwatch_metric_alarm`, `aws_cloudwatch_log_metric_filter` |

With the CI values this is 102 resources to add (91 without the webhook key, the loop and the sender). `aws_ecs_cluster` and its capacity providers (`FARGATE` and `FARGATE_SPOT`, no charge) are in the example itself.

## Quick start

1. **Prerequisites.** Terraform 1.5 or later, AWS credentials for the target account, and permission to create the
   resources above, including IAM roles: the deployer's own identity needs `iam:CreateRole`, `iam:PutRolePolicy` and
   `iam:PassRole`, which this configuration cannot grant it. The account id and the zones are not looked up, so a plan
   needs no credentials.
2. **Push the images first.** `worker_image` and `tick_image` must exist in a registry the tasks can reach before the
   services can start. The tick runs `qcloud-tick run` (the `maintenance` package): it is in the Control API's image
   (`packages/control-api/Dockerfile`), so set `tick_image` to that and
   `tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`. The container's command is always `["run"]`. The worker
   image is yours and runs the SDK's `Worker`; the repository ships none.
3. **Fetch the RDS CA bundle of your region.** See [TLS](#tls-to-the-database): put it in `database_ca_pem` (a heredoc in
   your `.tfvars` file). Fargate cannot mount a file, so the bundle travels as a plain environment value and no image has
   to carry it.
4. **Write your variables.** Start from `example/ci.tfvars.example`; change `account_id`, `region`, `availability_zones`,
   the images, `namespace`, `queues` and `worker_services`. Name the file anything ending `.tfvars` (the repository
   ignores those).
5. **Initialise with state in a bucket** (see [State and safety](#state-and-safety)):
   `cp example/backend.tf.example example/backend.tf`, then `terraform -chdir=example init -backend-config=...` as the
   file says.
6. **Plan and read it.** `terraform -chdir=example plan -var-file=prod.tfvars -out=plan.tfplan`. Check the budget output
   and the IAM changes.
7. **Apply in two steps.** The tick and the workers need a migrated database and an image to pull, and neither can be
   created by this configuration. First apply with `scheduler_enabled = false` and every service's `min_instances = 0`,
   migrate the schema (the control plane's one-off migration task, [control-plane/](control-plane/README.md); or run the SDK's
   migration from a host that can reach the private address), then apply again with the real values.

## Variables of the example

| Variable | Default | Meaning |
| --- | --- | --- |
| `account_id`, `region`, `availability_zones` | required | The account (12 digits; the provider refuses any other), the region, and at least two zones. |
| `name` | `qcloud` | Prefix of every resource: 2 to 20 characters. |
| `namespace` | `default` | `QCLOUD_NAMESPACE`: the tenant, and part of every queue name. |
| `queues` | `{ default = {} }` | The queues that get a doorbell path. Per queue: `visibility_timeout_seconds` 30, `max_receive_count` 5, `retention_seconds` 345600, `dead_letter_retention_seconds` 1209600. |
| `queue_kms_key_arn` | null | An existing customer-managed key for the queues; null creates one with rotation. |
| `worker_image`, `tick_image`, `tick_command` | image required | See Quick start. |
| `image_repository_arns` | `[]` | ECR repositories the execution roles may pull from. Empty for another registry (which needs `egress = "nat"`). |
| `cpu_architecture` | `X86_64` | `ARM64` is accepted; the images must match. |
| `worker_services` | `{ worker = { max_instances = 10 } }` | Per service: `min_instances` 1, `max_instances`, `pool_size` 2, `listen_connections` 0, `cpu` 512, `memory` 1024, `env`, `image`, `spot` false, and `autoscaling = { queue, scale_out_above 100, scale_in_below 10, ... }`. |
| `control_processes`, `control_pool_size` | 4, 2 | Processes beyond the services that hold a pool: two ticks that may overlap and two Control API instances (task 43). |
| `database_instance_class` | `db.t4g.small` | The cost floor. A burstable class (`db.t*`) runs in Unlimited mode, so a CPU that stays busy is billed for surplus credits: the `database-cpu-credits` alarm says when. |
| `database_multi_az` | false | A synchronous standby, at about double the instance cost. |
| `database_session_timeouts` | `{ statement_ms = 30000, lock_ms = 5000, idle_in_transaction_ms = 30000 }` | Server-wide `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`, in milliseconds, 0 = off. The migrator lifts the statement timeout for its own transaction, so a slow index build is bounded only by its own deadline. Whether the cloud accepts all three flags was not run (`terraform plan` only). |
| `database_cluster` | null | `{ instance_class, storage_type, iops }`: a Multi-AZ DB cluster (a writer and two readable standbys) in place of the instance. No default for any field, no storage autoscaling, and exclusive with `rds_proxy` and `database_multi_az`. See [Multi-AZ DB cluster](#multi-az-db-cluster). |
| `database_storage_gb`, `database_max_storage_gb`, `database_backup_retention_days` | 20, 100, 7 | Storage, its autoscaling ceiling, and point-in-time recovery's window. |
| `max_connections` | 100 | Set on the parameter group (applies at the next reboot) and checked against the budget. |
| `database_deletion_protection` | true | See [Teardown](#teardown). |
| `database_tls`, `database_ca_pem`, `database_ca_file` | `ca-pem`, `""`, `/etc/ssl/certs/rds-global-bundle.pem` | How processes verify the database, the region's CA bundle (PEM text, at most 16,000 characters) and the file a `ca-file` image carries. See [TLS](#tls-to-the-database). |
| `webhooks` | false | Generates `QCLOUD_WEBHOOK_KEY` into Secrets Manager (secret `webhook-key`). The tick, the loop, the sender and the control plane's API read it; no worker does. |
| `tick_loop` | null | `{ instances = 1, pool_size = 2, cpu = 512, memory = 1024, env = {} }`: an always-on ECS service that runs `qcloud-tick loop`. Null: no loop. |
| `webhook_sender` | null | `{ instances = 2, pool_size = 2, cpu, memory, env }`: an ECS service that runs `qcloud-tick send`. Needs `webhooks`. A fixed count: nothing scales it on a backlog. |
| `rds_proxy` | null | An RDS Proxy in transaction mode. See [The connection budget](#the-connection-budget). |
| `vpc_cidr` | `10.20.0.0/16` | Each zone's private subnet is a sixteenth of it. |
| `egress`, `nat_per_az`, `interface_endpoints` | `nat`, false, computed | See [Cost drivers](#cost-drivers). |
| `scheduler_schedule`, `scheduler_enabled` | `rate(1 minute)`, true | The tick's clock, `rate(N minutes)`; `false` creates it paused. A slower rate is the main saving on the tick and is safe only when the workers run the tick in process: see [The tick's schedule](#the-ticks-schedule). The tick alarm follows the rate. |
| `alarm_actions` | `[]` | SNS topic ARNs. Empty: alarms show state and notify nobody. |
| `runbook_base_url` | `docs/runbooks` | Where the runbooks are published. Every alarm's description ends with a link to its runbook under this address. |
| `claim_latency_metric`, `failed_total_metric` | null | `{ namespace, name }` of the CloudWatch metrics your pipeline gives `qcloud.worker.claim_ms` and `qcloud.tick.jobs.failed_total`. Null: no "slow claims" or "jobs failing for good" alarm ([observability](../../docs/observability.md#what-is-not-wired-for-you)). |
| `additional_principal_arns` | `[]` | Roles the queue policies must not deny: the Control API's task role, an operator. They still need their own identity policy. **For the control plane, list `arn:aws:iam::<account id>:role/<control plane name>-api-task`**: the role does not exist yet, and a deny that names an ARN holds for a role created later. `infra/aws/control-plane` checks that it makes exactly that role. |
| `secrets_kms_key_arn` | null | A customer-managed key for the secrets; null uses `aws/secretsmanager`. |
| `offline_plan` | false | Plan with no credentials and no call to AWS. For CI; never for an apply. |

Outputs: `connection_budget`, `database_address`, `database_proxy_endpoint`, `queue_names` / `_urls` / `_arns` and the
`dead_letter_` equivalents, `queue_kms_key_arn`, `tick_target` (the schedule, cluster, task family, subnets and security
group), `worker_services`, `role_arns`, `processes` (each process's plain environment and the names of its secret
variables), `secret_names`, `alarm_arns` and `control_plane_inputs`: what `infra/aws/control-plane` takes, identifiers and
secret ARNs, never a value (the webhook key's secret among them; the account, region, name and namespace; the network: VPC, private subnets, the tasks group,
CIDR, zones, the internet gateway and the egress mode; the cluster; the queue and dead-letter queue ARNs and their key;
the database secrets and the TLS environment; the rollout trigger; and the connection budget's control-process figures).
It carries no queue URL and no CA file path: the control plane resolves queues by name and receives the CA by value.
`terraform -chdir=example output -json control_plane_inputs > ../control-plane/data-plane.auto.tfvars.json` hands it over
(the control plane's own check keeps the two sides in step).

## The connection budget

Every process holds a pool, and Postgres has a fixed number of connections. The budget module counts them from the
configuration and **refuses to plan** a fleet that needs more than `max_connections`; a warning appears above 80%. It is
the same arithmetic as `budget()` in `packages/store-postgres/src/connection/budget.ts`, and `bun run check:terraform`
compares the two for 10, 50 and 200 workers, with and without a listener per process.

```
direct = sum over services of max_instances x (pool_size + listen_connections)
         + control_processes x control_pool_size + 6 reserved
pooled = proxy share of max_connections + sum of max_instances x listen_connections + 6 reserved
```

The AWS example counts four control processes (two overlapping ticks, two Control API instances) where the GCP example
counts three, so its figures are two connections higher:

| Worker processes | Direct (pool 2, 4 control processes at 2) | Direct with a listener each |
| --- | --- | --- |
| 10 | 34 | 44 |
| 50 | 114 | 164 |
| 200 | 414 | 614 |

With the default `max_connections = 100`, a direct fleet tops out at 43 worker processes. Nothing on AWS holds a `LISTEN`
connection (the SQS transport rings by message), so `listen_connections` stays 0 unless a service runs the local
`postgres` transport.

**The task-05 choice.** [Spike 05](../../docs/spikes/05-db-access-and-delay.md) names RDS Proxy as the AWS pooler, to be
adopted "after a real run confirms what pins", because RDS Proxy pins a client to one server connection on `nextval`
(which grouped-job admission calls) and the pooling is then gone for that client. So `rds_proxy` is **off by default**.
Set it and the tick and the workers connect to the proxy with `QCLOUD_DATABASE_POOLER=transaction`, and each worker also
gets the instance's own address in `QCLOUD_DATABASE_LISTEN_URL`. The budget then counts the proxy's share of
`max_connections` (`max_connections_percent`, default 50), which is the most it may open to the instance:
56 at `max_connections = 100`.

What transaction pooling disables, from spike 05: named prepared statements (the driver is told `prepare: false`),
session-level advisory locks (the SDK takes only transaction-level ones), `LISTEN` on the pooled connection, and settings
a startup parameter would carry (`search_path`, `statement_timeout`): those belong on the database role with
`ALTER ROLE ... SET`, which this configuration does not run. It sets the three timeouts server-wide in the parameter group instead
(`database_session_timeouts`), and the defaults need nothing more. How often pinning occurs under
this workload is **unmeasured**.

**Capping the workers.** The `connection_budget` output has `worker_role_limit`, the worker share of the budget. Nothing here
creates a role or runs SQL (every process shares one database user), so the cap is an operator step: create a role for the
workers with `CONNECTION LIMIT` set to that value and point their connection string at it. The statements are in
[operations](../../docs/operations.md#connection-budget).

The RDS `max_connections` parameter is static: a change is applied at the next reboot of the instance, not at the apply.
The value RDS accepts depends on the instance's memory; an unsupported value fails at apply, not at plan.

## Identities and permissions

Five roles, no AWS-managed policy, no IAM user or access key, no wildcard action, and no `*` resource except the two
actions that take none. Every statement below is asserted by `bun run check:terraform`.

| Role | Statement | Actions | Resource | Why |
| --- | --- | --- | --- | --- |
| `<name>-workers-task` | `ConsumeAndRing` | `sqs:GetQueueUrl`, `GetQueueAttributes`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `SendMessage` | the queues | Hear bells, drop them, extend them, and ring (a job adds a job; a retry rings). `SendMessageBatch` is authorised by `SendMessage`. |
| | `ReadDeadLetterDepth` | `sqs:GetQueueUrl`, `GetQueueAttributes` | the dead-letter queues | The transport's stats read the depth. It cannot receive from them. |
| | `ReadQueueMetrics` | `cloudwatch:GetMetricData` | `*` | The age of the oldest bell is a CloudWatch metric, and metric reads take no resource. |
| | `QueueKey` | `kms:GenerateDataKey`, `kms:Decrypt` | the queue key | Producers need both, consumers decrypt. Condition: `kms:ViaService = sqs.<region>.amazonaws.com`. |
| `<name>-tick-task` | `Ring` | `sqs:GetQueueUrl`, `SendMessage` | the queues | The tick only rings; it opens the transport ring-only, so it never reads CloudWatch. |
| | `QueueKey` | as above | the queue key | Same. |
| `<name>-workers-execution` | `RegistryLogin` | `ecr:GetAuthorizationToken` | `*` | The action is account-wide. |
| | `PullImage` | `ecr:BatchCheckLayerAvailability`, `GetDownloadUrlForLayer`, `BatchGetImage` | `image_repository_arns` | Only when the list is not empty. |
| | `WriteLogs` | `logs:CreateLogStream`, `PutLogEvents` | the workers' log groups | ECS writes the container's output. |
| | `ReadSecrets` | `secretsmanager:GetSecretValue` | the database secrets, `<name>-??????` | ECS reads them at task start. The suffix is Secrets Manager's six random characters. |
| | `DecryptSecrets` | `kms:Decrypt` | `secrets_kms_key_arn` | Only with a customer-managed key; `ViaService = secretsmanager`. |
| `<name>-tick-execution` | the same four | | the tick's log group (and those of the loop and the sender), the database URL, and the webhook key with `webhooks` | The tick does not read the direct URL. The loop and the sender run as the tick's roles. |
| `<name>-scheduler` | `RunTheTick` | `ecs:RunTask` | `task-definition/<name>-tick:*` | Start the tick. Condition: `ecs:cluster` is this cluster. |
| | `PassTheTicksRoles` | `iam:PassRole` | the tick's task and execution roles | `RunTask` passes them. Condition: `iam:PassedToService = ecs-tasks.amazonaws.com`. |

Every role trusts one service and names the account (`aws:SourceAccount`) against a confused deputy; the scheduler role
also names the one schedule (`aws:SourceArn`).

**The queues' own policies.** Each queue refuses plaintext (`aws:SecureTransport`), and refuses the four message actions
(`ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `SendMessage`) to everyone except the two task roles and
`additional_principal_arns`. A deny holds whatever another policy in the account grants, so an administrator's wildcard
does not reach a bell. It leaves the management actions (create, tag, purge, delete) to the account's own policies, so
Terraform and an operator can still manage the queues. A dead-letter queue's policy refuses plaintext and says nothing else.
Whether SQS's own redrive into a dead-letter queue is unaffected by these denies, and whether it works with a
customer-managed key on the dead-letter queue, has **not been verified against SQS**.

The webhook key is read by the tick's execution role and by the control plane's API execution role, and by no worker role: a job's code cannot read the key that seals webhook secrets. It is a Terraform `random_id`, so it is in the state, like the database password. Back the state up: a lost key leaves every stored webhook secret unreadable until each is rotated.

Deliberately absent:

- **No RDS permission.** A process connects to the private address with a password over TLS, which IAM does not govern.
  IAM database authentication is off.
- **No way for a worker to read a dead-letter queue's messages.** A dead-lettered bell is a metric, never replayed.
  Peeking belongs to the Control API: its role (`<name>-api-task`, made by `control-plane/`) is in
  `additional_principal_arns` and has its own policy there, limited to `ReceiveMessage` on the dead-letter queues, which it
  never deletes from and reads with a visibility timeout of 0.
- **No rotation.** The database secret is generated once. Rotating it by hand means changing the master password, applying
  the new secret version (a changed version rolls the services, which read their secrets only at start), and restarting
  the scheduled tick's next run. Not exercised.
- **The proxy's role** (with `rds_proxy`) reads the proxy's credential secret and decrypts it with `ViaService`; with the
  AWS-managed key the key's ARN is not known to a plan, so that one `kms:Decrypt` names `key/*` in the account.

## Queues

Adding a queue is an infrastructure change: add it to `queues` and apply. The transport never creates a queue, so a
worker or a bell for a queue that is not listed fails with "queue does not exist". Names follow the transport's encoding,
so a queue name is limited to letters, digits and dashes (the plan refuses others).

- **Names, tags and settings equal `ensureQueue`** (`packages/transport-aws/src/provision.ts`) and `queueNames`
  (`names.ts`): `qcloud-<namespace>__<queue>` and `...__dlq`, or, when the dead-letter name would pass 80 characters, the
  hashed form `qcloud-h-<slug>-<20 hex of sha256>` that this module reproduces with `sha256(jsonencode([namespace, queue]))`.
  Both carry `qelay:namespace` and `qelay:queue`. Defaults: visibility timeout 30 s, five receives then the dead-letter
  queue, four days' retention (fourteen on the dead-letter queue). The plan check compares every field with
  `queueNames`, including a hashed name whose slug ends in a hyphen.
- **What Terraform adds** that `ensureQueue` does not: encryption with a customer-managed key (rotation on;
  `kms_data_key_reuse_period_seconds` 300), a redrive allow policy (`byQueue`) on each dead-letter queue, and the policies
  above.
- **A dead-lettered bell is not a lost job.** The job stays in Postgres and the tick rings it again. The
  `dead_letter_depth` alarm fires because bells should not need dead-lettering at all.
- **Delay.** SQS delays a message up to 900 seconds (`DelaySeconds`), so a delayed job or a retry backoff inside that window
  rides its own bell and is late only by the broker's lateness. A longer delay, cron, lease recovery and the re-ring wait
  for the tick, and EventBridge Scheduler's finest period is a minute, so those are up to about a minute late, never early
  ([DESIGN.md](../../DESIGN.md) "Delayed jobs and cron"). A worker that runs the tick in process (opt-in) narrows that.

## Alarms

Alarms only change state unless `alarm_actions` lists SNS topics; the example creates none (a topic and its subscribers are
a choice of whoever runs it).

| Alarm | Fires when | Means |
| --- | --- | --- |
| `<name>-<queue>-dead-letter-depth` | any bell is in the dead-letter queue (maximum over 5 minutes, above 0) | Delivery failed `max_receive_count` times. The job is still in Postgres and the tick rings it again; this is how often it happened. |
| `<name>-<queue>-dead-letter-age` | the oldest dead-lettered bell is over an hour old | Nobody is watching the dead-letter queue. |
| `<name>-<queue>-queue-age` | the oldest bell has waited over 15 minutes, two periods running | No worker takes bells for this queue (scaled to zero, crashed, or paused). |
| `<name>-database-connections` | connections stay above 80% of `max_connections` for 5 minutes | The budget above no longer holds, or something leaks. |
| `<name>-database-free-storage` | under 10% of `database_storage_gb` is free | Storage autoscaling (to `database_max_storage_gb`) is about to act. |
| `<name>-database-cpu` | CPU above 80% for 15 minutes | |
| `<name>-database-cpu-credits` (burstable classes only) | the surplus-credit balance stays above 0 for 15 minutes | The class has spent its credits and RDS bills the surplus: steady queue load wants a larger or a non-burstable class. |
| `<name>-<service>-no-tasks` | the service has reported no CPU (no running task) for 5 minutes; missing data counts as breaching | A worker service is empty. |
| `<name>-workers-idle-with-backlog` | composite: some queue's `queue-age` alarm is firing AND every listed worker service's `no-tasks` alarm is | Bells wait and no worker runs. Quiet while any one service runs; the queue's own `queue-age` alarm still catches that. |
| `<name>-slow-claims` (opt-in) | the 99th percentile of the claim metric you name is over `claim_latency_p99_ms` for 5 minutes | Jobs start late. |
| `<name>-jobs-failing-for-good` (opt-in) | the rate of the failed-jobs total you name is over `dlq_growth_per_window` per window | Jobs are using up their attempts. |
| `<name>-tick-stalled` | no tick reported `"ok": true` for 5 minutes, or three schedule periods if longer (missing data counts as breaching) | The tick fails, never starts, or the schedule is disabled. Delayed jobs past 900 s, cron and lease recovery are not running. |

A service with `autoscaling` also gets `<name>-<service>-queue-deep` and `-queue-shallow` alarms on the visible-message count, which
drive its step scaling and which no one needs to watch. The queue metrics and `DatabaseConnections` are CloudWatch's
own; the thresholds are defaults and **unproven against real load**.

## TLS to the database

The instance accepts only encrypted connections (`rds.force_ssl = 1`, written down although it is the default). Fargate
injects secrets as environment variables and has no file mount, so the default (`database_tls = "ca-pem"`) hands the
certificate authority to every process **by value**: `QCLOUD_DATABASE_TLS_CA`, the PEM text of the bundle of your region
(`https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`, a few kilobytes), from `database_ca_pem`. A
certificate is public, so it is a plain environment value, not a secret. The global bundle (about 170 KB) does not fit a
task definition, and the plan refuses a bundle over 16,000 characters. Behind `rds_proxy` the bundle must also hold Amazon's
root CAs (<https://www.amazontrust.com/repository/>), which sign the proxy's certificate. Other modes:
`"ca-file"` verifies against the file at `database_ca_file` (`QCLOUD_DATABASE_TLS_CA_FILE`; an image you build has to carry
it), `"unverified"` encrypts without verifying, and `"off"` is plaintext and accepted only with `rds_proxy` (the instance
refuses plaintext, so only a proxy that speaks TLS to it can be reached that way). Exactly one of the three variables
(`QCLOUD_DATABASE_TLS_CA`, `QCLOUD_DATABASE_TLS_CA_FILE`, `QCLOUD_DATABASE_TLS`) reaches a process. **Not verified against a
real RDS instance** (D9): that the region bundle is enough for an instance, and that the proxy's chain is complete with
the Amazon roots added.

## The container contract

What the services give a process (the names are those of `packages/maintenance/src/env.ts` and `docs/limits.md`):

| Variable | Set by | Value |
| --- | --- | --- |
| `QCLOUD_DATABASE_URL` | Secrets Manager (the task definition's `secrets`) | The connection string. Never in plain environment, logs or output. |
| `QCLOUD_DATABASE_LISTEN_URL` | Secrets Manager | The direct URL, with `rds_proxy` (workers only). |
| `QCLOUD_DATABASE_POOL_SIZE` | Terraform | The service's `pool_size`: the number the budget counts. |
| `QCLOUD_DATABASE_POOLER` | Terraform | `none`, or `transaction` with `rds_proxy`. |
| `QCLOUD_DATABASE_TLS_CA`, `QCLOUD_DATABASE_TLS_CA_FILE` or `QCLOUD_DATABASE_TLS` | Terraform | The CA bundle by value (default), a CA file in the image, or `unverified` / `off`. Mutually exclusive. |
| `QCLOUD_NAMESPACE`, `QCLOUD_TRANSPORT`, `QCLOUD_AWS_REGION` | Terraform | The tenant, `aws-sqs`, and the region (never read from `AWS_REGION`). |
| `QCLOUD_TICK_MAX_RUN_MS` | Terraform | 20000, the tick only. |

Credentials for SQS come from the task role through the SDK's default chain. `QCLOUD_AWS_SQS_ENDPOINT` is not set.

**The tick is a one-shot task, not a service.** `qcloud-tick serve` verifies a Google OIDC token and cannot be called from
EventBridge, so on AWS the schedule runs `qcloud-tick run` as a Fargate task every minute: it takes the lease, runs one
tick for at most 20 seconds, prints one JSON report line to stdout and exits 0, 1 or 2. Overlapping ticks are safe
(the leader is elected by a lease row) and counted in `control_processes`. A missed minute is not replayed
(`maximum_retry_attempts = 0`, event age 60 s). The `tick_stalled` alarm fires when no run reports `ok` for five minutes.
The tick opens the transport ring-only, so it makes no CloudWatch call.

The worker image is yours: it must read these variables, listen on nothing, and run the SDK's `Worker`. A service's tasks
read their secrets once, at start; a changed secret version rolls the service (`force_new_deployment` with a trigger on
the version), with `maximum_percent = 100` and `minimum_healthy_percent = 0` so a rollover never runs more tasks than
`max_instances` (the budget counts that number), at the price of a gap while the old tasks stop. Workers claim with leases,
so a task that stops mid-job loses nothing: the lease expires and the tick returns the job to the queue.

**Subnets.** Every task takes an address from a private subnet, and a rollover leaves stopped tasks' network interfaces
for a while, so the plan refuses a `vpc_cidr` whose subnet has fewer usable addresses than
twice the sum of every `max_instances` plus two ticks (AWS keeps five addresses of each subnet). That figure is derived,
not measured on Fargate.

## State and safety

- **The state contains secrets.** The database password and the Secrets Manager values are in it, in plain text. Keep it
  in a bucket only operators can read, with versioning and default encryption on (`backend.tf.example`). Never commit a
  state or plan file; the repository ignores `*.tfstate`, `*.tfplan` and `*.tfvars`.
- **The database has `prevent_destroy`**, deletion protection in Terraform and in the API, a final snapshot on deletion,
  and point-in-time recovery. A plan that would replace it is refused rather than executed.
- **The provider refuses any other account** than `account_id` (`allowed_account_ids`).
- **Image rollout is a variable.** Change `worker_image` or a service's `image` and apply; ECS starts the new tasks and
  rolls back by itself if they do not stabilise (the deployment circuit breaker). Rolling back is applying the old value.
- **Migrations are forward-only and safe with old workers connected**, so a rollout does not need a stop.
- **`offline_plan` is for CI.** It makes the provider take placeholder keys and skip every call, so nothing it plans is
  real. Never apply with it.

## Cost drivers

Prices change and none are checked here. The ones below are **list prices as remembered for us-east-1, unverified**; those of
`eu-west-2` and today's differ. In order of weight:

1. **The database** is the floor and runs always. `database_multi_az` roughly doubles the instance cost. Storage, backups
   beyond the free allowance, and Performance Insights (off by default: not every burstable class offers it, and an
   unsupported class fails at apply) add to it.
2. **The NAT gateway** is the other fixed cost: about $0.045 an hour (about $33 a month) plus about $0.045 per GB it
   processes. `egress = "none"` removes it, along with the internet gateway and the public subnets.
3. **Interface endpoints** cost about $0.01 an hour per zone plus about $0.01 per GB. The default creates two (SQS, Secrets
   Manager) in two zones: about $29 a month.
4. **Fargate.** A worker service at the minimum bills its tasks continuously. The tick bills a task for at least a minute
   (Fargate's minimum) every minute: about $9 a month at 0.25 vCPU and 0.5 GB, and about 43,200 task launches a month.
   Two levers cut this, both off by default: a [slower tick](#the-ticks-schedule) and [Spot workers](#spot-workers).
5. **SQS, Secrets Manager, KMS, CloudWatch and EventBridge Scheduler** are small at this scale. SQS's requests come mostly
   from long-polling receives.

**What the endpoints do and do not save.** With a NAT gateway every AWS call from a task goes through it and is charged
per GB. An interface endpoint keeps that service's traffic off the NAT, so it saves the per-GB part of the NAT charge and
adds an hourly charge per zone. At a small scale the hourly charges dominate: two endpoints in two zones cost about as much
as the NAT gateway itself, so the endpoints do **not** lower the floor. They pay for themselves only when SQS and Secrets
Manager traffic is large, and they are worth having for another reason, that the traffic then never leaves AWS's network.

`egress = "none"` removes the NAT gateway entirely, and the tasks then reach AWS only through endpoints. It needs five
(SQS, Secrets Manager, CloudWatch Logs, `ecr.api` and `ecr.dkr`) and the free S3 gateway endpoint (image layers are in S3);
the plan refuses the setting with fewer. Five endpoints in two zones is about $73 a month, more than a NAT gateway with two
endpoints at low traffic. It buys the property that no task has any route to the internet, not a lower bill. A task that
asks for queue statistics also needs a `monitoring` endpoint, and an image from another registry needs a NAT.

## The tick's schedule

The tick is a one-shot Fargate task that EventBridge Scheduler starts: at the default `rate(1 minute)` that is about 43,200
task launches a month, each billed for at least a minute. When the loop runs (`tick_loop = {}`, an ECS service of the tick image that runs `qcloud-tick loop`, or a `TickLoop` in
the worker's host), the scheduled tick
is the safety net and can be slower: `scheduler_schedule = "rate(5 minutes)"` is a fifth of the launches.

What a slower rate costs: with no loop running, delayed jobs past the SQS window, retries, cron entries and
lease recovery wait up to N minutes and not one. Without an in-process tick, leave it at a minute. The `tick-stalled`
alarm follows the rate (three missed periods, five minutes at the least). Only `rate(1 minute)` and `rate(N minutes)` are
accepted; the plan refuses a cron expression or seconds.

## The loop and the sender

`tick_loop` and `webhook_sender` each add an ECS service of the tick image (`tick_command` is its entry point), a fixed
count, no scaling policy and no public address. They run as the tick's roles, so the workers' roles see neither the key
nor their log groups. Each holds a pool of its own that the budget counts (`instances x pool_size`), and they log in with
the same database user as the workers, so they are counted in `worker_role_limit` too. The loop elects one leader with a
lease: two instances give failover and still tick once. There is no alarm for a missing task of either: a loop that
stops goes unnoticed while the schedule still ticks (the `TickSucceeded` alarm watches both), and the composite "workers
idle with backlog" alarm is not fed by them on purpose.

## Multi-AZ DB cluster

`database_cluster = { instance_class, storage_type, iops }` replaces the instance with an `aws_rds_cluster` (a writer and
two readable standbys in three zones, semi-synchronous). AWS documents up to twice as fast a commit as a Multi-AZ instance
with one standby and a failover typically under 35 seconds. Processes connect to the writer endpoint. The storage is the
size `database_storage_gb` and does not autoscale, and `rds_proxy` and `database_multi_az` are refused beside it. A
database already created as an instance is moved to `aws_db_instance.main[0]` by a `moved` block and is untouched. Going
from an instance to a cluster is a new database, not an edit: dump and restore it.

Nothing here could check a cluster against an account. These are unverified: the instance class, storage type and IOPS
for your region and engine version (so none has a default); the CloudWatch dimension of the cluster's metrics (the alarms
use `DBClusterIdentifier`, and if the metrics sit under the member instances the alarms report no data instead of
firing); and whether an RDS Proxy can sit in front of a cluster (the module does not try).

## Spot workers

`spot = true` on a worker service (default false) runs its first `min_instances` tasks on demand and every task above
them on **Fargate Spot**, which is priced lower (the discount varies: check the pricing page). It is a capacity-provider
strategy, `FARGATE` with a base of `min_instances` and `FARGATE_SPOT` with all the weight above it.

- AWS can take a Spot task back with a two-minute warning. The task gets `SIGTERM` and ECS waits `stop_timeout_seconds`
  (60 by default, 120 at the most). A worker that finishes or hands back its job in that time loses nothing; one that does
  not leaves a lease that expires, and the stall check gives the job to another worker, so a handler must tolerate a second run.
- **There is no on-demand fallback.** When Spot capacity is short the service waits for it. The `queue-age` alarm catches
  the backlog; the `no-tasks` alarm watches the service, and the on-demand floor keeps it from reaching zero. Keep
  `min_instances >= 1` for a service that must not stop.
- Switching an existing service between a launch type and a capacity-provider strategy can replace the service: read the plan.

## Teardown

The protections are on purpose, so destroying takes four deliberate steps:

1. Set `database_deletion_protection = false` and apply (the API flag changes in place).
2. Remove `prevent_destroy = true` from `modules/database/main.tf`. This is a lifecycle setting Terraform reads from
   source, so it cannot be a variable.
3. `terraform destroy`. The instance takes a final snapshot named `<name>-pg-final`; a snapshot of that name that already
   exists makes the destroy fail, so delete the old one first. The automated backups go with the instance: copy any
   you want to keep first.
4. Secrets Manager keeps a deleted secret for seven days (`recovery_window_in_days`), and a KMS key created here is
   scheduled for deletion after 30 days (`deletion_window_in_days`); recreating a secret with the same name inside its
   window fails until it passes. A deleted key's queues become unreadable, so destroy the queues first (Terraform does).

Nothing else outlives the destroy: the S3 state bucket and the images are yours.

## Checks that run without a cloud

```bash
bun run check:terraform
```

Runs `terraform fmt -check`, `init -backend=false`, `validate`, and a plan of `example/` with `ci.tfvars.example` and each
variation below, with 860 assertions on them for AWS (then the same for `infra/gcp` and both control planes, see their
READMEs). The assertions are the policy scan: no policy scanner (`tflint`, `trivy`, `checkov`) was available, and none is run.

- **Identities and policies:** every statement of every role and queue policy as listed above, no wildcard action, `*` only
  for the two actions that take no resource, no IAM user, group or managed policy.
- **Database:** PostgreSQL 16, encrypted, deletion protection, backups, a final snapshot, no public address, no IAM
  authentication, `max_connections` and `rds.force_ssl` in the parameter group, no inbound rule from the internet anywhere.
- **Queues:** names, tags, visibility, retention and redrive against `queueNames`, plain and hashed; encryption; one alarm
  of each kind per queue.
- **Processes:** each one's environment, that a connection string appears only as a secret, the tick's command and
  schedule, rollover limits, and the services' scaling.
- **Budget:** against `budget()` in TypeScript for 10, 50 and 200 workers, with and without listeners, and behind the proxy.
- **Background and cluster:** the loop and the sender's command, count, roles and secrets, that no worker role reads the webhook key, and a plan with `database_cluster` (a cluster and no instance, its parameter group, the cluster dimension on the alarms).
- **Variations:** an existing queue key (whose grants are then readable), a proxy, plaintext through the proxy, a CA
  file in the image (`ca-file`), `unverified`, `egress = "none"`, a hashed queue name.
- **Refusals:** a fleet over `max_connections`, plaintext without a proxy, a subnet too small, a queue name the transport
  would encode, scaling on a queue that is not listed, a malformed account id, no route out with too few endpoints, a
  retention SQS would refuse, no CA bundle, one too big for a task definition, a cluster beside a proxy or `database_multi_az`, and a sender without `webhooks`.

It is hermetic: every `AWS_*` variable is dropped, the metadata service is switched off, and the provider takes placeholder
keys (`offline_plan`), so a developer's real credentials are never used and nothing reaches an account. Without `terraform`
installed it is skipped with a warning, unless `QCLOUD_REQUIRE_TERRAFORM=1` (CI sets it). The provider lock file is committed
for linux and macOS, amd64 and arm64.

## Needs D9: what has never run

`terraform apply` has never been run: no resource was created, so nothing is running and nothing is owed a teardown. The
plan was made with placeholder credentials and never contacted AWS. These facts can only be established against a real
account, and each is a step of the first apply:

1. **Everything an apply checks that a plan cannot:** that the provider accepts each value (the `max_connections` for the
   instance class, Performance Insights on the class, the RDS CA identifier), that the names are free, and that the
   service quotas allow it.
2. **Image start-up.** That a task starts from the images, takes the CA bundle from its environment, and reaches the instance and SQS.
3. **TLS verification** against the instance with the RDS bundle, and against a proxy with the bundle plus the Amazon roots.
4. **The queue policies' denies and SQS's own redrive**, and redrive into a dead-letter queue encrypted with a
   customer-managed key. `aws:PrincipalArn` for an assumed role is the role's ARN, not the session's; that the deny lets
   the task roles through is unproven.
5. **The scheduler.** That EventBridge Scheduler starts the task in the private subnets with the roles it passes, and that
   the tick finishes inside the minute.
6. **Scaling.** That the step policies and the queue-depth alarms add and remove tasks as intended.
7. **The alarms' metrics.** That each metric name and dimension matches what AWS emits, including
   `ApproximateAgeOfOldestMessage` and the tick's `TickSucceeded` metric filter.
8. **RDS Proxy pinning** against this workload, which decides whether the proxy is worth enabling.
9. **The subnet sizing figure**, which is derived from the task count, not measured on Fargate.
10. **Reaching the private database** to migrate or to investigate: this configuration has no bastion. ECS Exec, SSM or a
    VPN is a decision for whoever runs it.
11. **The costs above,** which are unverified list prices.
12. **Spot.** That a service with the strategy starts on both providers, that a reclaimed task drains inside
    `stop_timeout_seconds`, and how often Spot capacity is missing in your region and size.
13. **The credit alarm.** That `CPUSurplusCreditBalance` is emitted for the class and that the alarm does not flap.
14. **A tick rate other than a minute,** and the alarm period that follows it.

15. **The loop and the sender.** That an ECS service starts the tick image with the entry point and `loop` or `send`, reaches the database and SQS under the tick's roles, and holds its count.
16. **The Multi-AZ cluster.** That the provider and RDS accept the cluster with the class, storage and IOPS given, that the parameter group applies, what the cluster's CloudWatch metrics are named, and how a failover looks to the writer endpoint's clients.
17. **The webhook key's secret.** That the tick's execution role and the API's execution role read it at start, and that a worker's is refused.

The task's Result in `.claude/.planning/v1.0.0/42-infra-aws.md` records what was run instead.
