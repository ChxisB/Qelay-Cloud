# Runbook: deploy the control plane on AWS

The Control API, the panel and the migration task, as ECS Fargate in the account and cluster the data plane
([infra/aws/example](../../infra/aws/example)) already lives in, behind one Application Load Balancer. Terraform is in
[infra/aws/control-plane](../../infra/aws/control-plane) (read its [README](../../infra/aws/control-plane/README.md) for the
design, the variables and the cost floor); the images are the ones of the GCP runbook, built from
[packages/control-api/Dockerfile](../../packages/control-api/Dockerfile) and
[packages/panel/Dockerfile](../../packages/panel/Dockerfile). Nothing in an image is cloud-specific.

**Status: written, planned and smoke-tested locally against an SQS emulator; never applied.** Applying creates paid, shared
resources and needs the go-ahead of decision D9. What was and was not run is at the end
([What has never run](#what-has-never-run)).

## What is deployed

```
                 internet                                      VPC (the data plane's private subnets)
 browser ─► ALB :443 ── host api.…   ─► <name>-api   (Fargate) ── SQS (ring, peek DLQ), CloudWatch (read)
                    └─ host qelay.…  ─► <name>-panel (Fargate)    RDS (private)      <name>-tick ◄── EventBridge Scheduler
 release ─► aws ecs run-task <name>-migrate ──────────────────────┘                   <name>-worker(s)
```

| Piece | Where | Runs |
| --- | --- | --- |
| Workers, the tick and its schedule, database, queues | data plane (`infra/aws/example`) | already there; the tick is the **same image** as the API with its command overridden (`tick_command`), started each minute as a one-shot task |
| `<name>-api` | control plane, ECS service | `qcloud-api serve` |
| `<name>-panel` | control plane, ECS service | the panel's static build and the server that makes `/config.json` |
| `<name>-migrate` | control plane, a task definition only | `qcloud-api migrate`, once per release |

## What differs from GCP

Everything in [deploy-gcp.md](deploy-gcp.md) about sign-in, the environment contract (`QCLOUD_API_*`, `QCLOUD_PANEL_*`,
`QCLOUD_FLEET_*`), unsafe combinations refused at start, and rollback semantics holds unchanged: the same images read the
same variables. These are the differences.

| Topic | AWS |
| --- | --- |
| Broker | `QCLOUD_TRANSPORT=aws-sqs`, `QCLOUD_AWS_REGION`. Credentials come from the task role. `QCLOUD_AWS_SQS_ENDPOINT` is never set. |
| Delay limit | 15 minutes (`/capabilities` says `maxDeliverDelayMs: 900000`). A longer delay is kept by the database and rung when due. |
| Job delivery page | Depth, in flight and delayed come from `GetQueueAttributes`: SQS calls them approximate, so the page prefixes them with "≈" and says how old the reading is. The age of the oldest bell comes from CloudWatch, about five minutes behind (`monitoring_read = false` leaves it blank). |
| Database URL | A Secrets Manager reference (the task definition's `secrets`, the full ARN). Read when a task starts. |
| Database CA | `QCLOUD_DATABASE_TLS_CA`: the PEM text of the region's RDS bundle, a plain environment value (Fargate has no file mount). Exactly one of it, `QCLOUD_DATABASE_TLS_CA_FILE` and `QCLOUD_DATABASE_TLS` is set. |
| Exposure | An ALB with HTTPS on a certificate you bring and two host names you point at it. `public` (default), `private`. Optional WAF rate limit: `edge_rate_limit_per_minute`. See the README. |
| Tick | A one-shot task started by EventBridge Scheduler: no listener, no token to check. |
| Migration | `aws ecs run-task` of `<name>-migrate`. |
| Scaling | The API and the panel are a fixed count. The connection budget counts the API's tasks, so there is no autoscaling. |

## Timeouts and event streams

| Layer | Value | Why |
| --- | --- | --- |
| Heartbeat | 15 s (`event_heartbeat_seconds`) | A comment line; resets every idle timer on the way. |
| ALB idle timeout | 60 s (`alb_idle_timeout_seconds`; the plan refuses less than twice the heartbeat) | The load balancer closes a connection idle for this long. A stream is never idle. |
| Stream lifetime | 600 s | The API closes the stream cleanly; the browser reconnects with `Last-Event-ID` and loses nothing. |
| Server idle timeout | 255 s | The most Bun allows. |
| Deregistration delay | 30 s | In-flight requests finish before a task leaves the target group. |
| Shutdown grace / `stopTimeout` | 8 s / 18 s | The API closes its streams at the grace; Fargate kills the task after `stopTimeout`. |

A rollover cuts the streams of the tasks it stops, at the grace. The panel reconnects to another task. That is expected.

## Deploying

Order matters: the control plane reads what the data plane made.

1. **Data plane first** (once). In its variables: `tick_image` the API image with
   `tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`; `database_ca_pem` the PEM text of the RDS bundle of
   your region (`https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`; behind RDS Proxy also the Amazon
   roots); `control_processes = 4` (two ticks plus two API tasks; more API tasks need more); for webhooks `webhooks = true`
   (it makes the key, which is in the Terraform state: back it up), `tick_loop = {}` and `webhook_sender = {}` (ECS
   services of the tick image, each holding a pool the budget counts); and
   `additional_principal_arns = ["arn:aws:iam::<account>:role/<control plane name>-api-task"]`, **before** the queues'
   policies are applied, or every call the API makes to a queue is denied. Then `terraform -chdir=infra/aws/example apply`.
2. **A certificate and two names.** An ACM certificate in the same region covering `api_hostname` and `panel_hostname`
   (validated by you), and the two names. After step 5, point both at the load balancer: `terraform output alb_dns_name`
   (a CNAME, or an alias record in Route 53 with `alb_zone_id`).
3. **Build and push the images**, by digest, to a registry the tasks can reach (ECR in the account is the cheapest: no NAT
   needed for the pull when the data plane has the endpoints):

   ```bash
   aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
   docker build -f packages/control-api/Dockerfile -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-api:$(git rev-parse --short HEAD) \
     --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
   docker build -f packages/panel/Dockerfile -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-panel:$(git rev-parse --short HEAD) \
     --build-arg COMMIT=$(git rev-parse HEAD) .
   docker push ...    # then use IMAGE@sha256:<digest> in the variables
   ```

   The build flags, the SBOM command and the rule for moving the Bun version are in the GCP runbook. Set the ECR
   repositories in `image_repository_arns`, or the execution roles cannot pull.
4. **Hand the data plane's outputs over**:

   ```bash
   terraform -chdir=infra/aws/example output -json control_plane_inputs > infra/aws/control-plane/data-plane.auto.tfvars.json
   ```

   Then copy `ci.tfvars.example` to your own `*.tfvars` and set `name` (the same as the data plane's, and the name in the
   `additional_principal_arns` entry), the two images, the `oidc_*` values, `certificate_arn` and the two host names. `*.tfvars` and
   the handover file are not committed.
5. **Plan, then apply the control plane.** `terraform -chdir=infra/aws/control-plane plan` and read it: the load balancer
   and its listeners, two services, three task definitions, two roles (the API's task role and a shared execution role, every statement
   scoped; the panel and the migration have no task role) and, in public mode, a subnet per zone and a route to the
   data plane's internet gateway. The first apply of the services needs the images in
   the registry. Services that cannot start roll back on their own (the deployment circuit breaker).
6. **Run the migration** before traffic moves to a build that needs a new schema ([below](#running-the-migration)). A
   service started first answers `/health` 200 and `/health/ready` 503 with `checks.schema.state = "behind"`, and becomes
   ready by itself once the migration finishes.
7. **Register the redirect URIs** (`terraform output oidc_redirect_uris`) at the identity provider, create the DNS records,
   then open the panel.
8. **Smoke test** ([below](#smoke-test)).

Rolling a new release: build and push, set the two image variables, run the migration when the release carries one, then
apply. ECS starts the new tasks, waits for `/health` on the target group, and stops the old ones (at least half stay
healthy while it does; with one task, none do, so use two).

### Running the migration

The `migrate` output has everything `aws ecs run-task` needs. The task runs the API's image with the command `migrate`:
one connection, the direct URL when the data plane has an RDS Proxy, exit 0 when the database is current (running it again is a
no-op), 1 when a step failed (it rolled back whole) or the schema is newer than the build, 2 for configuration.

```bash
OUT=$(terraform -chdir=infra/aws/control-plane output -json migrate)
TASK=$(aws ecs run-task --region REGION --launch-type FARGATE --count 1 \
  --cluster "$(jq -r .cluster <<<"$OUT")" --task-definition "$(jq -r .task_definition <<<"$OUT")" \
  --network-configuration "awsvpcConfiguration={subnets=[$(jq -r '.subnets|join(",")' <<<"$OUT")],securityGroups=[$(jq -r '.security_groups|join(",")' <<<"$OUT")],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region REGION --cluster "$(jq -r .cluster <<<"$OUT")" --tasks "$TASK"
aws ecs describe-tasks --region REGION --cluster "$(jq -r .cluster <<<"$OUT")" --tasks "$TASK" \
  --query 'tasks[0].containers[0].[exitCode,reason]' --output text      # 0 is success
```

`run-task` returns a task even when it could not be placed: read `failures` in its full output if `taskArn` is `None`. The
log is in the group `migrate.log_group` (`/qcloud/<name>/migrate`). A release process must stop on a non-zero exit code and
must not apply the services. `wait tasks-stopped` polls for 10 minutes by default and fails after that.

A serving task never migrates. The deployer needs `ecs:RunTask`, `ecs:DescribeTasks` and `iam:PassRole` on the migration's
execution role.

## Smoke test

```bash
# On this machine, no cloud, no container: the same entrypoints over a local Postgres and an SQS emulator (ElasticMQ).
docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs     # 127.0.0.1:59324
QCLOUD_TEST_DATABASE_URL=postgres://... bun run scripts/smoke-aws.ts --local

# A deployed environment. The token is an OIDC access token of a test principal with the operator role.
QCLOUD_SMOKE_TOKEN=... bun run scripts/smoke-aws.ts \
  --api-url "$(terraform -chdir=infra/aws/control-plane output -raw api_url)" \
  --panel-url "$(terraform -chdir=infra/aws/control-plane output -raw panel_url)" \
  --queue qcloud-smoke --idle-seconds 60 \
  --tick-cluster <cluster arn> --tick-task <name>-tick --subnets <id,id> --security-groups <id> --region REGION
```

It runs the steps of the GCP smoke test (`/health` public, every other route 401 without a token, readiness, the panel's
`/health`, `/config.json` and CSP, an event stream that sees a job complete, the tick recorded on `/deployment`), and
adds, for SQS: `/capabilities` names `aws-sqs` with a 900,000 ms delay limit; `/transport` lists the queue with depth,
in flight, delayed and dead-letter depth as numbers, labelled approximate, with a reading age. Deployed only: port 80
redirects to HTTPS, and an event stream stays open for `--idle-seconds` plus 15 s (past the load balancer's idle timeout).
`--local` adds the migration and rollback drills. The queue needs a worker that completes jobs; the script never prints
the token. With `--tick-task` the tick is started with `aws ecs run-task` (a write to the account: one task); without it
the script waits for the scheduler's next minute.

## Rolling back

**The application.** Migrations are forward-only and safe with the previous release connected, so rolling back is serving
the previous image against the migrated database: set `api_image` and `panel_image` back to the previous digests and
apply. ECS rolls the services back to the earlier task definitions. If a deployment is failing, the circuit breaker
already does this. To go faster than a Terraform run:

```bash
aws ecs update-service --cluster <cluster> --service <name>-api --task-definition <name>-api:<previous revision>
```

and then make the variables match, or the next apply rolls forward again.

The older build reports the schema as `ahead` on `/deployment` and stays ready and serving. **Do not run the older
build's migration task**: it refuses a schema newer than it knows (`schema_ahead`, exit 1) and changes nothing. A bad
migration is fixed forward with the next version, never by editing a shipped one (its checksum is recorded and an edited
one stops every process with `SchemaDriftError`). A column or table the release added stays; the previous release ignores
it.

`bun run scripts/smoke-aws.ts --local` exercises this: an unmigrated start (`/health` 200, ready 503 `behind`), the
migration, then a schema one version ahead of the build (`ahead`: ready, still takes jobs, its own `migrate` refuses
with exit 1). That is the same entrypoint in local processes, not containers.

## Rotating the database secret

The URL holds the database password, generated once by the data plane (`random_password`). Tasks read a secret when they
start, and a new version changes `rollout_trigger`, which rolls the services that carry it:

1. Data plane: `terraform -chdir=infra/aws/example apply -replace=module.database.random_password.database`. The instance's
   password and a new secret version change together, and the workers roll onto the new version. Connections already open
   stay open; a task that reconnects with the old password fails until it has been replaced, which is minutes. The SDK
   retries with backoff, and the tick repairs what the gap left.
2. Control plane: re-export `control_plane_inputs` (step 4 above) and apply. The changed `rollout_trigger` rolls the API; the
   migration task reads the current version on its next run.
3. The previous value stays in the secret as the `AWSPREVIOUS` version, a password the database no longer accepts.

Unproven until it has run against a real account (D9). Behind an RDS Proxy the proxy's own credential rotates separately.

## Tearing down

The control plane has no state: `terraform -chdir=infra/aws/control-plane destroy` removes the load balancer, the
services, the task definitions, the roles and, in public mode, its subnets and route. If `alb_deletion_protection` is
on, turn it off and apply first. Destroy it **before** the data plane (it removes its one inbound rule from the data
plane's task group; the data plane's subnets cannot go while the load balancer's interfaces are in them). The data plane's
teardown steps and protections are in [infra/aws/README.md](../../infra/aws/README.md#teardown). Remove the DNS records
yourself.

## Checks without a cloud

```bash
bun run check:terraform          # fmt, init -backend=false, validate, a credential-less plan of every root, assertions
bun run scripts/smoke-aws.ts --local
docker build -f packages/control-api/Dockerfile -t qcloud-api:test .
docker build -f packages/panel/Dockerfile -t qcloud-panel:test .
```

The plan check drops every `AWS_*` variable and gives the provider placeholder keys, so real credentials are never used and
no account is contacted. For the control plane it asserts, among others: no unauthenticated route (the listener's default is
a 404 and two rules route by host name only), HTTPS on a TLS 1.3 policy, one inbound rule on the tasks' group (8080 from the
load balancer's), no secret and no development token in any environment, the idle timeout against the heartbeat, every IAM
statement scoped, the connection budget against the data plane's, the handover names against the data plane's
`control_plane_inputs`, and 22 refusals. The data plane's plan also asserts that the loop and the sender run as the tick's roles and that no worker role can read the webhook key.

## What has never run

- **`terraform apply`** (D9). Nothing here has created a resource. Terraform was validated and planned without credentials
  only, and the data plane's and control plane's plans were compared to each other offline.
- **The Docker images were not built** in the task that wrote them; the Dockerfiles are checked by reading and by running the
  same entrypoints as local processes. Build them before the first apply.
- **The smoke test against AWS.** `--local` ran against ElasticMQ, which is not SQS: its counts, delays and redrive differ
  in ways the [fidelity notes](../limits.md) list. The deployed flags, including the `run-task` tick trigger and the idle
  check, are written, not run.
- **Fargate and the ALB**: that a stream survives to its 600 s lifetime through the load balancer, that the secrets and the
  inline CA reach the process, that the host rules, the redirect and the health checks behave, that a rollover leaves no gap,
  and that the certificate covers both names.
- **Queue access through the data plane's deny policies** for the API's role, and the CloudWatch metric names and lag.
- **The migration task** and the `aws ecs wait` exit-code check, **rotation**, **rollback** and **teardown**: the commands
  are written, not run.
- **Identity provider**: none was configured; the tests sign tokens with a throwaway key.
