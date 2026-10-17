# 2026-10-17 — Cloud audit (GCP and AWS)

Spec: `.claude/.planning/cloud-audit/CURRENT.md`. Read-only audit; no repo file outside `.claude/` changed.

## Changed files
- `.claude/.planning/cloud-audit/` (CURRENT.md and tasks 00 to 05)
- this note

## What was checked
- Transport code on the production path for stubs: none; emulators only through explicit options, plus the implicit `PUBSUB_EMULATOR_HOST` (F8).
- All Terraform modules, data plane and control plane, for scaling, sizing and fixed cost.
- `bun run check:terraform` (credential-free plans): GCP 136, AWS 794, GCP control plane 113, AWS control plane 2657 checks passed (exit 0).
- Web search (not a bill) for: Cloud Run worker pools GA, Cloud SQL managed pooling edition, Pub/Sub filtered-message billing, Cloud Run port contract, RDS T4g Unlimited mode.

## Owed / not run
- Everything in D9: no `terraform apply`, no `gcloud`, no `aws` call, no real-cloud load, scaling or alert test.
- Full gate not run: nothing in the repo changed.
- Not verified: Pub/Sub pricing page "Filtered messages costs" text; Terraform provider version with the worker-pool resource; Fargate prices and minimum billing; Cloud Run SIGTERM grace; worker-pool billing.
- F2 (a Cloud Run service with no listener) is from Google's documented contract and the module text, not from a failed deploy.

## Needs the owner
- A decision on F2/F3 (service or worker pool; DESIGN.md s7), and on the infra tasks 01 to 03.
- Go-ahead and a spend ceiling for task 05, the first real-cloud run.

---

## Addendum: tasks 01 to 04 built (same day)

The owner answered "Go with what you think is best for scaling automatically and doesn't cost mega money" to the questions on
GCP worker hosting and AWS infra changes. That approved plan-checked changes under `infra/`; it did not approve any apply,
`gcloud`/`aws` write, push or version bump, and none happened.

### Corrections to the audit above
- **F3.** A Cloud Run worker pool does not autoscale (manual count). Backlog scaling is CREMA, a separate always-on service,
  now an opt-in module. A pool also has **no maximum**, so the connection budget's `max_instances` is no longer a hard stop.
- **F10.** Confirmed: a fixed 10 s after SIGTERM on a worker pool.
- **F2 / F7.** Unchanged in substance. F2 is closed by the pool (no port needed); F7 is documented.
- **Task 02** was built as a schedule lever (`rate(N minutes)`, with the stall alarm following it), not as "no scheduler".

### Changed files
- `infra/gcp/modules/workers` (worker pool), new `infra/gcp/modules/autoscaler`, `infra/gcp/modules/monitoring`,
  `infra/gcp/example/{main,variables}.tf`
- `infra/aws/modules/workers` (`spot`), `infra/aws/modules/monitoring` (`database_cpu_credits`), `infra/aws/example/{main,variables}.tf`
  (schedule validation, capacity providers)
- `scripts/check-terraform-plan.ts`, `terraform-plan-assertions.ts`, `terraform-plan-alerts.ts`, new `terraform-plan-autoscaler.ts`;
  `scripts/check-terraform-plan-aws.ts`, `terraform-plan-aws-{services,variations,data}.ts`
- `packages/transport-gcp/src/{transport,options}.ts`, new `packages/transport-gcp/test/emulatorGuard.test.ts`
- `docs/limits.md`, `infra/{gcp,aws}/README.md`, `docs/runbooks/{deploy-gcp,tick-stopped}.md`, `docs/quickstart-gcp.md`, `DESIGN.md` s7
- `.claude/.planning/cloud-audit/` Results and statuses

### What was checked, and against what
- Credential-free `terraform plan` and the plan checks: GCP 161 checks (was 136), AWS 820 (was 794), GCP control plane 113,
  AWS control plane 2657 (unchanged); `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform` exit 0.
- The unit and integration suites against the Docker-free host services: Postgres on 55442, ElasticMQ on 59324, the Pub/Sub
  emulator on 58085 (`QCLOUD_REQUIRE_DB=1`, `QCLOUD_REQUIRE_PUBSUB=1`, `QCLOUD_REQUIRE_SQS=1`). Every result is an emulator result.
- `bun run docs:check`.

### Owed / not run
- Everything in D9 still: no apply, no real cloud, no Cloud Run worker pool or CREMA ever started, no Fargate Spot task, no tick
  at a slower rate, no RDS credit metric seen.
- No Docker build (deferred): the worker image in the deploy runbook is a sketch.
- Unverified: `workerPools` versus `workerpools` in CREMA's resource path; the CREMA image digest (tag used); Pub/Sub, Fargate Spot
  and RDS prices; how a pool replaces instances on a rollout; Spot with a 120 s stop timeout.
- The measured tick lateness of task 02 step 1.

### Needs the owner
- Sign-off on the **soft ceiling** on GCP pools (DESIGN.md s7) and on CREMA's two project-wide read grants.
- Sign-off on the `PUBSUB_EMULATOR_HOST` behaviour change (task 04).
- Whether the scheduler should be removable for an in-process-only AWS deployment (task 02's original idea).
- Go-ahead and a spend ceiling for task 05, the first real-cloud run (D9).


## Gate (2026-10-17, Docker-free host services)

- `typecheck`, `lint` (exit 0, only the existing panel warnings), `format:check`, `architecture`: pass.
- `QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform`: exit 0 (GCP 161, AWS 820, GCP control plane 113, AWS control plane 2657).
- `bun test` with Postgres (127.0.0.1:55442), ElasticMQ (59324) and the Pub/Sub emulator (58085), all three `QCLOUD_REQUIRE_*` set:
  4991 pass, 29 skip, 1 todo, 1 fail of 5022 tests in 497 files (1085 s). The skips are the PgBouncer and TLS suites
  (Docker deferred) and the opt-in real-cloud suites.
- The one failure, `test/gameday/doorbells.test.ts` "claimable jobs with no bell", was a race in the test, not in the
  code: the store counts a job as unrung only once it is past the 2 s ring grace, and the test asserted 4 on the first
  poll after the oldest job crossed it, while the four adds are a few ms apart (it failed 2 of 3 solo reruns, with 2 and 3).
  The test now waits for all four before it asserts. It passed 5 of 5 reruns afterwards. The full `bun test` was NOT
  rerun after that edit.
- `docs:check` run in full against Postgres (7 documented blocks executed): passed.
- Not run: anything on a real cloud, Cloud Run worker pools, CREMA, Fargate Spot, Docker image builds, PgBouncer and TLS
  suites, the tick lateness re-measurement, `test:model` (no queue semantics changed).
