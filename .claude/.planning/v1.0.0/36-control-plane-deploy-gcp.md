# 36 — Deploy the control plane on GCP

**Status:** done locally (apply, image builds and a real-project smoke run need D9 and Docker) · **Depends on:** 21, 34, 35 · **Phase:** 2

## Goal

Package and deploy the Control API and the panel on GCP: container images, Cloud Run services, identity-aware access, and the wiring to the Phase 1 infrastructure.

## Scope

In: Dockerfiles, a build pipeline definition, Terraform for the services and ingress, runtime configuration, a smoke test, an operations note.
Out: AWS (task 43), custom domains and WAF tuning beyond the basics, multi-region.

## Steps

1. **Images:** one image for the Control API (and the tick CLI), one static image for the panel (or a bucket plus CDN, whichever task 06 settled). Multi-stage build, non-root user, pinned base image digest, SBOM generated, no dev dependencies, `/config.json` produced from environment at start.
2. **Terraform (`infra/gcp/control-plane`):** Cloud Run services (API, panel), a service account each, Direct VPC egress to the database, a Secret Manager reference for the database credential, an external HTTPS load balancer or Cloud Run URL according to the exposure decision in the README, Cloud Scheduler's OIDC call to the tick endpoint.
3. **Exposure and access:** choose and document one default, with the reasoning: (a) public HTTPS with OIDC at the application layer (default), (b) behind Identity-Aware Proxy, (c) private only. Do not leave an unauthenticated route (the tick endpoint verifies the scheduler's OIDC token).
4. **SSE and timeouts:** Cloud Run request timeout and the SSE maximum lifetime from task 32 set so streams close cleanly before the platform cuts them; concurrency per instance set deliberately; minimum instances per D1.
5. **Configuration:** a documented environment table (database, transport, namespace, OIDC issuer/audience/JWKS, allowed origins, roles claim, tick audience). Startup validates and refuses unsafe combinations (dev token with production mode, wildcard origin).
6. **Migrations:** run as a separate Cloud Run Job or a release step, never from every instance at start; the readiness endpoint reports schema version mismatch.
7. **Smoke test script** `scripts/smoke-gcp.ts`: sign in with a test principal, add a job, watch it complete, trigger the tick, read `/deployment`.
8. **Apply (needs D9):** deploy to a real project only with D9 and an explicit go-ahead; run the smoke test; leave it running or tear it down per instruction; record the URLs and what exists.
9. **Ops note** `docs/runbooks/deploy-gcp.md`: deploy, roll back, rotate the database secret, run migrations, tear down.

## Acceptance

- Images build reproducibly, run as non-root, and start with only the documented environment.
- Terraform validates and plans cleanly for the control plane; no unauthenticated route exists except `/health`.
- The smoke test passes against a real environment if D9 allowed, otherwise against the local stack, and the Result says which.
- Rollback is documented and was exercised at least in the local container flow.

## Verify

```bash
docker build -f packages/control-api/Dockerfile -t qcloud-api:test .
docker build -f packages/panel/Dockerfile -t qcloud-panel:test .
terraform -chdir=infra/gcp/control-plane fmt -check -recursive
terraform -chdir=infra/gcp/control-plane init -backend=false && terraform -chdir=infra/gcp/control-plane validate
bun run scripts/smoke-gcp.ts --local
```

## Risks / notes

- Do not deploy without D9 and an explicit instruction. A plan and a local container run are the default deliverables.
- Running migrations from many instances racing at startup is the classic outage; keep them out of the serving path.
- Cold starts affect the first panel request when min instances is zero; the default for the control plane is one instance, because the cost is small and the experience is better.
- **Event stream numbers (from task 32):** the Control API sends a heartbeat every 15 s, closes a stream at 600 s so the client
  resumes with `Last-Event-ID`, and its server idle timeout is 255 s. Set Cloud Run's request timeout to at least 600 s (the
  maximum is 3,600 s) and make sure the load balancer in front adds nothing shorter than the 15 s heartbeat can keep alive.

## Result

**Done locally. Nothing was applied, no image was built, and no cloud resource was touched.** The Dockerfiles, the
Terraform root, the runtime entrypoints, the smoke test and the runbook are in; what ran is listed under "Run" and what
did not under "Not run".

**Built**

- **Runtime** (`packages/control-api/src/runtime/`, `src/bin.ts`): `qcloud-api serve` (default) and `migrate`, every
  setting from the environment and validated before anything connects; exit 0 drained or current, 1 failure, 2
  configuration; graceful drain (`QCLOUD_API_SHUTDOWN_GRACE_MS`, default 8 s, at most 60 s). Unsafe combinations stop the
  start: development token in production or beyond loopback, wildcard origin, no sign-in, `http` JWKS in production,
  heartbeat or stream lifetime out of range. `QCLOUD_DATABASE_*` is read by one function shared with the tick
  (`packages/store-postgres/src/connection/env.ts`).
