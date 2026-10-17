# 42 — Infra: AWS Terraform

**Status:** done locally (planned offline with placeholder credentials, never applied: needs D9) · **Depends on:** 40, 20 · **Phase:** 3

## Goal

Reproducible AWS infrastructure for one Qelay-Cloud environment, equivalent to task 21: database, queues, workers, scheduler, identities and secrets.

## Scope

In: Terraform modules and an example environment under `infra/aws/`, validated and planned in CI without credentials.
Out: applying to a real account (D9); the control-plane service (task 43).

## Steps

1. **Modules:** `network` (VPC, private subnets, endpoints for SQS and Secrets Manager), `database` (RDS PostgreSQL 16 or Aurora PostgreSQL, private, encrypted, automated backups, deletion protection, parameter group with `max_connections` from task 05, optional RDS Proxy; record the choice from task 05 and what transaction pooling disables),
   `messaging` (standard queues per Qelay queue, a dead-letter queue with a redrive policy, KMS encryption, queue policies limited to the worker and tick roles),
   `workers` (an example ECS Fargate service per D1 with the SDK's environment, autoscaling on queue depth as an input),
   `scheduler` (EventBridge Scheduler rule at 1 minute invoking the tick: an ECS scheduled task, or an API destination to the tick endpoint with IAM or a signed header),
   `secrets` (Secrets Manager for the database credential with rotation as an option), `iam`, `monitoring` (CloudWatch alarms as inputs for task 71).
2. **Identities, least privilege:** separate task roles for workers (receive and delete on their queues, send on their queues, read one secret), the tick (send, plus database access), and the scheduler (invoke or run the tick only). Resource-level ARNs, no wildcards on resources where an ARN is known.
3. **Queue provisioning:** queues come from a `queues` variable (name, visibility timeout, `maxReceiveCount`, retention). Adding a queue is an infra change; same rule as task 21.
4. **Safety:** remote state backend as a variable; `deletion_protection` and `prevent_destroy` on the database; outputs for the endpoint, queue URLs and ARNs, and the tick target.
5. **CI:** `terraform fmt -check`, `validate`, plan against no-credential configuration; `tflint` and a policy scan if available in your other projects.
6. **Docs:** `infra/aws/README.md`: variables, apply order, cost drivers (RDS and NAT gateway are the floor; show how endpoints avoid NAT charges), teardown. The `terraform-iac` skill's checklists apply.
7. **Apply (needs D9):** only with an account supplied and an explicit go-ahead. Run task 22's scenario suite against it, then tear down or hand over per instruction; record what was created.

## Acceptance

- `terraform validate` passes and `terraform plan` shows the expected resources.
- Every IAM statement is scoped and justified in the README; no `*` resource where an ARN exists.
- The database is encrypted with deletion protection and backups in the plan; queues are encrypted.
- Applying, if done, leaves nothing running unintentionally; the Result lists what exists.

## Verify

```bash
terraform -chdir=infra/aws/example fmt -check -recursive
terraform -chdir=infra/aws/example init -backend=false && terraform -chdir=infra/aws/example validate
```

## Risks / notes

- Do not apply or destroy without D9 and an explicit instruction.
- NAT gateways quietly dominate small-environment cost; prefer VPC endpoints and say so.
- RDS Proxy in transaction mode disables session features (advisory locks, `LISTEN/NOTIFY`). Task 05 decides; do not enable it by default if the tick leader lock or `LISTEN` depends on session state.

## Result

**Done locally: the environment is written, formatted, validated and planned (86 resources to add with the CI values), and 685 assertions on
the plan pass. Nothing was applied (step 7 needs D9 and an account), no AWS call was made (the plan runs with placeholder credentials and
`offline_plan`), so no resource exists and nothing is owed a teardown.** Findings are in the dated amendment of
[the gate document](../../../docs/spikes/06-phase0-gate.md). Guide: [infra/aws/README.md](../../../infra/aws/README.md).

**Built** (`infra/aws/`)

- **Modules:** `network` (VPC, private subnets per zone, optional NAT, S3 gateway and interface endpoints, security groups), `database` (RDS
  PostgreSQL 16, private, encrypted, backups, deletion protection and `prevent_destroy`, final snapshot, parameter group with `max_connections`
  and `rds.force_ssl`, generated password, optional RDS Proxy), `messaging` (queue and dead-letter queue per entry of `queues` with
  `ensureQueue`'s names, tags and settings, redrive policy and allow policy, KMS key), `secrets`, `iam` (five roles, seven inline policies, a
  policy on every queue), `workers` (ECS Fargate service per entry of `worker_services`, optional step scaling on queue depth), `tick` (task
  definition running `qcloud-tick run`), `scheduler` (EventBridge Scheduler, one minute, runs the tick), `monitoring` (queue, dead-letter,
  database and tick alarms). `infra/modules/budget` is shared with GCP.
- **`infra/aws/example/`:** a complete environment with an `offline_plan` switch for CI, a partial S3 backend example, `ci.tfvars.example`
  (a fictional account) and a lock file for linux and macOS on amd64 and arm64. Outputs: connection budget, database address, queue names,
  URLs and ARNs (and the dead-letter ones), the queue key, the tick target, role ARNs, each process's environment, secret names, alarm ARNs and
  the inputs for task 43.
- **`scripts/check-terraform-plan-aws.ts`** and four assertion modules (`terraform-plan-aws-{model,iam,queue-policies,data,services}.ts`):
  hermetic (no `AWS_*`), plans the base environment and each variation, asserts every IAM statement, the database, the network, the queues
  against `queueNames`, each process's environment, the scheduler, the alarms and the connection budget against the TypeScript `budget()`, and
  eight refusals. `bun run check:terraform` runs GCP, AWS and control-plane checks; the CI `terraform` job runs it (now "GCP and AWS").
- **`infra/aws/README.md`:** layout, resources, quick start and apply order, every variable, the connection budget and the RDS Proxy choice, an
  IAM table with the reason for every statement (the only `*` resources: `ecr:GetAuthorizationToken`, `cloudwatch:GetMetricData`, and the
  proxy role's `kms:Decrypt` on `key/*` when no customer-managed key is given), queues, alarms, TLS, the container contract, state and safety,
  cost drivers, teardown, the checks, and what needs D9.

**Checked**

- `terraform -chdir=infra/aws/example fmt -check -recursive`: clean. `init -backend=false` and `validate`: valid.
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform`: GCP 110, AWS 685, control-plane 108 checks pass (AWS about 100 s). Mutations of the
  example (storage not encrypted, `sqs:*`, a public address) each fail the check; they were restored.
- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0 (1,216 files within 300 lines).
- `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_SQS=1 QCLOUD_REQUIRE_PUBSUB=1 bun test`: **3,949 pass, 29 skip, 1 todo, 0 fail**, 417 files, 883 s (unchanged from task 41: this task adds no TypeScript under test). The 29 skips are the PgBouncer and TLS suites (Docker, owed).

**Acceptance**

- `validate` passes and the plan shows the expected resources: yes (86, listed by module in the README). Every IAM statement is scoped and
  justified in the README; the three `*` cases are named there. The database is encrypted with deletion protection, backups and a final
  snapshot in the plan; the queues are encrypted (with a key created in the plan, or the one given). Applying was not done, so there is nothing
  running and nothing to list.

**Decisions**

- The tick on AWS is a one-shot Fargate task (`qcloud-tick run`) started by EventBridge Scheduler, because `serve` verifies Google tokens.
- `control_processes` defaults to 4 on AWS (two overlapping ticks and two Control API instances).
- RDS Proxy is off by default and unmeasured (task 05 and spike 05 said to measure first); with it on, workers get a direct listen URL.
- Egress defaults to a NAT gateway plus SQS and Secrets Manager endpoints; `egress = "none"` needs five endpoints. The README says the
  endpoints do not lower the floor at small scale (unverified list prices).

**Found**

- The RDS CA bundle must be in the container image (Fargate has no secret file mount) and no Dockerfile in the repository has it. Open.
- The queue policies' deny, SQS's own redrive and a customer-managed key on a dead-letter queue are unverified against SQS.
- No `tflint` or policy scanner was available; the plan assertions are the policy scan.

**Owed (D9)**

- Step 7: an apply with an account and an explicit go-ahead, then task 22's scenario suite against it (task 43 builds the stack), and a
  teardown. The first apply also settles: provider-accepted values (`max_connections` for the class, Performance Insights, CA identifier),
  image start-up with the CA file, TLS verification (instance and proxy), the queue deny and redrive, the scheduler's task start and its
  duration, scaling, alarm metric names, RDS Proxy pinning, subnet sizing under rollover, operator access to the private database, and costs.
- Secret rotation, a migration job on AWS, the CI `terraform` job run on GitHub, and the Terraform checks on a second machine.
