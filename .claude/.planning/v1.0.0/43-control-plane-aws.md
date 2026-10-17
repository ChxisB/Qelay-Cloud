# 43 — Deploy the control plane on AWS

**Status:** done locally (apply, image builds and a real-account smoke run need D9 and Docker) · **Depends on:** 41, 42, 37 · **Phase:** 3

## Goal

Deploy the Control API and the panel on AWS with the same behaviour as GCP, and give the panel an AWS-aware Transport page.

## Scope

In: Terraform for the services and ingress, container deployment, runtime configuration, SQS-specific Transport and Deployment output, a smoke test, an operations note.
Out: custom domains and WAF tuning beyond the basics, multi-region.

## Steps

1. **Images:** reuse the images from task 36; no cloud-specific image. Cloud differences are configuration and adapters, nothing else.
2. **Terraform (`infra/aws/control-plane`):** ECS Fargate services for the API and the panel (or the panel in S3 with CloudFront), an application load balancer with HTTPS, task roles per service, the database secret by reference, the scheduler from task 42 pointed at the tick.
3. **Exposure and access:** the same three options as task 36, with the same default (public HTTPS plus application-layer OIDC) and the equivalents for the alternatives (an ALB with OIDC authentication action, or private only). The tick endpoint verifies the caller's identity (a signed request or a shared secret from Secrets Manager; the choice goes in the README with the reasoning). No unauthenticated route besides `/health`.
4. **SSE and timeouts:** the ALB idle timeout must exceed the SSE heartbeat interval and exceed the stream's maximum lifetime handling (task 32). Record the values.
5. **Panel:** the Transport page shows SQS-specific numbers (visible, in flight, delayed, DLQ depth) with the metric freshness; the Deployment page shows the same fields as on GCP; `/capabilities` reports the 15-minute delay limit.
6. **Migrations:** a one-off ECS task run as a release step, not from the serving tasks.
7. **Smoke test** `scripts/smoke-aws.ts`: the same steps as task 36's, against AWS or a local stack with the SQS emulator.
8. **Apply (needs D9):** only with an account and an explicit go-ahead; run the smoke test; tear down or hand over; record what exists.
9. **Ops note** `docs/runbooks/deploy-aws.md`: deploy, roll back, rotate the secret, run migrations, tear down.

## Acceptance

- The smoke test passes against AWS (D9) or the local SQS-emulator stack, and the Result says which.
- The same panel build works against a GCP and an AWS Control API with no code change (only configuration).
- The Transport page renders correct SQS values and labels approximate counts.
- Terraform validates; no unauthenticated route exists except `/health`.

## Verify

```bash
terraform -chdir=infra/aws/control-plane fmt -check -recursive
terraform -chdir=infra/aws/control-plane init -backend=false && terraform -chdir=infra/aws/control-plane validate
bun test packages/control-api packages/panel
bun run scripts/smoke-aws.ts --local
```

## Risks / notes

- Do not deploy without D9 and an explicit instruction.
- If the AWS deployment needs a code change in the panel beyond configuration, the abstraction is wrong; fix the `/capabilities` or `/transport` contract instead.
- ALB, NAT and Fargate costs add up. State a rough monthly floor in the README so the user can decide.
- **Event stream numbers (from task 32):** heartbeat every 15 s, a stream closed at 600 s, server idle timeout 255 s. An ALB's
  idle timeout must be at least 30 s (the default is 60 s); the 15 s heartbeat keeps it busy, and the client resumes with
  `Last-Event-ID` after the 600 s close.

## Result

**Done locally. Nothing was applied, no image was built, and no AWS account was contacted.** The Terraform root, the
runtime changes, the Transport page, the smoke test and the runbook are in. What ran is under "Run" and what did not under
"Not run". Step 8 (apply) was **not done**: it needs D9, an account and an explicit go-ahead.

**Built**

- **Terraform `infra/aws/control-plane/`** (9 files, `ci.tfvars.example`, lock file): an internet-facing ALB (HTTPS on a
  certificate you bring, the TLS 1.3 (with 1.2) policy, port 80 redirects, host rules `api_hostname` and `panel_hostname`, a 404 for
  anything else), the API and panel Fargate services, the migration task definition (`<name>-migrate`), two roles (the API's
  task role and a shared execution role; the panel and the migration have no task role), the database secret by `valueFrom`
  ARN, log groups. 36 resources in the base plan, 68 inputs with validations and preconditions. It reads the data plane
  through one handover file: `terraform -chdir=infra/aws/example output -json control_plane_inputs`.
