# 00 — Audit

**Status:** done · **Depends on:** none · **Touches:** none (read-only)

## Goal
Find out whether the code and the deployments use the real GCP and AWS services, and whether they scale at a sensible cost.

## Steps
1. Read the transport factory and both transports for any stub on the production path.
2. Read every Terraform module (data plane and control plane) for scaling, sizing and fixed cost.
3. Read `docs/limits.md`, `DESIGN.md` and the task tracker for what has run against what.
4. Run the credential-free plan checks.
5. Check external product facts that a finding depends on.

## Acceptance
- Each finding in `CURRENT.md` names a file or a source. True.
- Every claim about a real cloud is marked as read from docs or not run. True.

## Verify
```bash
QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform
```

## Risks / notes
External facts came from web search: Cloud Run worker pools GA (release notes, 14 Apr 2026); Cloud SQL managed pooling
needs Enterprise Plus; Pub/Sub filtered messages avoid egress but not delivery fees; RDS T4g runs in Unlimited mode;
Cloud Run services must listen on `$PORT`. Not confirmed: the Pub/Sub pricing page's "Filtered messages costs" text, the
Terraform provider version that has the worker-pool resource, Fargate prices and minimum billing, Cloud Run's SIGTERM grace.

## Result
No repo file outside this folder changed. `bun run check:terraform` (emulator-free, credential-free):
GCP data plane 136 checks passed; AWS data plane 794 passed; GCP control plane 113 passed; AWS control plane 2657 passed
(exit 0). The full gate (typecheck, lint, format, architecture, `bun test`) was
not run because nothing in the repo changed. No `terraform apply`, `gcloud` or `aws` call was made.
