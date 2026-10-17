# Task 36: Deploy the control plane on GCP (2026-10-15)

**Done locally. Nothing was applied, no image was built and no cloud resource was touched.** Terraform was validated
and planned without credentials, and the smoke test ran against local processes of the same entrypoints the images run
(PostgreSQL 18.6, the Postgres doorbell, a loopback issuer). `terraform apply` needs D9 and an explicit go-ahead;
`docker build` is deferred to the end by the user's instruction.

**Changed files**

- Runtime: `packages/control-api/src/runtime/{settings,observe,open,main,redact,io,migrate}.ts`, `src/bin.ts`, `src/env.ts`,
  the readiness, health and deployment views (`checks.schema`), `docs/openapi.yaml`;
  `packages/store-postgres/src/connection/env.ts` (shared `QCLOUD_DATABASE_*` reader),
  `src/store/deployment.ts` (`schemaVersion()` is 0 on an unmigrated database); `packages/maintenance/src/env.ts`.
- Panel server: `packages/panel/serve/{config,files,server,main}.ts`, `test/serve.test.ts`, `e2e/runtime.ts`,
  `tsconfig.e2e.json`.
- Images: `packages/control-api/Dockerfile`, `packages/panel/Dockerfile`, `.dockerignore`.
- Terraform: `infra/gcp/control-plane/*.tf` (new root), `ci.tfvars.example`, `.terraform.lock.hcl`;
  `infra/gcp/example/outputs.tf` (`control_plane_inputs`), `variables.tf`, `main.tf` (`tick_command`);
  `infra/gcp/modules/tick/{variables,main}.tf` (`command`), `modules/workers/variables.tf`.
- Checks: `scripts/check-terraform-control-plane.ts`, `scripts/terraform-control-plane-assertions.ts`,
  `scripts/terraform-plan-assertions.ts` (tick command), `package.json` (`check:terraform` runs both).
- Smoke: `scripts/smoke-gcp.ts`, `scripts/smoke-lib.ts`, `scripts/smoke-local.ts`,
  `packages/control-api/test/localIssuer.ts`.
- Docs: `docs/runbooks/deploy-gcp.md`, `infra/gcp/README.md`, `DESIGN.md` ("As built (task 36)"), the task file (Result,
  status), `CURRENT.md` (row 36, 27 of 42).

**Checked**

- `bun run typecheck && bun run lint && bun run format:check && bun run architecture`: exit 0.
- `QCLOUD_REQUIRE_DB=1 bun test` on PG 18.6: 3,650 pass, 114 skip, 0 fail (404 files; 3,572 before this task).
- `bun test packages/panel`: 1,307 pass, 0 fail (213 files; 1,284 before).
- `playwright test --project=chromium`: 21 passed.
- `terraform -chdir=infra/gcp/control-plane fmt -check -recursive`, `init -backend=false`, `validate`: pass (1.5.7).
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform`: 110 data-plane + 108 control-plane checks pass.
- `bun run scripts/smoke-gcp.ts --local`: 17 of 17, including the migration and rollback drills.
- `bun run test:model` not run: no queue semantics changed.

**Measured**

- Nothing measured against a real environment. The smoke test runs in about 10 s locally; the tick check waits for one
  recorded tick (`--tick-wait-sec`, default 150 s deployed).

**Decisions**

- Exposure (a): public HTTPS, sign-in at the application, `/health` the only unauthenticated route; `exposure = "private"`
  is the alternative. IAP is not implemented in Terraform: provider 6.50.0 has no `iap_enabled` on Cloud Run v2 services
  (a deviation from the task text, recorded in the Result and the runbook).
- Migrations run as a Cloud Run Job before the services roll; a service that starts first is live and unready until the
  schema is current. Probes use `/health` because readiness is behind the token.
- The tick keeps living in the data plane; it runs from the API image with `tick_command` overriding the entrypoint.
- The control plane is a separate root fed by `terraform output -json control_plane_inputs`; the connection budget and
  the subnet are checked in both roots.
- Rollback = previous revision against the migrated database: `ahead` is ready and serves, its `migrate` refuses
  (`schema_ahead`, exit 1). Migrations stay forward-only.

**Found and fixed**

- `schemaVersion()` threw `42P01` on an unmigrated database (failing test first).
- The tick service would have started the API (image entrypoint): `command` on the tick module and a plan assertion.
- Infra README said the panel counts toward `control_processes`; it holds no connection.
- 17 `await-thenable` lint errors in the panel's serve test.

**Owed**

- Build both images and run the container smoke and the example app's compose (end of plan, with the other Docker runs);
  generate the SBOM (`docker buildx build --sbom=true --provenance=mode=max`).
- The first real apply and a deployed-mode smoke run (D9): see the runbook's "What has never run".
- Organisation decisions: `allUsers` invoker may be blocked by domain-restricted sharing (fallback
  `invoker_iam_disabled`); the custom metrics-reader role needs `iam.roles.create` for the deployer.
- Unverified against a real project: stream behaviour through Google's front end up to 600 s, Direct VPC egress, secret
  rotation, the Pub/Sub dead-letter peek and DLQ-age metric (task 35).
- The ring-window helper is duplicated in four `openRuntime`s: consolidate into core.
- Contract shapes for the three task-35 endpoints and `checks.schema`.
- Base image digest moves with `.bun-version`; update both Dockerfiles together.
