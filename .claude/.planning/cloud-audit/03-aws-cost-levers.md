# 03 — AWS Spot and RDS burst alarm

**Status:** done (plan-checked, never applied) · **Depends on:** 00 · **Touches:** `infra/aws/modules/workers`, `infra/aws/modules/monitoring`, `infra/aws/modules/database`, `infra/aws/README.md`, `scripts/check-terraform-plan-aws.ts`

## Goal
Offer the cheaper worker capacity and make the burstable database fail loudly instead of billing quietly.

## Steps
1. Add an optional `capacity_provider_strategy` on worker services (an on-demand base plus a Spot weight). Default stays on-demand.
2. Add an alarm on `CPUSurplusCreditBalance` (and `CPUCreditBalance`) when the instance class is `db.t*`.
3. Document in the README that `db.t4g.*` suits dev, and name a steady-load class for production.
4. Re-run the plan check; the burst alarm only exists for burstable classes.

## Acceptance
- Default plan is unchanged apart from the new alarm on `db.t4g.small`.
- A Spot-weighted example plans with a capacity provider strategy and the same `stop_timeout_seconds`.

## Verify
```bash
bun run check:terraform
```

## Risks / notes
Spot interruption behaviour and the discount are AWS claims, not measured here. The workers must finish or release
jobs inside the 120 s stop timeout; the stall check covers the rest.

## Result

Done 2026-10-17. **Plan-checked only: nothing was applied.**

- **Spot (opt-in, default off).** `spot = true` on a worker service uses a capacity-provider strategy: `FARGATE` with a base of
  `min_instances` and weight 0, `FARGATE_SPOT` with weight 1 (so only tasks above the floor can be reclaimed), and
  `launch_type` is left unset (it conflicts with a strategy). The example registers both providers on the cluster
  (`aws_ecs_cluster_capacity_providers`, no charge) and the workers module depends on it. `stop_timeout_seconds` is unchanged
  (60 by default, 120 at most; Spot's warning is two minutes). Risks written in `infra/aws/README.md` ("Spot workers"):
  no on-demand fallback, a handler may run twice, and switching an existing service can replace it.
- **RDS credits.** `aws_cloudwatch_metric_alarm.database_cpu_credits` on `CPUSurplusCreditBalance` above 0 for 15 minutes,
  created only for `db.t*` classes (the plan check shows `db.m6g.large` gets none). It links the `slow-claims` runbook.
  `CPUCreditBalance` was not alarmed: in Unlimited mode the surplus is the billed quantity.
- **Default plan.** It differs from before by the credit alarm and the cluster capacity-providers resource (89 to 91 resources).
  The acceptance said "only the new alarm"; the second addition is the free provider association Spot needs.

**Ran:** `terraform fmt`, `validate`, credential-free plans; `scripts/check-terraform-plan-aws.ts` 820 checks (was 794), including
the Spot strategy (`FARGATE:1:0`, `FARGATE_SPOT:0:1`), the default services still on `FARGATE` with no strategy, both providers on
the cluster, the credit alarm's metric, threshold and runbook link, and no such alarm for a non-burstable class.

**Did not run:** anything on AWS. Unverified AWS claims: the Spot discount, the interruption behaviour with the 120 s
stop timeout, that `CPUSurplusCreditBalance` is emitted for `db.t4g.small`, and whether replacing a service on a launch-type
change happens as expected. Items 12 and 13 of "Needs D9" in `infra/aws/README.md`.