- **Readiness reports the schema.** `/health/ready` and `/deployment` carry `schema {state: current|behind|ahead|unknown,
  current, expected}`; the service is unready only when the schema is `behind`. `schemaVersion()` returns 0 on a database
  nothing has migrated (it used to throw `42P01`).
- **Images**: `packages/control-api/Dockerfile` (API and tick CLI, one image) and `packages/panel/Dockerfile` (static
  build and a server that makes `/config.json` and the CSP from the environment at start). Multi-stage, base image by
  digest, `--frozen-lockfile --production`, root-owned read-only tree, `USER bun`, healthcheck, OCI labels, `.dockerignore`.
  SBOM and provenance: `docker buildx build --sbom=true --provenance=mode=max` (documented in the runbook and the file
  header).
- **Terraform** `infra/gcp/control-plane/`: API and panel Cloud Run services, the migration Cloud Run Job, three service
  accounts, bindings on resources only, one custom role (`monitoring.timeSeries.list`) as the only project-level grant,
  Secret Manager references, Direct VPC egress, `variables.tf` with 40 inputs and validations, `ci.tfvars.example`.
  The data plane gains the `control_plane_inputs` output and `tick_command` (the tick runs from the API image with its
  entrypoint overridden; `modules/tick` takes `command`).
- **Checks**: `scripts/check-terraform-control-plane.ts` and `scripts/terraform-control-plane-assertions.ts` (108 checks),
  wired into `bun run check:terraform` after the data plane's (now 110 checks, one added for the tick command).
- **Smoke test** `scripts/smoke-gcp.ts` (with `smoke-lib.ts`, `smoke-local.ts`, `packages/control-api/test/localIssuer.ts`):
  `--local` and a deployed mode.
- **Runbook** `docs/runbooks/deploy-gcp.md`; `infra/gcp/README.md` and `DESIGN.md` section 7 updated.

**Decisions**

- **Exposure: (a), public HTTPS with sign-in at the application.** Cloud Run's IAM check is off (`allUsers` holds
  `run.invoker` on the API and the panel); the API refuses every request without a valid token and `/health` is the only
  route without one. `exposure = "private"` is the alternative (`INGRESS_TRAFFIC_INTERNAL_ONLY`). Reasoning is in the
  runbook: any OIDC provider, no load balancer, no certificate, nothing extra to pay for.
- **(b) IAP is not implemented.** Deviation from the task's wording: the provider the lock file pins (google 6.50.0) has no
  `iap_enabled` on `google_cloud_run_v2_service`; IAP needs a serverless NEG behind an external HTTPS load balancer, a
  domain and a certificate, which is another shape. The runbook says how to put one in front of `private` ingress and keep
  the application's token check. An earlier draft had an `iap` mode; it was removed when the provider rejected the
  argument.
- **The tick endpoint is not duplicated.** The data plane already creates the tick service and the Cloud Scheduler job
  with its OIDC call (task 21), so the control plane consumes them; the step-2 "Cloud Scheduler's OIDC call" is that.
- **Migrations are a Cloud Run Job** (`<name>-migrate`, `args = ["migrate"]`, no retries, the direct URL when a pooler
  exists) run as a release step before the services roll. A service that starts first is live (`/health` 200) and unready
  (503, schema `behind`) and becomes ready by itself.
- **Timeouts**: request timeout 900 s (at most 3,600; the plan refuses less than lifetime plus 60 s), stream lifetime 600 s
  (at least 600), heartbeat 15 s (15 to 60), server idle 255 s, concurrency 100 with 50 streams (the plan refuses streams
  at or above concurrency), minimum instances 1 (D1).
- **Probes use `/health`**, because readiness is behind the token (it names what the service depends on) and a probe
  cannot carry one.
- **The version and commit come from build arguments** (`QCLOUD_VERSION`, `QCLOUD_COMMIT`).
- **The tick is the API image** with `tick_command`; a separate tick image is still possible by leaving it null.
- **The connection budget is checked in both roots.** The control plane's plan refuses `1 + api_max_instances` above the
  data plane's `control_processes` and `api_pool_size` above its `control_pool_size`, and counts its instances against the
  subnet.

**Acceptance**

