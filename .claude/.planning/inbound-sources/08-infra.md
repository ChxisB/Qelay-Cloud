# 08 — infra/: the ingest service (plan only)

**Status:** todo · **Depends on:** 03 · **Touches:** infra/gcp, infra/aws, scripts/check-terraform

## Goal
Terraform describes the ingest service on both clouds, and its plan passes the existing assertions.

## Steps
1. GCP: a Cloud Run service with public ingress, its own service account with only database and secret access, no outbound beyond the database, min and max instances. AWS: the equivalent container service behind a load balancer.
2. `check:terraform` asserts the roles, that the ingest has no `pubsub` or `sqs` role, and the connection budget.

## Acceptance
- `bun run check:terraform` passes with `QCLOUD_REQUIRE_TERRAFORM=1`.
- No `terraform apply` or `destroy` was run (state it).

## Verify
```bash
QCLOUD_REQUIRE_TERRAFORM=1 bun run check:terraform
```

## Risks / notes
- Gate: anything under `infra/`. Never apply from here without the owner's go-ahead.

## Result
