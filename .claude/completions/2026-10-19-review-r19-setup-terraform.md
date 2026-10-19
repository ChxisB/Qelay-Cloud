# R19: the setup recommendations in Terraform (review GCP and AWS setup tables)

Date: 2026-10-19. Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.

## What changed

- **The loop and the sender (both clouds).** `tick_loop` (`qcloud-tick loop`) and `webhook_sender` (`qcloud-tick send`) are
  variables of both examples, default null. Each is a fixed count (min = max) of tasks of the tick image on the tick's identity:
  GCP as `google_cloud_run_v2_worker_pool` through `modules/workers` (new `command` and `args`), AWS as ECS services through
  `modules/workers` (new `entry_point`, `command` and the matching outputs). Each holds a pool the budget counts.
- **The webhook key.** `webhooks = true` makes `QCLOUD_WEBHOOK_KEY` (a Terraform `random_id`, 32 bytes) a secret named
  `webhook-key`. The tick, the loop, the sender and the control plane's API read it; no worker identity does (asserted by the plan
  checks). The control planes take it as `webhook_key_secret` (an object on GCP, a full ARN on AWS), and `control_plane_inputs`
  carries the reference, never the value. A sender without `webhooks` is refused.
- **GCP database.** `database_edition` and `database_managed_pooling` (Cloud SQL `connection_pool_config`, Enterprise Plus
  only, refused otherwise and refused beside `pooler`). A managed pool counts 50 server connections in the budget and puts
  `QCLOUD_DATABASE_POOLER=transaction` on every process.
- **AWS database.** `database_cluster = { instance_class, storage_type, iops }` swaps the instance for an `aws_rds_cluster` (Multi-AZ
  DB cluster) with its own parameter group, the writer endpoint, and the alarms on `DBClusterIdentifier`
  (`modules/monitoring` takes a `database_dimension`). `aws_db_instance.main` is `count`ed with a `moved` block, so an existing
  instance is not touched. Cluster and `rds_proxy` or `database_multi_az` are refused.
- **IAM (AWS).** The tick execution role may write the loop's and sender's log groups (`tick_extra_log_groups`) and read the key.
- **Plan checks.** New `scripts/terraform-plan-background.ts` (GCP) and `scripts/terraform-plan-aws-background.ts` (AWS: the two
  services, the cluster variant, three refusals); the GCP check has four new plans (managed pooling, both poolers, managed pooling
  without Enterprise Plus, a sender without the key). The budget variations switch the loop and sender off to count the workers
  alone; the base plans count them (`BACKGROUND = 3` tasks on AWS).
- **Docs.** `infra/gcp/README.md`, `infra/aws/README.md` (resources, variables, budget, identities, new sections, D9 items),
  both deploy runbooks, `operations.md`, `limits.md`, `DESIGN.md`. Resource counts with the CI values: GCP 67, AWS 102.

## Verify

- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform` (plan only, placeholder credentials, nothing contacted): GCP 202, AWS 860,
  GCP control plane 131, AWS control plane 2665 checks pass.
- `terraform fmt -recursive infra` clean, `bun run format:check`, `bun run docs:check` clean.

## Not done / owed

- `terraform apply`, any real Cloud SQL or RDS run, and a real-cloud start of the loop or sender (D9).
- **Unverified against a real account:** Cloud SQL managed pooling (flag names beyond the on switch, the 50-connection default,
  what the pooler does with this repo's statements; no pool-size flag is set); the AWS cluster variant (instance class, storage
  type and IOPS for a region and version, whether the cluster's CloudWatch metrics sit under `DBClusterIdentifier`, whether a proxy
  can front a cluster). Pricing was not looked up and no dollar figure is in the docs.
- The sender is a fixed count: nothing publishes a delivery backlog to scale it on. No missing-task alarm exists for the loop or
  the sender (a stopped loop is hidden while the schedule still ticks).
- The key is in the Terraform state; a lost key makes every stored webhook secret unreadable. Rotation of the key itself is not built.
- Going from an AWS instance to a cluster is a new database (dump and restore), not an edit; no migration path is built.
- The loop and the sender log in as the workers' database user, so they use up its connection limit (counted in
  `worker_role_limit`); a separate role is an operator step.
