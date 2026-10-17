# Cloud audit: real GCP/AWS use, scalability, cost

**Requested:** 2026-10-17. A read-only scan of the whole project: is it truly using GCP and AWS resources, and are the
deployments built to scale at a sensible cost.

## Goal

Rank what stands between this repo and a first real deployment on each cloud, and what it will cost to scale. No
fixes are made here. Every fix below touches `infra/`, a dependency pin or a transport decision, so each is a human gate.

## Scope

- **In:** `packages/transport-gcp`, `packages/transport-aws`, `packages/transports`, `infra/gcp/**`, `infra/aws/**`
  (data plane and control plane), `docs/limits.md`, `DESIGN.md`, the connection budget, the test and CI evidence.
- **Out:** panel UI, workflows, webhooks, SDK compatibility, security review (task 72). No `terraform apply`/`destroy`,
  no `gcloud`/`aws` call, nothing paid (D9).

## Touches

The audit (task 00) wrote only this folder and the completion note. Tasks 01 to 04 then changed `infra/`, `scripts/`,
`packages/transport-gcp`, `docs/` and `DESIGN.md`; see each task's Result and the completion note.

## Design impact

Fits DESIGN.md. F2 and F3 changed how GCP workers are hosted (service → worker pool). DESIGN.md section 7 did not say which
Cloud Run resource a worker is, so the choice and its weaker ceiling are now recorded there.

## Decision (2026-10-17)

Asked how to host GCP workers and which AWS infra changes to approve, the owner answered both with: *"Go with what you
think is best for scaling automatically and doesn't cost mega money"*. That delegates the design and approves
plan-checked changes under `infra/`. It is **not** a go-ahead for `terraform apply`/`destroy`, `gcloud`/`aws` writes,
a push or a version bump (D9), and none was done.

## Verdict

**Wired to the real services: yes. Run against them: no.**

- Production path uses `@google-cloud/pubsub` and `@aws-sdk/client-sqs` with real clients. Emulators are reached only
  through explicit options (`emulatorHost`, `QCLOUD_AWS_SQS_ENDPOINT`). One exception: F8.
- Nothing has ever touched a real account (D9). Every result is an emulator result (Pub/Sub emulator, ElasticMQ 1.7.1)
  or a credential-free `terraform plan`. The plan checks pass (see Result in `00-audit.md`), which proves the
  configuration is internally consistent, not that Google or AWS accepts it.

## Ranked findings

| # | Sev | Finding | Evidence | Task |
|---|-----|---------|----------|------|
| F1 | High | No real-cloud run exists, so every scaling, cost and alert claim is unmeasured | `docs/limits.md` s8; `infra/*/README.md` "Needs D9"; task 71 Owed | 05 |
| F2 | High | GCP workers are a Cloud Run **service** with no `ports`, no probe and no listener in the example worker, and the repo ships no worker image. Google's troubleshooting page says a service container must listen on `$PORT` or the revision fails "Container failed to start". Not run, so unconfirmed here | `infra/gcp/modules/workers/main.tf` (no `ports`/`startup_probe`); `examples/orders/src/worker.ts`; only `packages/control-api/Dockerfile` exists | 01 |
| F3 | High | GCP has **no backlog autoscaling**: only `min`/`max_instance_count`. AWS has step scaling on SQS depth. Cloud Run worker pools are documented as GA (release notes, 14 Apr 2026). **Corrected while building task 01:** a worker pool does not autoscale either (manual instance count only); the backlog autoscaler is CREMA, a separate always-on Cloud Run service that sets the pool's count. A pool also has **no maximum**, so the budget's `max_instances` is no longer a hard stop | `workers/main.tf` scaling block; `infra/aws/modules/workers/main.tf` | 01 |
| F4 | Med | AWS tick is a Fargate RunTask every minute (about 43,200 launches a month, each cold-starting inside a 60 s window). The in-process tick already exists and the tick lease keeps it single | `infra/aws/modules/tick`, `scheduler`; `cli.ts` | 02 |
| F5 | Med | AWS workers run on-demand Fargate only. Workers are stateless and recovery is by visibility timeout and stall check by design, so Spot fits; `stop_timeout_seconds` already allows the 120 s it needs | no `capacity_provider` in `infra/aws` | 03 |
| F6 | Med | RDS default `db.t4g.small` is burstable. AWS's RDS pricing page says T4g runs in Unlimited mode and bills surplus credits above baseline. A queue database is steady load. No credit alarm exists (only `CPUUtilization`) | `infra/aws/modules/database`; `modules/monitoring/main.tf:113,170` | 03 |
| F7 | Med | GCP is one topic with a filtered subscription per queue. Google's docs (via search; pricing section not retrieved) say filtered-out messages avoid egress but not delivery fees, so per-bell cost may grow with the number of queues. Not stated anywhere in the repo; `docs/limits.md` s11 prices SQS only | `modules/messaging/main.tf`; grep "filter" in docs finds no cost note | 04 |
| F8 | Low | `PUBSUB_EMULATOR_HOST` is honoured implicitly (`options.ts:26-27`). A leaked variable sends bells to a dead address; the tick re-ring would hide it as lateness, not loss | `packages/transport-gcp/src/options.ts` | 04 |
| F9 | Low | Cloud SQL managed pooling needs Enterprise Plus (Google docs); Terraform pins ENTERPRISE. Ceiling is 44 workers direct, 26 connections pooled; the pooler is bring-your-own. Already documented and the plan fails when the budget is exceeded | `DESIGN.md` 434-435; `infra/gcp/README.md` 146-154 | none |
| F10 | Low | Cloud Run's SIGTERM grace for the worker is not set or documented (AWS exposes `stop_timeout_seconds`). Jobs cut short are recovered by the stall check, so this costs latency, not correctness. **Confirmed from Google's docs while building task 04:** a fixed 10 s on a worker pool, shorter than the SDK's 20 s `close()` default; documented in `docs/limits.md` s6 | `infra/gcp/modules/workers` | 04 |

## What is already built for cost and scale (keep)

Direct VPC egress instead of a connector; GCP tick scales to zero (max 1); SQS long polling 20 s and batches of 10;
Pub/Sub publish batches up to 1,000; `ringOnly` skips CloudWatch; connection budget enforced as a plan precondition
(subnet size, `max_instances`, control processes); AWS `max_instances` has no default; S3 gateway endpoint; NAT per AZ
off by default; `prevent_destroy` on both databases; AWS cost drivers are listed in the README.

## Risks

- Cloud pricing and product status were checked by web search only, not against a bill. Dollar figures are not quoted.
- GCP provider is pinned `~> 6.0`; whether that version has the worker-pool resource at GA was not confirmed.

## Status

| # | Mini-task | Depends on | Status |
|---|-----------|-----------|--------|
| 00 | [Audit](00-audit.md) | | done |
| 01 | [GCP worker resource and backlog scaling](01-gcp-worker-pool.md) | 00 | done (plan-checked, never applied) |
| 02 | [AWS tick schedule](02-aws-tick.md) | 00 | done, **scope changed** (see its Result) |
| 03 | [AWS Spot and RDS burst alarm](03-aws-cost-levers.md) | 00 | done (plan-checked, never applied) |
| 04 | [Guards and cost notes](04-guards-and-notes.md) | 00 | done |
| 05 | [First real-cloud run](05-real-cloud-run.md) | 01 | blocked: needs the owner's go-ahead (D9) |
