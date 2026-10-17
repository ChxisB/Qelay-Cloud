# 02 — AWS tick schedule (was: AWS tick in process)

**Status:** done, scope changed (see Result) · **Depends on:** 00 · **Touches:** `infra/aws/modules/tick`, `infra/aws/modules/scheduler`, `infra/aws/example`, `infra/aws/README.md`, `scripts/check-terraform-plan-aws.ts`

## Goal
Stop launching a Fargate task every minute for a job the always-on workers can do.

## Steps
1. Measure first on the ElasticMQ stack: tick lateness with the in-process tick versus a one-shot (`scripts/measure-tick-lateness.ts`).
2. Add a mode where workers run the tick (the tick lease keeps it single) and the RunTask schedule is off.
3. Keep the one-shot mode for `min_instances = 0` deployments, where no worker is guaranteed to be up.
4. Update the README cost table.

## Acceptance
- With the in-process mode, the plan has no scheduler or tick task definition.
- With `min_instances = 0`, the plan still has them.

## Verify
```bash
bun run check:terraform
bun test packages/maintenance
```

## Risks / notes
Fargate minimum billing per launched task was not verified. The saving is real only if workers run anyway.

## Result

Done 2026-10-17, **with a smaller scope than the plan**: the acceptance above ("in-process mode, no scheduler or tick task
definition") is **not** met, and was replaced on purpose.

**Why.** The in-process tick (`TickLoop`) is code the worker's host must start; the SDK does not, and the repository ships
no worker image. A Terraform switch that removed the scheduler and the tick task would remove the safety net for a
deployment that had not written that code, and cron would stop. So the lever is the schedule, not the existence of the
scheduler.

**What changed.** `scheduler_schedule` accepts `rate(1 minute)` or `rate(N minutes)` (N from 2; the plan refuses a cron
expression or seconds), and the `tick-stalled` alarm now follows it: period `60 x N`, three missed periods, five minutes at
the least (it was fixed at one minute, so a slower schedule would have raised a false alarm). At `rate(5 minutes)` the
tick launches a fifth as often (about 43,200 launches a month at one a minute). Documented in `infra/aws/README.md`
("The tick's schedule"), `docs/limits.md` s1 and `docs/runbooks/tick-stopped.md`. It is safe only when the workers run `TickLoop`.

**Ran:** `terraform validate`, credential-free plans; `bun run scripts/check-terraform-plan-aws.ts` (820 checks, was 794): the
default alarm is 1 minute x 5, the `rate(5 minutes)` variation has the schedule and a 300 s x 3 alarm, and a 30-second rate
and a cron expression are refused.

**Did not run:** the tick lateness measurement of step 1 (`scripts/measure-tick-lateness.ts`; the numbers in limits s1 are
from earlier tasks); anything on AWS; a slow schedule against real workers. If the owner wants the scheduler removable for an
in-process-only deployment, that is a further task.