- **Data plane** (`infra/aws/example`, `modules/network`): the `control_plane_inputs` output, `internet_gateway_id`, the `ca-pem`
  default for `database_tls`, `database_ca_pem` with a 16,000-character cap and preconditions.
- **Runtime**: `QCLOUD_DATABASE_TLS_CA` (inline PEM) in `packages/store-postgres/src/connection/env.ts`, because Fargate has
  no file mount for the RDS bundle; `describeTransport('aws-sqs')` reports `approximateCounts`; the Control API's
  `/transport` carries `inFlight`, `delayed` and `approximateCounts` (`docs/openapi.yaml` updated).
- **Panel**: the Transport page shows depth, in flight, delayed and dead-letter depth for SQS, prefixes every approximate
  count with "≈", says in words that the broker counts approximately and what the 15-minute delay limit means, and keeps
  the metric age. A broker that counts exactly shows no "≈" and no extra columns.
- **Smoke test** `scripts/smoke-aws.ts`, with the steps now shared with GCP in `scripts/smoke-steps.ts`
  (`smoke-gcp.ts` shrank to 79 lines; `smoke-local.ts` has an `aws-sqs` variant over a loopback ElasticMQ). `--local` runs the
  API, a worker and the tick as processes against local Postgres and ElasticMQ; a deployed mode adds the HTTPS redirect, a
  stream held past the ALB idle timeout and the tick started with `aws ecs run-task`.
- **Checks** `scripts/check-terraform-control-plane-aws.ts` (with `-services`, `-ingress`, `-iam` helpers): 2,651 checks,
  wired into `bun run check:terraform` and the CI terraform job. The data-plane AWS check is 731.
- **Docs**: `docs/runbooks/deploy-aws.md`, `infra/aws/control-plane/README.md` (exposure, timeouts, identities, cost floor),
  `infra/aws/README.md`, `docs/limits.md`.

**Decisions**

- **Exposure: public HTTPS with sign-in at the application** (the same default as GCP); `exposure = "private"` puts the ALB
  in the data plane's private subnets. The ALB-OIDC action is **not implemented**: it would authenticate the browser at the
  load balancer but not the API's bearer-token callers, so the application check stays either way. The README gives the reason.
- **The tick needs no endpoint check on AWS.** EventBridge Scheduler starts `qcloud-tick run` as a one-shot Fargate task
  (task 42), so there is no listener to protect and `serve` (which verifies Google tokens) is not used. The step-3 wording
  about a signed request or shared secret does not apply; who may start the task is IAM.
- **Timeouts**: heartbeat 15 s, stream closed at 600 s, server idle 255 s, ALB idle 60 s (the plan refuses less than twice
  the heartbeat, the variable at least 30), deregistration 30 s, `stopTimeout` = grace + 10 s.
- **The database CA is inline** (`QCLOUD_DATABASE_TLS_CA`), the region bundle only; behind an RDS Proxy the Amazon roots must
  be added. This resolves the task-42 owed item about the CA bundle.
- **The API is a fixed count.** The connection budget (`api_instances + 2 <= budgeted_control_processes`, 4) counts every API
  task, so there is no autoscaling. Rollover is min 50 percent / max 100 percent (0 / 100 with one task).
- **Control-plane tasks wear the data plane's `tasks` security group**, which gains one inbound rule: 8080 from the ALB's
  group. The ALB's group may reach the tasks and nothing else.
- **The ALB subnets** (public mode) are cut from the VPC CIDR at sixteenth-slot 12 and up; `alb_subnet_slot` moves them.
- **Migrations are a one-off ECS task** run by the release process; serving tasks never migrate. A service that starts first
  is live (`/health` 200) and unready (503, schema `behind`) and becomes ready by itself.
- **The handover contract was trimmed** to what the control plane declares, and the check fails if either side gains or loses a
  name (Terraform itself only warns about an undeclared key in a tfvars file).
- **Smoke steps are shared between clouds**, so a step cannot drift from the other cloud's. The cloud-specific parts are
  hooks (`Target.broker`, `Target.edge`).

**Acceptance**

