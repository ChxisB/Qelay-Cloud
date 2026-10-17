# Task 43: Deploy the control plane on AWS (2026-10-15)

**Done locally. Nothing was applied, no image was built, and no AWS account was contacted.** The Terraform root plans offline
and validates, the Control API and panel changes are tested, and the smoke test passes against a local ElasticMQ stack
(19 of 19, not SQS and not containers). Step 8 (apply) was not done: it needs D9, an account and an explicit go-ahead.

**Changed files**

- `infra/aws/control-plane/` (new): `versions.tf`, `variables.tf` (68 inputs), `main.tf`, `alb.tf`, `iam.tf`, `api.tf`,
  `panel.tf`, `migrate.tf`, `outputs.tf`, `ci.tfvars.example`, `README.md`, `.terraform.lock.hcl`.
- `infra/aws/example/` and `infra/aws/modules/network/outputs.tf`: `control_plane_inputs` (trimmed), `internet_gateway_id`,
  `database_tls` default `ca-pem`, `database_ca_pem`; `infra/aws/README.md`.
- `packages/store-postgres/src/connection/env.ts` (`QCLOUD_DATABASE_TLS_CA`) and its tests; `docs/limits.md`.
- `packages/transports` (`describeTransport` carries `approximateCounts`); `packages/control-api` (`deps.ts`, `runtime/open.ts`,
  `opsTypes.ts`, `ops/transportView.ts`, tests, `docs/openapi.yaml`); `packages/panel` (Transport page, queue table, types,
  demo data, tests: `ops-transport-sqs.test.tsx` and `transportPage.helpers.ts` are new).
- `scripts/`: `smoke-aws.ts`, `smoke-steps.ts` (new, shared), `smoke-gcp.ts`, `smoke-local.ts`, `smoke-lib.ts`,
  `check-terraform-control-plane-aws.ts` with `terraform-control-plane-aws-{services,ingress,iam}.ts`,
  `terraform-plan-aws-variations.ts` (new), `check-terraform-plan-aws.ts`, `terraform-plan-aws-services.ts`; `package.json`
  (`check:terraform`); `.github/workflows/ci.yml`.
- `docs/runbooks/deploy-aws.md` (new), `docs/runbooks/deploy-gcp.md` (CA note), `docs/spikes/06-phase0-gate.md` (amendment).

**Checked**

- `terraform -chdir=infra/aws/control-plane fmt -check -recursive`, `init -backend=false`, `validate`: pass (1.5.7).
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform`: 110 + 731 + 108 + 2,651 checks pass (GCP data plane, AWS data plane,
  GCP control plane, AWS control plane). The AWS control-plane check plans 36 resources, 12 variations and a closed-network
  case, and asserts 22 refusals.
- `bun test packages/control-api packages/panel` (Postgres up): 1,866 pass, 0 fail.
- `bun run scripts/smoke-aws.ts --local`: 19 of 19. `bun run scripts/smoke-gcp.ts --local`: 17 of 17 after the refactor.
- The full gate on PG 18.6 (`typecheck`, `lint` with the carried panel warnings only, `format:check`, `architecture`, then `bun test` with `QCLOUD_REQUIRE_DB=1 QCLOUD_REQUIRE_PUBSUB=1 QCLOUD_REQUIRE_SQS=1` against the local Pub/Sub emulator and ElasticMQ): 3,958 pass, 29 skip (PgBouncer, TLS and the other Docker-backed suites), 1 todo, 0 fail, 418 files, 852 s. `bun run test:model` not run: no queue semantics changed.

**Measured**

- The cost floor in the README is list-price arithmetic (about $75 a month for this root, the NAT gateway extra). Not measured.
- No timing was measured on AWS: the stream-through-ALB behaviour at 600 s and the ALB idle timeout are the documented values.

**Decisions**

- Public HTTPS with application-layer OIDC is the default (as GCP); `private` is the alternative; ALB-OIDC is not implemented
  (it would not authenticate bearer-token callers of the API).
- The tick has no endpoint to verify on AWS: EventBridge Scheduler starts a one-shot `qcloud-tick run` task (task 42).
- The database CA is the PEM text in `QCLOUD_DATABASE_TLS_CA`, a plain environment value (Fargate has no file mount).
- The API is a fixed count, because the connection budget counts its tasks; rollover min 50 / max 100 percent.
- Control-plane tasks wear the data plane's `tasks` security group, which gains one inbound 8080 rule from the ALB's group.
- The data plane lists `<name>-api-task` in `additional_principal_arns` before its queue policies are applied.
- Migrations are an ECS task run by the release process; serving tasks never migrate.
- The smoke steps are shared between clouds in `smoke-steps.ts`.

**Found and fixed**

- A smoke-test loopback guard ran after the schema was created and leaked a `qcloud_smoke_*` schema on a non-loopback
  endpoint; it runs first now, and both error paths leave none.
- The data plane's handover output carried keys the control plane did not read; trimmed, and the check compares the names both ways.
- README overclaims corrected (plaintext to a pooler, ALB-OIDC reasoning, the stream-lifetime rationale).
- Two files over the 300-line cap were split (`ops-transport-page.test.tsx`, `check-terraform-plan-aws.ts`).
- A first test run failed 60 tests only because `QCLOUD_TEST_DATABASE_URL` was not set for this machine's Postgres (port 55442);
  with it set, 0 fail.

**Owed**

- The first apply and a real-account smoke run (D9): the runbook's "What has never run" and the README's "Needs D9".
- Build both images and run the container smoke (Docker, at the end); generate the SBOM.
- A certificate, two DNS names and the identity provider's redirect URIs are the user's to provide.
- `readonlyRootFilesystem`, a release/deployer role and WAF are not provided; the ALB subnet slot (12+) and the cost figures are
  unmeasured; secret rotation is written and unexercised.
- The deployed smoke mode (HTTPS redirect, a stream past the idle timeout, `aws ecs run-task`) is written, not run.
