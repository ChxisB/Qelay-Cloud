# 09 — Packaging and infra/: the ingest service (plan only)

**Status:** done · **Depends on:** 07 · **Touches:** packages/ingest/Dockerfile, charts/qelay, infra/gcp, infra/aws, scripts
**Gate:** infra, `terraform plan` only (approved 2026-10-23)

## Goal
The ingest can be built into an image and described on both clouds, with its plan passing the existing assertions.

## Steps
1. `packages/ingest/Dockerfile` in the style of `packages/control-api/Dockerfile`; a Deployment, Service and optional Ingress
   in `charts/qelay` behind `ingest.enabled` (off by default).
2. GCP: a Cloud Run service with public ingress, its own service account with only database and secret access, no Pub/Sub or
   Secret write roles, min and max instances. AWS: the equivalent container service behind a load balancer.
3. `check:terraform` asserts the roles, that the ingest has no `pubsub` or `sqs` role, and the connection budget.

## Acceptance
- `bun run check:terraform` passes with `terraform` present (or is named as not run).
- The ingest service account has no role that publishes to a queue (assertion).
- `helm lint charts/qelay` and `helm template` run when `helm` is installed, or are named as not run.
- No `terraform apply`, `destroy` or cloud write was run.

## Verify
```bash
bun run check:terraform
```

## Result

**Changed.**
- `packages/ingest/Dockerfile` (port 8081, `/healthz` healthcheck, user `bun`, entrypoint `src/bin.ts`). `release.yml` builds and
  pushes it as `qelay-ingest` beside the API and the panel; the release checklist and the GCP quickstart say three images.
- Helm: `charts/qelay/templates/ingest.yaml` (Deployment, Service), `ingress.ingest.host`, an `ingest:` block in `values.yaml`
  (off by default), CI values, the service account and NOTES.
- GCP control plane (`infra/gcp/control-plane`): `ingest.tf`, a Cloud Run service with its own service account (database
  and secret read only, no Pub/Sub or Secret write role), a third host name behind the load balancer and its own Cloud Armor
  policy (the per-address limit). New variable `ingest` (default null: nothing is created).
- AWS control plane (`infra/aws/control-plane`): `ingest.tf`, a Fargate service on 8081 sharing the load balancer on a host name of
  its own, a listener rule on host AND `/s/*`, a security group rule pair, a fifth execution role and no task role, and a WAF
  rule of its own for the ingest's host (the first rule excludes it). New variable `ingest` (default null).
- Both connection budgets count the ingest's processes; the plan refuses a budget it overruns.
- Plan assertions: `scripts/terraform-control-plane-ingest.ts` (GCP), `scripts/terraform-control-plane-aws-ingest.ts` (AWS),
  wired into the two control-plane checks. They assert the roles (no publish role on the ingest), the listener rule, the
  security group rules, the WAF scope-downs, the budget, and the refusals.

**Ran, and against what.**
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform` (terraform on the host, no credentials, plan only): data plane GCP 204,
  data plane AWS 863, control plane GCP 163, control plane AWS 2765 checks passed. One mutation (the AWS listener path `/*`)
  was made and caught by 2 checks, then undone. `terraform fmt -check -recursive infra/` clean.
- `helm lint` and `helm template` of the chart with the ingest on and off.
- `bun scripts/check-file-size.ts`: every file under 300 lines.

**Not run.**
- `docker build` of the ingest image (no Docker on this host): its install step was emulated with the same
  `bun install --frozen-lockfile --production --ignore-scripts --filter` on copied manifests. No container scan, no SBOM.
- `terraform apply`, `destroy` and every cloud write (D9). No real load balancer, Cloud Run service, WAF or Cloud Armor policy
  has seen a request, so the rate numbers (6000 per minute at the edge) are defaults, not measured.
- No alert on the ingest's 5xx answers was built (the API has one). Owed to task 11's runbook as a manual check.

**Decisions.**
- The ingest is opt-in on both clouds (`ingest = null` creates nothing), so an existing deployment's plan does not change.
- It gets a host name of its own on both clouds, so the edge can apply a different limit to senders than to operators.
- AWS WAF host match is a prefix match (`STARTS_WITH`); a `shortcut:` comment in `waf.tf` and the README say to avoid host
  names that begin with the ingest's.
- Deploying an ingest means raising the data plane's `control_processes` by the ingest's instances (AWS) or maximum
  instances (GCP) first, or the budget precondition refuses.
