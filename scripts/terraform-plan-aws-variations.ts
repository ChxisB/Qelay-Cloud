/** The variations of the AWS data plane's plan that scale the fleet and that must be refused (task 42). */
import { budget, workerRoleLimit } from '../packages/store-postgres/src/connection/budget';
import { checkServices } from './terraform-plan-aws-services';
import type { Checks, Plan } from './terraform-plan-model';
import { attr, get, ofType } from './terraform-plan-model';

export type Planner = (label: string, ...overrides: string[]) => { plan: Plan | null; diagnostics: string };

/** The loop and the sender hold pools of their own: the budget variations take them out to count the workers alone. */
const NO_BACKGROUND = ['tick_loop=null', 'webhook_sender=null'];

export const budgetOf = (p: Plan | null) => get(p?.output_changes.connection_budget, 'after');

/** The README's figures: 10 / 50 / 200 worker processes, with and without a listener per process. */
export function checkScaling(plan: Planner, checks: Checks): void {
  for (const workers of [10, 50, 200]) {
    for (const listen of [0, 1]) {
      const where = `${workers} workers, listen ${listen}`;
      const scaled = plan(
        `scale-${workers}-${listen}`,
        `worker_services={worker={max_instances=${workers},listen_connections=${listen}}}`,
        'max_connections=1000',
        ...NO_BACKGROUND
      );
      const out = budgetOf(scaled.plan);
      const ts = budget({
        workers,
        controlProcesses: 4,
        listeners: listen === 1 ? workers : 0,
        poolerPoolSize: 20,
      });
      checks.ok(
        `${where}: direct matches the TypeScript budget`,
        get(out, 'direct_required') === ts.direct,
        `${get(out, 'direct_required')} vs ${ts.direct} ${scaled.diagnostics}`
      );
      checks.ok(
        `${where}: pooled matches the TypeScript budget`,
        get(out, 'pooled_required') === ts.pooled,
        `${get(out, 'pooled_required')} vs ${ts.pooled}`
      );
      checks.ok(
        `${where}: the worker role limit matches the TypeScript budget`,
        get(out, 'worker_role_limit') === workerRoleLimit(ts),
        `${get(out, 'worker_role_limit')} vs ${workerRoleLimit(ts)}`
      );
    }
  }
}

/** The tick alarm follows the schedule: it fires after `missed` minutes with no success, in periods of `minutes`. */
export function checkTickSchedule(plan: Plan, checks: Checks, minutes: number): void {
  const missed = Math.max(5, 3 * minutes);
  const stalled = ofType(plan, 'aws_cloudwatch_metric_alarm').find((c) => c.name === 'tick_stalled');
  checks.ok(
    `the tick alarm fires after ${missed} minutes without a success (schedule every ${minutes})`,
    attr(stalled, 'period') === 60 * minutes && attr(stalled, 'evaluation_periods') === Math.ceil(missed / minutes),
    `${attr(stalled, 'period')} x ${attr(stalled, 'evaluation_periods')}`
  );
}

/** The cost levers: a slower tick, Fargate Spot for the workers above their floor, and the burstable-database alarm. */
export function checkLevers(plan: Planner, checks: Checks): void {
  const slow = plan('tick-5', 'scheduler_schedule=rate(5 minutes)');
  checks.ok('a tick every 5 minutes plans', slow.plan !== null, slow.diagnostics);
  if (slow.plan !== null) {
    const schedule = ofType(slow.plan, 'aws_scheduler_schedule')[0];
    checks.ok('the schedule is the one asked for', attr(schedule, 'schedule_expression') === 'rate(5 minutes)');
    checkTickSchedule(slow.plan, checks, 5);
  }
  const spot = plan('spot', 'worker_services={worker={min_instances=1,max_instances=4,spot=true}}');
  checks.ok('a Spot worker service plans', spot.plan !== null, spot.diagnostics);
  if (spot.plan !== null) {
    checkServices(spot.plan, checks, { worker: { min: 1, max: 4, pool: 2, scaled: false, spot: true } });
    const providers = ofType(spot.plan, 'aws_ecs_cluster_capacity_providers')[0];
    checks.ok(
      'the cluster has both capacity providers',
      [...(attr(providers, 'capacity_providers') as string[])].sort().join() === 'FARGATE,FARGATE_SPOT'
    );
  }
  const big = plan('database-m6g', 'database_instance_class=db.m6g.large');
  checks.ok('a non-burstable database plans', big.plan !== null, big.diagnostics);
  if (big.plan !== null) {
    checks.ok(
      'no credit alarm for a class with no credits',
      !ofType(big.plan, 'aws_cloudwatch_metric_alarm').some((c) => c.name === 'database_cpu_credits')
    );
  }
}

/** What must be refused, and why. */
export function checkRefusals(plan: Planner, checks: Checks): void {
  const refused = (label: string, why: RegExp, what: string, ...overrides: string[]) => {
    const result = plan(label, ...overrides);
    checks.ok(what, result.plan === null && why.test(result.diagnostics), result.diagnostics);
  };
  refused('too-many', /max_connections is 100/, 'a fleet over max_connections is refused', 'worker_services={worker={max_instances=60}}');
  refused('plaintext', /needs rds_proxy/, 'plaintext without a proxy is refused', 'database_tls=off');
  refused('no-ca', /needs database_ca_pem/, 'verification without a CA bundle is refused', 'database_ca_pem=');
  refused('big-ca', /Use the region's bundle/, 'a CA bundle too big for a task definition is refused', `database_ca_pem=-----BEGIN CERTIFICATE-----${'A'.repeat(17000)}`);
  refused('subnet', /usable addresses/, 'a subnet too small for the tasks is refused', 'vpc_cidr=10.20.0.0/24');
  refused('bad-queue', /letters, digits and dashes/, 'a queue name the transport would encode is refused', 'queues={"a.b"={}}');
  refused('typo', /not in `queues`/, 'scaling on a queue that does not exist is refused', 'worker_services={worker={max_instances=2,autoscaling={queue="nope"}}}');
  refused('account', /12-digit/, 'an account id that is not 12 digits is refused', 'account_id=1234');
  refused('endpoints', /Missing:/, 'no route out and too few endpoints is refused', 'egress=none', 'interface_endpoints=["sqs"]');
  refused('rate', /scheduler_schedule must be/, 'a tick schedule finer than a minute is refused', 'scheduler_schedule=rate(30 seconds)');
  refused('cron', /scheduler_schedule must be/, 'a tick schedule that is not a rate is refused', 'scheduler_schedule=cron(0 * * * ? *)');
  refused('timeout', /non-negative whole milliseconds/, 'a negative session timeout is refused', 'database_session_timeouts={lock_ms=-1}');
  refused('retention', /Retention must be/, 'a retention SQS would refuse is refused', 'queues={default={retention_seconds=5}}');
}
