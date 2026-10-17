# Quickstart: run it on AWS

You will create an RDS database, SQS queues, ECS Fargate workers and the maintenance tick with Terraform, put the Control
API and the panel behind a load balancer, and run the [`orders` example](../examples/orders/README.md) on it.

**Read this first.**

- **This creates paid, shared resources.** The database, the NAT gateway and the interface endpoints bill by the hour
  whether or not a job runs ([cost drivers](../infra/aws/README.md#cost-drivers)). Do not run `terraform apply` until you
  have read the plan and decided to pay for it.
- **Nothing on this page has ever been applied to a real account.** The Terraform is validated and planned without
  credentials on every change, and the SQS transport is tested against ElasticMQ, an emulator whose differences from SQS
  are listed in [limits.md](limits.md#9-emulator-gaps-worth-knowing). The list of what has never run is
  [Needs D9](../infra/aws/README.md#needs-d9-what-has-never-run).
- The commands below are not run by `docs:check`: each says why. [Try it locally](quickstart-local.md) first if you have
  not.

## What you need

- An AWS account and credentials that may create a VPC, RDS, SQS, KMS, Secrets Manager, ECS, EventBridge Scheduler,
  CloudWatch and IAM roles. Your own identity needs `iam:CreateRole`, `iam:PutRolePolicy` and `iam:PassRole`; Terraform
  cannot grant them to you.
- Terraform 1.5 or later, Docker, and the AWS CLI.
- A registry the tasks can reach (ECR in the same account is the cheapest), a bucket for Terraform state, an ACM
  certificate for two host names (the API and the panel), and an OpenID Connect identity provider that publishes a JWKS
  and issues JWT access tokens (RS256 or ES256).
- A worker image of your own: your processor code, running the SDK's `Worker`. The repository builds only the Control API
  and the panel.

## 1. Check the plan and try SQS for free

Both of these cost nothing. The first plans the example without credentials and asserts the roles, the queue policies, the
database safety settings and the connection budget. The second runs the transport against ElasticMQ on your machine.

> Not run: both need tools the docs checker does not require, `terraform` 1.5 or later and an ElasticMQ container.
> CI runs the plan check with `QCLOUD_REQUIRE_TERRAFORM=1`, and does not run ElasticMQ.

```bash notrun
bun run check:terraform
docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs
QCLOUD_REQUIRE_SQS=1 bun test packages/transport-aws
```

## 2. Create the data plane, in two applies

The data plane is the database, the queues, the workers and the tick, in `infra/aws/example`. Copy
`example/ci.tfvars.example` to a file ending `.tfvars` (the repository ignores those) and set `account_id`, `region`, at
least two `availability_zones`, `namespace = "orders"`, `queues = { orders = {} }` and the images. Set `tick_image` to the
Control API image with `tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`. Put the PEM text of your
region's RDS CA bundle in `database_ca_pem`, and list the control plane's API role in `additional_principal_arns`
(`arn:aws:iam::<account>:role/<name>-api-task`) **before** the queue policies are applied, or every call the API makes to
a queue is denied. Every variable is in [infra/aws/README.md](../infra/aws/README.md#variables-of-the-example).

Size the database for your connections: the plan refuses a fleet that needs more than `max_connections`
([connection budget](operations.md#connection-budget)).

The tick and the workers need a migrated database and an image to pull, which this configuration cannot create. So apply
once with `scheduler_enabled = false` and every service's `min_instances = 0`, migrate (step 4), then apply again with the
real values.

> Not run: `terraform init`, `plan` and `apply` use your AWS credentials and create billable resources, which this
> repository only does on the owner's explicit go-ahead.

```bash notrun
cd infra/aws
cp example/backend.tf.example example/backend.tf
terraform -chdir=example init -backend-config="bucket=<state-bucket>" -backend-config="key=qcloud/<environment>"
terraform -chdir=example plan -var-file=my.tfvars -out=plan.tfplan
# read the plan, then:
terraform -chdir=example apply plan.tfplan
```

## 3. Build the images and create the control plane

The control plane (`infra/aws/control-plane`) is a second Terraform root: the Control API and the panel as Fargate
services behind one load balancer, and the migration as a one-off task. It reads what the data plane made through one
output.

> Not run: it builds and pushes images to your registry and applies a second Terraform root.

```bash notrun
aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ACCOUNT.dkr.ecr.REGION.amazonaws.com
docker build -f packages/control-api/Dockerfile -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-api:TAG \
  --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
docker build -f packages/panel/Dockerfile -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-panel:TAG \
  --build-arg COMMIT=$(git rev-parse HEAD) .
docker push ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-api:TAG      # use IMAGE@sha256:<digest> in the variables
docker push ACCOUNT.dkr.ecr.REGION.amazonaws.com/qcloud-panel:TAG

terraform -chdir=infra/aws/example output -json control_plane_inputs > infra/aws/control-plane/data-plane.auto.tfvars.json
# set the images, the oidc_* values, certificate_arn and the two host names in your own *.tfvars, then:
terraform -chdir=infra/aws/control-plane plan -var-file=my.tfvars
terraform -chdir=infra/aws/control-plane apply -var-file=my.tfvars
```

Register the panel's client at your identity provider with the URIs from `terraform output oidc_redirect_uris`, and point
both host names at the load balancer (`terraform output alb_dns_name`). Tokens need a role claim: `operator` to change
things, `viewer` to read ([sign-in](runbooks/deploy-gcp.md#sign-in), the same on AWS).

## 4. Create the tables, then run the example

A serving task never migrates. The migration is a one-off Fargate task of the API image with the command `migrate`; running
it again is a no-op.

> Not run: it starts a task in your account.

```bash notrun
OUT=$(terraform -chdir=infra/aws/control-plane output -json migrate)
TASK=$(aws ecs run-task --region REGION --launch-type FARGATE --count 1 \
  --cluster "$(jq -r .cluster <<<"$OUT")" --task-definition "$(jq -r .task_definition <<<"$OUT")" \
  --network-configuration "awsvpcConfiguration={subnets=[$(jq -r '.subnets|join(",")' <<<"$OUT")],securityGroups=[$(jq -r '.security_groups|join(",")' <<<"$OUT")],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region REGION --cluster "$(jq -r .cluster <<<"$OUT")" --tasks "$TASK"
```

Exit code 0 is success. Now apply the data plane again with the real values (`scheduler_enabled = true`, the workers'
`min_instances`). Run `examples/orders/src/worker.ts` as the worker image's command with `QCLOUD_TRANSPORT=aws-sqs` and
`QCLOUD_AWS_REGION`; credentials come from the task role, and `QCLOUD_AWS_SQS_ENDPOINT` is never set on AWS. The worker
does not run a tick on SQS in this example: the tick task does, once a minute, from EventBridge Scheduler. Add the jobs
from inside the VPC, because the database has no public address:

> Not run: it needs the deployed database and the image you built for the worker.

```bash notrun
QCLOUD_TRANSPORT=aws-sqs QCLOUD_AWS_REGION=REGION QCLOUD_NAMESPACE=orders \
  QCLOUD_DATABASE_URL=<private url> bun run examples/orders/src/producer.ts 5
```

Open the panel and sign in. You will see what you saw locally, with expected differences. The failing charge retries up to
a minute apart, not 500 ms, because the scheduler's tick rings the retry. A delay of up to 15 minutes is held by SQS
itself; a longer one is kept by the database and rung when due (the Transport page says "≈" because SQS counts are
approximate). [Delay precision](limits.md#1-delay-precision-by-hosting-mode) has the numbers for each hosting mode.

## 5. Smoke-test the deployment

> Not run: it needs the deployed environment and an operator-role token from your identity provider. The script never
> prints the token.

```bash notrun
QCLOUD_SMOKE_TOKEN=... bun run scripts/smoke-aws.ts \
  --api-url "$(terraform -chdir=infra/aws/control-plane output -raw api_url)" \
  --panel-url "$(terraform -chdir=infra/aws/control-plane output -raw panel_url)" \
  --queue orders --idle-seconds 60 \
  --tick-cluster <cluster arn> --tick-task <name>-tick --subnets <id,id> --security-groups <id> --region REGION
```

## Tear down

Destroy the control plane first, then the data plane. The database has deliberate protections, and Secrets Manager and KMS
keep deleted secrets and keys for days, so a quick re-create under the same names can fail. Take a backup you want to keep
first. The steps are in [Teardown](../infra/aws/README.md#teardown).

> Not run: it deletes billable resources.

```bash notrun
terraform -chdir=infra/aws/control-plane destroy -var-file=my.tfvars
```

## Where to go next

- [Operations](operations.md): connection budget, the tick, upgrades, rolling back.
- [AWS deployment runbook](runbooks/deploy-aws.md): what differs from GCP, rotating the database secret, rolling back.
- [Quickstart: GCP](quickstart-gcp.md): the same thing on Pub/Sub.