- *The smoke test passes against AWS (D9) or the local SQS-emulator stack* — **local stack**. `bun run scripts/smoke-aws.ts
  --local`: 19 of 19, over a PG 18.6 and ElasticMQ 1.7.1 on this machine. It is not SQS and not a container run.
  `smoke-gcp.ts --local` still passes (17 of 17) after the refactor.
- *The same panel build works against a GCP and an AWS Control API, config only* — **yes**. No panel code names a broker
  (`scripts/check-transport-boundary.ts` covers 210 files); the page reads `/capabilities` and `/transport`, and the panel
  server builds `/config.json` from its environment. The page tests render an exact-count view and an SQS view from the same
  build. Two live Control APIs behind one panel in a browser were not run.
- *The Transport page renders correct SQS values and labels approximate counts* — **yes**, in unit and DOM tests (new
  `ops-transport-sqs.test.tsx`) and in the smoke test, which asserts `/capabilities` says `aws-sqs` with 900,000 ms and
  `/transport` gives numbers labelled approximate with an age. The CloudWatch figures were not read from AWS.
- *Terraform validates; no unauthenticated route except `/health`* — **yes**. `fmt`, `init -backend=false`, `validate` and an
  offline plan pass; the check asserts the listener's default is a 404, two host rules route to the target groups, the tasks'
  group has one inbound rule, no secret or development token is in any environment, and 22 refusals each fail for their
  own reason. The application's own surface is `/health`: the tests of task 30 and the smoke test assert it.
- *The README states a rough monthly cost floor* — **yes**: about $75 a month for this root, the NAT gateway extra. Unverified
  list prices.

**Run**

- `terraform -chdir=infra/aws/control-plane fmt -check -recursive`, `init -backend=false`, `validate`: pass (Terraform 1.5.7).
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform`: GCP 110, AWS data plane 731, GCP control plane 108, AWS control plane
  2,651, all pass. Mutation checks on the control-plane script: M1, M3, M4, M7 and M8 are caught; M2 was a weak mutation.
- `bun test packages/control-api packages/panel` (Postgres up, `QCLOUD_REQUIRE_DB=1`): 1,866 pass, 0 fail (261 files).
- `bun run scripts/smoke-aws.ts --local`: 19 of 19.
- The full gate on PG 18.6 (`typecheck`, `lint` with the carried panel warnings only, `format:check`, `architecture`, then `bun test` with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1` against the local Pub/Sub emulator and ElasticMQ): 3,958 pass, 29 skip (PgBouncer, TLS and the other Docker-backed suites), 1 todo, 0 fail, 418 files, 852 s. `bun run test:model` not run: no queue semantics changed.

**Not run**

- `terraform apply` or a plan against an account: D9 and an explicit go-ahead.
- `docker build` of either Dockerfile; the container smoke; the SBOM.
- Everything on AWS: a stream through the ALB to its 600 s close, the secrets and the inline CA reaching the process, host
  rules, the HTTP redirect, a zero-gap rollover, the certificate covering both names, the queue policies' deny list against
  the API's role, CloudWatch metric names and lag, the migration task and its exit-code check, rotation, rollback and teardown.
- A real identity provider; the deployed smoke mode and its `run-task` tick trigger.

**Found and fixed**

- The data plane's `control_plane_inputs` carried keys the control plane did not read; trimmed, and the check compares the
  names in both directions (it plans the data plane's example for this).
- A smoke-test guard ran after the schema was created, so a non-loopback SQS endpoint left a `qcloud_smoke_*` schema behind:
  the loopback check moved to the top of `start()`; zero leftover schemas on both error paths.
- README overclaims (plaintext to a pooler, why ALB-OIDC is not enough, the stream-lifetime rationale) corrected.
- Two files were over the 300-line cap: the Transport page test (split into `ops-transport-sqs.test.tsx` and
  `transportPage.helpers.ts`) and `check-terraform-plan-aws.ts` (scaling and refusal checks moved to
  `terraform-plan-aws-variations.ts`; still 731 checks).

**Owed**

- The first apply and the real-account smoke run (D9): the list in the runbook's "What has never run" and the README's
  "Needs D9".
- Build both images (with the other Docker-backed runs at the end).
- A certificate, two DNS names and the identity provider's redirect URIs are the user's to supply.
- `readonlyRootFilesystem`, a release/deployer role and WAF are not provided.
- The cost figures and the ALB subnet slot assumptions are unmeasured.
