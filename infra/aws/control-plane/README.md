# The Qelay-Cloud control plane on AWS (Terraform)

The Control API and the panel as ECS Fargate services behind one Application Load Balancer, and the schema migration as a
one-off task. It is a root of its own that sits beside the data plane ([`../example`](../README.md)), not inside it: the
data plane is applied once and rarely, the control plane every time a build is released.

Same behaviour as the GCP control plane ([`../../gcp/control-plane`](../../gcp/README.md), runbook [deploy-gcp.md](../../../docs/runbooks/deploy-gcp.md)): the same two
images (nothing here is cloud-specific, the broker is chosen by `QCLOUD_TRANSPORT=aws-sqs`), the same environment contract,
the same panel build (it reads `/config.json` at start-up, so only configuration differs), the same smoke test steps
([`scripts/smoke-aws.ts`](../../../scripts/smoke-aws.ts)). Operations: [`docs/runbooks/deploy-aws.md`](../../../docs/runbooks/deploy-aws.md).

**Status: planned and checked, never applied.** Applying creates paid, shared resources, which the repository's rules reserve
for an explicit go-ahead (decision D9). What was and was not run is listed in [Needs D9](#needs-d9-what-has-never-run).

## Layout

| File | What it holds |
| --- | --- |
| `variables.tf` | Every input. The first block, "From the data plane", is the handover below. |
| `main.tf` | Locals, the plan-time preconditions (the budget, the subnets, the timeouts), and the check that the API's role is the one the data plane admits. |
| `alb.tf` | The load balancer, its two subnets (public mode), its security group, the listeners, the two host rules and the two target groups. |
| `api.tf` | The API's log group, task definition and ECS service. |
| `panel.tf` | The panel's log group, task definition and ECS service. |
| `migrate.tf` | The migration's task definition. It has no service: it is run by hand, as a release step. |
| `iam.tf` | Four roles: the API's task role and three execution roles (API, panel, migration). |
| `outputs.tf` | The URLs, the redirect URIs to register, the load balancer's name for DNS, the migration's `run-task` inputs. |
| `ci.tfvars.example` | The values of a fictional account, used by `bun run check:terraform`. Not a real environment. |

## What it creates

With the CI values this is 36 resources to add: the load balancer, two listeners, two host rules, two target groups, its
security group and rules (and, in public mode, two subnets, a route table and a route to the data plane's internet gateway),
two ECS services, three task definitions, three log groups, four IAM roles and their policies. The ECS cluster, the VPC, the
database, the queues, the tick and its schedule belong to the data plane.

## Handover from the data plane

```bash
terraform -chdir=infra/aws/example output -json control_plane_inputs > infra/aws/control-plane/data-plane.auto.tfvars.json
```

`control_plane_inputs` is exactly the set of "From the data plane" variables: identifiers and secret **ARNs**, never a
value. `*.auto.tfvars.json` files are loaded without a flag. `scripts/check-terraform-control-plane-aws.ts` keeps the two
sides in step: it plans the data plane's example, compares its `control_plane_inputs` key by key to the control plane's
variables, and fails if one side gains or loses a name.

Then write the rest (the images, the identity provider, the certificate and the two host names) in a `.tfvars` file of your
own, starting from `ci.tfvars.example`.

**One value goes the other way.** The data plane's queue policies deny `SendMessage`, `ReceiveMessage` and the rest to
everyone except its two task roles and `additional_principal_arns`. The Control API sends bells and peeks at the dead-letter
queues, so its role must be in that list, in the data plane's variables:

```hcl
additional_principal_arns = ["arn:aws:iam::<account id>:role/<name>-api-task"]
```

with this root's `name`. The role does not exist when the data plane is applied, which is fine: a deny with an ARN condition
holds for a role created later. If the ARN is missing or misspelled the API starts, `/health` answers, and every call to a
queue is denied (the Transport page shows the error). A `check` in `main.tf` asserts, at plan time, that this root makes a
role with exactly that name and the default path.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `account_id`, `region`, `name`, `namespace` | required (from the data plane) | The account (the provider refuses any other), the region, the prefix of every resource, `QCLOUD_NAMESPACE`. |
| `api_image`, `panel_image` | required | The images of tasks 36 (`packages/control-api/Dockerfile`, `packages/panel/Dockerfile`). Push them first; use a digest or an immutable tag. |
| `image_repository_arns` | `[]` | ECR repositories the execution roles may pull from. Empty for another registry (which needs `egress = "nat"`). |
| `cpu_architecture` | `X86_64` | `ARM64` is accepted; the images must match. |
| `oidc_issuer`, `oidc_audience`, `oidc_jwks_url` | required | What the API checks a token against. `oidc_audience` is a list. |
| `oidc_client_id`, `oidc_authority`, `oidc_scope`, `oidc_token_audience` | client id required | What the panel signs in with. `oidc_authority` defaults to the issuer. |
| `role_claim`, `operator_roles`, `viewer_roles` | null (the API's defaults) | Which claim carries roles, and which values mean operator or viewer. |
| `jwks_reachable_in_vpc` | false | Only for a data plane with `egress = "none"`: you have made the identity provider's signing keys reachable. |
| `exposure` | `public` | `public` or `private`. See [Exposure](#exposure). |
| `certificate_arn`, `api_hostname`, `panel_hostname` | required | An ACM certificate (in this region) that covers both names, and the two names. DNS is yours: point both at `alb_dns_name`. |
| `ingress_cidrs` | null | Who may reach the load balancer. Null: `0.0.0.0/0` when public, the VPC's range when private. |
| `alb_subnet_slot` | 12 | The first of the sixteen equal slots of `vpc_cidr` the load balancer's subnets take (public mode). The data plane's NAT subnets take 8 and up. |
| `alb_idle_timeout_seconds` | 60 | Must be at least twice `event_heartbeat_seconds`. See [Timeouts](#timeouts). |
| `alb_deletion_protection` | false | Turn on for a real environment; then `terraform destroy` fails until it is off. |
| `api_instances`, `api_pool_size` | 2, 2 | A **fixed** count: the connection budget counts these processes, so there is no autoscaling. `api_instances + 2 <= budgeted_control_processes`. |
| `api_event_streams` | 50 | Open event streams per task. |
| `event_stream_lifetime_seconds`, `event_heartbeat_seconds` | 600, 15 | See [Timeouts](#timeouts). |
| `shutdown_grace_seconds` | 8 | How long the API drains before it exits; the container's `stopTimeout` is this plus 10 s. |
| `api_cpu`, `api_memory`, `panel_instances`, `panel_cpu`, `panel_memory`, `migrate_cpu`, `migrate_memory` | 512/1024, 2, 256/512, 512/1024 | Fargate sizes (valid pairs only). |
| `extra_cors_origins`, `panel_csp_connect_extra` | `[]` | Exact origins beyond the panel's own: another front end calling the API; an AI provider the panel may connect to. |
| `monitoring_read` | true | Let the API read the queues' CloudWatch metrics (`cloudwatch:GetMetricData`, the only wildcard resource). Off: ages on the Transport page are blank. |
| `alert_api_errors`, `api_errors_per_minute` | true, 5 | The alarm on the API's own 5xx answers (target group), and how many a minute for five minutes make it fire. An unproven default; never seen to fire on a real account. |
| `alarm_actions`, `runbook_base_url` | `[]`, `docs/runbooks` | Where the alarm notifies (empty: it shows state and tells nobody), and where its description's runbook link points. |
| `fleet` | null | The workers' size, for the Deployment page's connection budget. Null: the page reports no fleet. |
| `log_retention_days` | 30 | |
| `offline_plan` | false | Plan with no credentials and no call to AWS. For CI; never for an apply. |

## Exposure

`/health` is the only route without a token. The API checks a signed token on every other route, in every mode; the panel
serves public static files and `/config.json` (an issuer, a client id and the API's URL: no secret, and no more than the
panel's JavaScript already carries). The exposure mode decides only what stands in front of that check.

| Option | How | Default |
| --- | --- | --- |
| **Public HTTPS, application-layer OIDC** | `exposure = "public"`: an internet-facing ALB in two subnets of its own, HTTPS only (port 80 redirects), TLS 1.3 policy, open to `ingress_cidrs`. Every request to the API needs a token from your identity provider. | **Yes** |
| **Private only** | `exposure = "private"`: an internal ALB in the data plane's private subnets, reachable from the VPC (peering, VPN, Transit Gateway, or a bastion). Needs no internet gateway. | |
| **Edge rate limit** (WAF) | `edge_rate_limit_per_minute = n`: a regional web ACL on the load balancer with one rule, requests per minute from one client address over the API and the panel together. Over it the load balancer answers 429 with `Retry-After: 60` before a task sees the request. Null by default: no WAF and no charge. The API's own limiter stays on as the second layer (it is per task and per principal). The plan is checked, never applied (D9); whether 1200 is the right number for your clients is yours to measure. | |
| **ALB OIDC action** in front of both | An `authenticate-oidc` rule on the listener, so the load balancer signs users in before a request reaches a task. **Not implemented**: it puts the identity provider's client secret in Terraform state, it signs browsers in by cookie and does not replace the API's own bearer-token check (a script has no cookie), and the API would check tokens anyway. A private listener is the better second layer. | |

Whatever the mode, the load balancer drops invalid header fields and runs the strictest desync mitigation; the default action
of the HTTPS listener is a 404, so a request for another host name goes nowhere; the two hosts are routed by host name only.

**The tick.** Nothing here authenticates the tick, because there is nothing to authenticate. On AWS the tick is not a service:
the data plane's EventBridge Scheduler starts a Fargate task each minute that runs `qcloud-tick run` once and exits (retry 0,
event age 60 s), in the private subnets, with no listener and no inbound rule. A caller that cannot connect cannot be an
attacker. `qcloud-tick serve`, which verifies a Google-signed token, is not used on AWS. Who may start the task is IAM: only the
scheduler's role can pass the tick's roles.

## Timeouts

A browser's event stream is a long response. The numbers must nest, from the inside out:

| Setting | Value | Why |
| --- | --- | --- |
| Heartbeat comment on a stream | 15 s | Keeps every hop's idle timer reset. |
| Stream closed by the server | 600 s | The client reconnects with `Last-Event-ID`; it bounds how long one client can hold a stream slot. |
| Bun server idle timeout | 255 s (its maximum) | The API's own, never reached by a stream that heartbeats. |
| ALB idle timeout | 60 s (at least 30 s: twice the heartbeat) | The plan refuses less than twice the heartbeat. |
| Target deregistration delay | 30 s | In-flight requests finish before a task leaves the group. |
| Shutdown grace / container `stopTimeout` | 8 s / 18 s | The API closes its streams at the grace; Fargate waits the grace plus 10 s before it kills the task. |

A stream open at a rollover is cut at the grace and reconnects to another task. That is by design, not an error.

## Identities

Four roles; each statement names its resources (`*` only for `ecr:GetAuthorizationToken` and `cloudwatch:GetMetricData`, which
take none), and none carries an `iam:` or `sts:` action.

| Role | Can | Cannot |
| --- | --- | --- |
| `<name>-api-task` | `SendMessage`, `GetQueueUrl`, `GetQueueAttributes` on the doorbell queues; `GetQueueUrl`, `GetQueueAttributes`, `ReceiveMessage` on the dead-letter queues (a peek: visibility 0, never deleted); `GetMetricData`; the queue key through SQS only. | Delete or receive from a doorbell. Read a secret. Reach RDS (the connection string comes in as an environment secret). |
| `<name>-api-execution` | Pull the image, write its log group, read the database secret (and decrypt it through Secrets Manager). | Anything at run time. |
| `<name>-panel-execution` | Pull the image, write its log group. | Read a secret. The panel has no task role. |
| `<name>-migrate-execution` | As the API's execution role, for the migration's log group and the direct (else the main) database secret. | |

The deployer's own identity needs `iam:CreateRole`, `iam:PutRolePolicy` and `iam:PassRole` for these four roles, which this
configuration cannot grant it.

## Migration

`terraform apply` never migrates. The migration is a one-off Fargate task (`<name>-migrate`, command `["migrate"]`, one
connection, the direct URL when the data plane has an RDS Proxy) that the release runs **before** it points the services at
a new image, with `aws ecs run-task` (the `migrate` output has its inputs), and waits for it with `aws ecs wait tasks-stopped`.
A serving task never migrates. The runbook has the commands, and the check of its exit code.

A migration is forward-only and safe with the previous release connected (repository rule), so a rollback is a redeploy of the
previous image, never a down migration: an older API against a newer schema stays ready and says so on the Deployment page.

## Cost floor

Unverified list prices (us-east-1, on-demand, x86; eu-west-2 is roughly 10 to 15 percent higher), a month of 730 hours. What
this root adds at its defaults, with nothing else running:

| Item | Basis | About |
| --- | --- | --- |
| Application Load Balancer | $0.0225 per hour, plus $0.008 per LCU-hour (a few LCU for a console) | $17 to $20 |
| Fargate, API | 2 tasks of 0.5 vCPU and 1 GB: $0.04048 per vCPU-hour, $0.004445 per GB-hour | $36 |
| Fargate, panel | 2 tasks of 0.25 vCPU and 0.5 GB | $18 |
| Fargate, a migration | Seconds of a 0.5 vCPU task, a few times a month | under $1 |
| CloudWatch Logs | Ingestion $0.50 per GB: a quiet environment writes well under 1 GB | $1 to $3 |
| **This root** | | **about $75 a month** |

On top of that, the data plane's network: a NAT gateway is $0.045 per hour (about $33 a month, per gateway) plus $0.045 per GB
that passes it. The control plane shares the data plane's gateway (it needs the identity provider's signing keys, ECR, and
CloudWatch through it), so it adds data processing, not a second gateway. The data plane's database, queues and workers are
costed in [`../README.md`](../README.md#cost-drivers). A public load balancer holds a public address per zone, which AWS
bills at $0.005 per hour each (about $7 a month for two). With one API and one panel task (`api_instances = 1`,
`panel_instances = 1`) the floor falls by about $27, and the rollover stops being zero-downtime (the API's rollover is then
0 percent minimum, 100 percent maximum).

These are list prices copied into a document, not a bill: check the pricing pages for your region before you decide.

## Checks that run without a cloud

```bash
bun run check:terraform
```

includes this root: `terraform fmt -check`, `init -backend=false`, `validate`, a plan of `ci.tfvars.example` and thirteen
variations (private, restricted ingress, a customer-managed secrets key, SQS-managed queue encryption, no monitoring read, a
registry that is not ECR, one API task, a longer idle timeout, a pooled database with and without a direct URL, a CA file,
plaintext to a pooler (accepted, as in the data plane), and a closed network), with assertions on them as the policy scan (no `tflint`, `trivy` or
`checkov` was available), and 22 refusals. It is hermetic: every `AWS_*` variable is dropped and the provider takes
placeholder keys (`offline_plan`).

- **Services:** the image of each, every environment value, a secret only by reference, no credential in an environment
  value, no emulator endpoint or development token, the panel's and the migration's settings, ECS counts, rollover limits,
  circuit breaker, private subnets, no public address.
- **Ingress:** HTTPS only on a TLS 1.3 policy with a certificate, a 404 default, a redirect from port 80, exactly two host-only
  rules, target groups on `/health`, security group rules (the only inbound rule on the tasks' group is 8080 from the load
  balancer's), no NAT, endpoint or address allocated here, the idle timeout against the heartbeat.
- **Identities:** the four roles above, their trust (ECS tasks in this account), every statement scoped, no `iam:`/`sts:`.
- **Handover:** the control plane's variables against the data plane's `control_plane_inputs`, that the data plane admits
  `<name>-api-task`, and that the connection budget's numbers are equal.

## Needs D9: what has never run

Nothing here has been applied, and no AWS account was contacted (the lock file's hashes came from the Terraform registry).

1. **Everything an apply checks that a plan cannot:** names that are free, quotas, that the provider accepts each value, that
   the certificate covers both host names and is in this region.
2. **Image start-up.** That the images start on Fargate, find their secrets, and reach the database and SQS.
3. **The load balancer path.** That a request reaches a task through the host rules, that an event stream survives the idle
   timeout for 600 s, and that a rollover cuts streams only at the grace.
4. **The API's queue access** through the data plane's deny policies: a deny that names a role ARN is assumed to admit a role
   created later, and `aws:PrincipalArn` of an assumed role is assumed to be the role's ARN. Both are unproven.
5. **CloudWatch metric names and dimensions** the Transport page reads (`ApproximateAgeOfOldestMessage`, the queue-name
   dimension), and how long they lag (about five minutes).
6. **The RDS CA bundle** (region bundle by value, ≤ 16,000 characters) against a real instance, and, behind RDS Proxy, the
   bundle with the Amazon roots added.
7. **Deployment of a new image,** a rollback, a secret rotation and a teardown: the runbook's commands are written, not run.
8. **The slot arithmetic** for the load balancer's subnets (slot 12 of sixteen) against a data plane that really exists.
9. **The costs above.**
10. **DNS and the certificate.** Both are yours; no record is created here.

The smoke test has run against a local stack only (`bun run scripts/smoke-aws.ts --local`: the images' entrypoints as
processes, an SQS emulator in place of SQS, a loopback issuer). The task's Result in
`.claude/.planning/v1.0.0/43-control-plane-aws.md` records what was run.
