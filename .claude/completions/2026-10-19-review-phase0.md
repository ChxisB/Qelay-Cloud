# Review follow-up, phase 0 (R01-R08)

Date: 2026-10-19 · Source: the 19 Oct 2026 review artifact (F1-F21). Tracker: `.claude/.planning/review-2026-10-19/CURRENT.md`.
Nothing was pushed, published, applied or version-bumped. Every run was local: scratch Postgres 18.6, ElasticMQ, plan-only Terraform.

## What changed

- **R01** opt-in SDK group commit for `add` (`groupCommit.ts`).
- **R02** migration 12: `fillfactor = 80` and a 1 % autovacuum scale factor on the hot tables; the schema snapshot records them.
- **R03** SQS acks go out through a batch delete (`deleteBatch.ts`).
- **R04** `workerRoleLimit` / `workerRoleLimitSql`, Terraform outputs, and the operator steps in `docs/operations.md`.
- **R05** opt-in edge protection: AWS WAF rate rule, GCP external load balancer with Cloud Armor.
- **R06** webhook retry waits are spread by 20 % either way; the cap still holds.
- **R07** CI actions pinned to SHAs, Dependabot for them, stale "untracked doc links" claims removed, null-in-array guards on
  three id-list reads.
- **R08** `qcloud.add.ms` and `qcloud.worker.complete_ms` histograms, documented with `qcloud.add.group_size`.

## Not done, and why

- Real Cloud SQL / RDS load check (F17), `terraform apply`, any `gcloud`/`aws` write: need the owner's go-ahead (D9).
- First GitHub CI run and any Postgres 16 run: need a push and Docker (deferred).

## Never confirmed against a real cloud

Cloud Armor throttling, the serverless NEG backend timeout, managed certificate issuance, WAF 429 behaviour, real SQS batching
savings, the role cap's grants on Cloud SQL and RDS, the effect of fillfactor on a real drain.

## Found, not mine to fix

- `test/docs/release.test.ts`: the root `LICENSE` lost the upstream copyright line in commit 4103cee; `packages/*/LICENSE` keep it.
- `test/gameday/recovery.test.ts` "rotate the secret": the scratch Postgres uses trust auth.

## Open decision

Default-on edge protection for `exposure = "public"` (adds a bill, can lock out clients behind one NAT).
