# Quickstart: run it on Google Cloud

You will create a Cloud SQL database, Pub/Sub topics, Cloud Run worker pools and the maintenance tick with Terraform, put the
Control API and the panel in front of them, and run the [`orders` example](../examples/orders/README.md) on it.

**Read this first.**

- **This creates paid, shared resources.** The database runs around the clock and is the cost floor
  ([cost drivers](../infra/gcp/README.md#cost-drivers)). Do not run `terraform apply` until you have read the plan and
  decided to pay for it.
- **Nothing on this page has ever been applied to a real project.** The Terraform is validated and planned without
  credentials on every change, and everything above the cloud is tested against the Pub/Sub emulator. The list of what
  has never run is [Needs D9](../infra/gcp/README.md#needs-d9-what-has-never-run). Expect to find things the emulator
  could not show, and tell us.
- The commands below are not run by `docs:check`: each says why. [Try it locally](quickstart-local.md) first if you have
  not.

## What you need

- A GCP project with billing, and permission to create networks, Cloud SQL, Pub/Sub, Cloud Run, Cloud Scheduler, Secret
  Manager, service accounts and alert policies.
- Terraform 1.5 or later and `gcloud`, signed in (`gcloud auth application-default login`).
- Docker, to build the two images this repository ships (the Control API and the panel). The worker image is yours:
  it is your processor code and nothing in this repository builds it.
- A bucket for Terraform state, and an OpenID Connect identity provider that publishes a JWKS and issues JWT access
  tokens (RS256 or ES256), for the panel's sign-in. The panel is a public client (authorization code with PKCE).

## 1. Check the plan before you spend anything

This part is free: it plans the example with a placeholder token and no credentials, and asserts the roles, the database
safety settings, the Pub/Sub names and the connection budget.

> Not run: it needs `terraform` 1.5 or later, which the docs checker does not require. CI runs it with
> `QCLOUD_REQUIRE_TERRAFORM=1`.

```bash notrun
bun run check:terraform
```

## 2. Create the data plane

The data plane is the database, the topics, the workers and the tick, in `infra/gcp/example`. Copy
`example/ci.tfvars.example` to a file ending `.tfvars` (the repository ignores those) and set at least `project_id`,
`project_number` (`gcloud projects describe PROJECT_ID --format='value(projectNumber)'`), `region`, `namespace = "orders"`,
`queues = { orders = {} }`, and the two images. Set `tick_image` to the Control API image and
`tick_command = ["bun", "/app/packages/maintenance/src/bin.ts"]`: the tick is the same image with another entrypoint.
Every variable is in [infra/gcp/README.md](../infra/gcp/README.md#variables-of-the-example).

Size the database for your connections before you apply: the plan refuses a combination that needs more connections than
`max_connections` allows ([connection budget](operations.md#connection-budget)).

> Not run: `terraform init`, `plan` and `apply` use your Google credentials and create billable resources, which this
> repository only does on the owner's explicit go-ahead.

```bash notrun
cd infra/gcp/example
cp backend.tf.example backend.tf
terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=qcloud/<environment>"
terraform plan -var-file=my.tfvars -out=plan.tfplan
# read the plan, then:
terraform apply plan.tfplan
```

The first apply spends several minutes on the database and the private-services peering. Afterwards
`terraform output tick_url` is the tick's address and `connection_budget` shows the connections you planned for.

## 3. Build the images and create the control plane

The control plane (`infra/gcp/control-plane`) is a second Terraform root that runs the Control API, the panel and the
migration job. It reads what the data plane made through one output.

> Not run: it builds and pushes images to your registry and applies a second Terraform root.

```bash notrun
docker build -f packages/control-api/Dockerfile -t REGION-docker.pkg.dev/PROJECT/qcloud/api:$(git rev-parse --short HEAD) \
  --build-arg COMMIT=$(git rev-parse HEAD) --build-arg VERSION=1.0.0 .
docker build -f packages/panel/Dockerfile -t REGION-docker.pkg.dev/PROJECT/qcloud/panel:$(git rev-parse --short HEAD) \
  --build-arg COMMIT=$(git rev-parse HEAD) .
docker push REGION-docker.pkg.dev/PROJECT/qcloud/api:TAG     # use IMAGE@sha256:<digest> in the variables
docker push REGION-docker.pkg.dev/PROJECT/qcloud/panel:TAG

terraform -chdir=infra/gcp/example output -json control_plane_inputs > infra/gcp/control-plane/data-plane.auto.tfvars.json
# set api_image, panel_image, the oidc_* values and deployer_members in your own *.tfvars, then:
terraform -chdir=infra/gcp/control-plane plan -var-file=my.tfvars
terraform -chdir=infra/gcp/control-plane apply -var-file=my.tfvars
```

Register the panel's client at your identity provider with the redirect URIs from
`terraform output oidc_redirect_uris`. Your tokens need the issuer and audience you configured, and a role claim:
`operator` to change things, `viewer` to read. The full list is in the
[deployment runbook](runbooks/deploy-gcp.md#sign-in).

## 4. Create the tables, then run the example

The services never migrate on start. Run the migration job, once per release; it is a no-op when nothing is pending.

> Not run: it executes a Cloud Run job against your database.

```bash notrun
gcloud run jobs execute <name>-migrate --region REGION --wait
```

Then give the example a worker. The example's worker is `examples/orders/src/worker.ts`; build an image that runs it and
put it in `worker_services` as `worker_image` with `QCLOUD_TRANSPORT=gcp-pubsub`. On Pub/Sub the worker does not run a
tick: the tick service does, once a minute, from Cloud Scheduler. Add the jobs from inside the VPC (a Cloud Run job or a
bastion), because the database has no public address:

> Not run: it needs the deployed database and the image you built for the worker.

```bash notrun
QCLOUD_TRANSPORT=gcp-pubsub QCLOUD_GCP_PROJECT=PROJECT QCLOUD_NAMESPACE=orders \
  QCLOUD_DATABASE_URL=<private url> bun run examples/orders/src/producer.ts 5
```

Open the panel at `terraform -chdir=infra/gcp/control-plane output -raw panel_url` and sign in. You will see what you
saw locally, with one difference you should expect: the failing charge retries **up to a minute apart, not 500 ms**,
because the tick rings the retry and the tick runs once a minute from Cloud Scheduler. That is the hosting mode, not a
fault. For delays and backoff in seconds, run the tick inside an always-on worker as well
([delay precision](limits.md#1-delay-precision-by-hosting-mode)).

## 5. Smoke-test the deployment

The smoke script signs in with a token you give it, adds a job, waits for it to complete, and checks that the Control API
reports a current schema, a healthy database and no development token. It never prints the token.

> Not run: it needs the deployed environment and an operator-role token from your identity provider.

```bash notrun
QCLOUD_SMOKE_TOKEN=... bun run scripts/smoke-gcp.ts \
  --api-url "$(terraform -chdir=infra/gcp/control-plane output -raw api_url)" \
  --panel-url "$(terraform -chdir=infra/gcp/control-plane output -raw panel_url)" \
  --queue orders --scheduler-job <name>-tick --region REGION --project PROJECT
```

## Tear down

Destroy the control plane first, then the data plane. The database has three protections on purpose, so tearing it down
takes deliberate steps; take a backup you want to keep first, because backups go with the instance. The steps are in
[Teardown](../infra/gcp/README.md#teardown).

> Not run: it deletes billable resources.

```bash notrun
terraform -chdir=infra/gcp/control-plane destroy -var-file=my.tfvars
```

## Where to go next

- [Operations](operations.md): connection budget, the tick, upgrades, rolling back.
- [Deployment runbook](runbooks/deploy-gcp.md): environment variables, timeouts, rotating the database secret.
- [Quickstart: AWS](quickstart-aws.md): the same thing on SQS.
