# 01 — GCP worker resource and backlog scaling

**Status:** done (plan-checked, never applied) · **Depends on:** 00 · **Touches:** `infra/gcp/modules/workers`, `infra/gcp/example`, `infra/gcp/README.md`, `scripts/check-terraform-plan.ts`, DESIGN.md s7

## Goal
Host GCP pull workers on a resource that needs no HTTP listener and scales on Pub/Sub backlog.

## Steps
1. Confirm the provider version that has `google_cloud_run_v2_worker_pool` as GA, and the pin change from `~> 6.0` if any.
2. Decide: worker pool plus a backlog scaler (Google's CREMA tutorial), or keep the service and add a health listener to the worker host.
3. Add a worker image recipe (a Dockerfile for the SDK worker; only `control-api` has one).
4. Keep `max_instances` required and inside the connection budget; keep the subnet-size precondition.
5. Update the plan check and README; record the choice in DESIGN.md s7.

## Acceptance
- A worker revision has no need to listen on `$PORT`, or the module sets the port and probe for it.
- The scaling target is the subscription backlog, and the maximum is still in the budget.
- `bun run check:terraform` passes with the new resource counted.

## Verify
```bash
bun run check:terraform
```

## Risks / notes
Worker pool billing, minimum scale and SIGTERM grace were not verified. A real deploy (task 06) is the only proof.

## Result

Done 2026-10-17 under the owner's delegation (see CURRENT.md "Decision"). **Plan-checked only: nothing was applied.**

**Design.** The workers are `google_cloud_run_v2_worker_pool` (provider 6.50.0, already locked; the `~> 6.0` pin is unchanged).
A pool has no ingress, port or probe, which closes F2. Terraform sets `manual_instance_count = min_instances` once and
ignores it afterwards (`ignore_changes`), the same pattern as the AWS `desired_count`. Backlog scaling is opt-in per pool:
`autoscaling = { queue, backlog_per_instance = 10 }` adds `modules/autoscaler`, Google's CREMA as one always-on service
whose YAML config (in Parameter Manager) is generated from the pool, the subscription and the floor and ceiling. It is
off by default because it costs about one more worker.

**Weaker than before (recorded in DESIGN.md s7 and `infra/gcp/README.md`).** Cloud Run enforces no maximum on a pool, so
`max_instances` is held only by CREMA's `maxReplicaCount` and by whoever sets the count by hand. The pool carries a
`qcloud-max-instances` label to say what the budget counted. The autoscaler also holds two project-wide read grants
(Parameter Manager and metrics) because the provider has no resource-level IAM for them.

**Changed:** `infra/gcp/modules/workers`, new `infra/gcp/modules/autoscaler`, `infra/gcp/modules/monitoring` (idle alert on
`cloud_run_worker_pool`), `infra/gcp/example`, `scripts/check-terraform-plan*.ts` and new `scripts/terraform-plan-autoscaler.ts`,
`infra/gcp/README.md`, `docs/runbooks/deploy-gcp.md` (with a worker image sketch, not built), `docs/quickstart-gcp.md`, DESIGN.md s7.

**Ran:** `terraform fmt -check`, `validate`, credential-free `plan` (58 resources to add; 66 with one pool autoscaled);
`bun run scripts/check-terraform-plan.ts` 161 checks (was 136), including the pool's scaling block and label, the
autoscaler's config parsed back as YAML against `queueNames`, the grants, the typo refusal and the idle alert's filter.

**Did not run:** anything on Google Cloud; a worker pool or CREMA ever starting; a Docker build of a worker image (Docker is
deferred; the Dockerfile in the runbook is a sketch); the `workerPools` versus `workerpools` path casing (Google's codelab
differs from the Admin API); the CREMA image digest (a tag is used); the Pub/Sub price rates; how a pool replaces instances
on a rollout. These are items 11 to 13 of "Needs D9" in `infra/gcp/README.md`.