- *Images build reproducibly, non-root, documented environment only* — **partly**. Read and simulated: the lockfile is
  frozen, the base is by digest, the user is `bun`, the runtime layouts (the API's per-package `node_modules`, the panel's
  one bundled file plus `dist`) were reproduced by hand and run as the entrypoints. **`docker build` was not run**
  (Docker is deferred to the end, by the user's instruction), so reproducibility, the final size and the SBOM are unproven.
- *Terraform validates and plans cleanly; no unauthenticated route except `/health`* — **yes**. `terraform fmt -check`,
  `init -backend=false`, `validate` and a credential-less plan of both roots pass; the plan check asserts the only
  `run.invoker` bindings are `allUsers` on the API and the panel (the application enforces tokens), the tick's stays the
  scheduler's alone, no environment value is a secret or a development token, and 13 refusals each fail for their own
  reason. The unauthenticated surface of the application itself is `/health`; the tests of task 30 and the smoke test
  assert it.
- *Smoke test against a real environment if D9 allowed, otherwise the local stack* — **local stack**. D9 was not
  given. `bun run scripts/smoke-gcp.ts --local` passes 17 checks: the same entrypoints as the images
  (`bin.ts serve|migrate`, the tick CLI `run`, the panel's `serve/main.ts`) as local processes over a throwaway schema of a
  PG 18.6 on this machine, the Postgres doorbell and a loopback ES256 issuer. It is not a container run and Pub/Sub was
  not used.
- *Rollback documented and exercised in the local container flow* — **documented; exercised in local processes, not
  containers**. The drill in the smoke test: an unmigrated start (live, unready, `behind`), the migration (and a second
  one, a no-op), a recorded schema one release ahead (`ahead`: ready, still takes work, its own `migrate` refuses with
  `schema_ahead`, exit 1).

**Run**

- `terraform -chdir=infra/gcp/control-plane fmt -check -recursive`, `init -backend=false`, `validate`: pass (Terraform 1.5.7).
- `bun run check:terraform` with `QCLOUD_REQUIRE_TERRAFORM=1`: 110 + 108 checks pass.
- `bun run scripts/smoke-gcp.ts --local`: 17 of 17. A deployed-mode run against an unreachable URL exits 1, a missing
  token exits 2.
- The gate, on PG 18.6: `typecheck`, `lint` (exit 0, carried panel warnings only), `format:check`, `architecture` clean;
  `QCLOUD_REQUIRE_DB=1 bun test`: 3,650 pass, 114 skip (Pub/Sub emulator, ElasticMQ, PgBouncer, TLS), 0 fail
  (404 files); `bun test packages/panel`: 1,307 pass, 0 fail (213 files); `playwright --project=chromium`: 21 passed.
  `bun run test:model` not run: no queue semantics changed.

**Not run**

- `terraform apply` (and `plan` against a project): D9 and an explicit go-ahead.
- `docker build` of either Dockerfile, the container healthchecks, the buildx SBOM, the container rollback.
- Anything against Cloud Run: stream behaviour through Google's front end up to 600 s, Direct VPC egress to the database,
  the secret mount, the computed URLs against the real ones (the plan has `check` blocks that say so), `allUsers` being
  allowed by the organisation, the custom role being creatable by the deployer (`iam.roles.create`).
- A real identity provider and the panel's sign-in against it; the Pub/Sub dead-letter peek and the DLQ-age metric
  against the emulator or a project (task 35's owed item stays owed); the secret rotation procedure.

**Found and fixed**

- `schemaVersion()` threw `42P01` on a database nothing had migrated, so readiness could not say "behind": failing test
  first, then it returns 0.
- The tick module passed only `args = ["serve"]`; with the API image as the tick image the entrypoint would have started
  the API on the tick's service. `modules/tick` takes `command` and the plan check asserts the tick's command.
- The infra README said `control_processes` counts the panel; the panel holds no connection. Corrected in the README and
  the variable's description.
- The example's own subnet check does not count the control plane's instances; the control plane's root counts them
  (`data_plane_instances` is in the handoff).
- `packages/panel/test/serve.test.ts` awaited a synchronous handler (17 lint errors): the helper is async.

**Owed**

- Build both images and run the example app's compose and the container smoke (`docker`), at the end with the other
  Docker-backed runs; generate the SBOM.
- The first apply (D9): the list in the runbook's "What has never run" and `infra/gcp/README.md`'s "Needs D9".
- The `allUsers` fallback (`invoker_iam_disabled`) and the custom role's permission are one-time decisions for the
  organisation; the runbook names both.
- Consolidate the ring-window helper (`transportWindowMs` logic is duplicated in four `openRuntime`s) into core.
- Move the base image digest with `.bun-version`; update both Dockerfiles together.
- Contract shapes for the three task-35 endpoints and for `checks.schema` are in `openapi.yaml` and the route tests, not
  in `test/contract/shapes`.
