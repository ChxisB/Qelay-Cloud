# 05 — First real-cloud run

**Status:** blocked (D9: needs the owner's explicit go-ahead; paid and shared resources) · **Depends on:** 01 · **Touches:** none in the repo until a result is recorded

## Goal
Replace "emulator and plan" with one measured run per cloud, small enough to cost little and torn down after.

## Steps
1. Owner picks the project and account and a spend ceiling.
2. GCP: apply `infra/gcp/example` at the smallest sizes, run `scripts/smoke-gcp.ts` in deployed mode, then add jobs and watch the scaler.
3. AWS: the same with `infra/aws/example` and the SQS smoke test; check the step scaling alarms fire.
4. Record the measured claim latency, the bill for the run, and every "Needs D9" item that now passed or failed.
5. Destroy the stack (the owner's go-ahead again).

## Acceptance
- Each "Needs D9" list in the two infra READMEs has a result, not a blank.
- `docs/limits.md` s8 names what was run on a real cloud.

## Verify
```bash
bun run check:terraform
```

## Risks / notes
Cloud SQL and RDS bill by the hour while they exist. Leave nothing running. Do not start without the owner.

## Result
