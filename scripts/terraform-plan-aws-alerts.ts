/**
 * The AWS data plane's alarms (task 71): every alarm names a runbook that exists in the repository, a service with no
 * task is an alarm and not a missing datum, the composite needs a stale bell and every worker service empty, and the two
 * alarms that read an exported metric exist only when a metric is named, the growth one on a rate and not on a level.
 */
import { checkRunbookLinks } from './terraform-plan-alerts';
import type { Plan, ResourceChange } from './terraform-plan-model';
import { attr, Checks, get, ofType } from './terraform-plan-model';

/** The alerts, not the autoscaling policies' alarms (`scale_in`, `scale_out`), which nobody is paged for. */
const alertsOf = (plan: Plan): ResourceChange[] =>
  [...ofType(plan, 'aws_cloudwatch_metric_alarm'), ...ofType(plan, 'aws_cloudwatch_composite_alarm')].filter(
    (c) => !/^module\.workers\[/.test(c.address)
  );

/** Every alert of the plan (the monitoring module's, or the control plane's) links a runbook that exists. */
export function checkAlarmRunbooks(plan: Plan, checks: Checks, root: string): void {
  checkRunbookLinks(
    new Map(alertsOf(plan).map((c) => [`alarm ${c.address}`, attr(c, 'alarm_description')] as const)),
    root,
    checks
  );
}

/** The example as CI plans it, with `services` worker services and `queues` queues and no exported metric. */
export function checkAwsAlerts(plan: Plan, checks: Checks, services: readonly string[], queues: readonly string[]): void {
  const metric = ofType(plan, 'aws_cloudwatch_metric_alarm');
  const absent = metric.filter((c) => c.name === 'worker_absent');
  checks.ok(
    'one no-task alarm per worker service',
    absent.map((c) => String(attr(c, 'dimensions', 'ServiceName'))).sort().join() === [...services].sort().join(),
    absent.map((c) => c.address).join()
  );
  checks.ok(
    'a service with no task reports no CPU: that is the alarm',
    absent.every(
      (c) =>
        attr(c, 'treat_missing_data') === 'breaching' &&
        attr(c, 'namespace') === 'AWS/ECS' &&
        attr(c, 'statistic') === 'SampleCount'
    )
  );
  const composite = ofType(plan, 'aws_cloudwatch_composite_alarm').find((c) => c.name === 'workers_idle_with_backlog');
  const rule = String(attr(composite, 'alarm_rule'));
  checks.ok(
    'workers idle with backlog needs a stale bell and every worker service empty',
    composite !== undefined &&
      queues.every((q) => new RegExp(`ALARM\\("[^"]*${q}-queue-age"\\)`).test(rule)) &&
      services.every((s) => rule.includes(`${s}-no-tasks")`)) &&
      /\) AND \(/.test(rule),
    rule
  );
  checks.ok(
    'the alarms that read an exported metric do not exist until a metric is named',
    !metric.some((c) => ['claim_latency', 'dead_letter_queue_growth'].includes(c.name))
  );
}

/** With both metrics named: the claim alarm reads the 99th percentile, the growth alarm the rate of a lifetime total. */
export function checkAwsOptInAlerts(plan: Plan, checks: Checks, window: number): void {
  const metric = ofType(plan, 'aws_cloudwatch_metric_alarm');
  const latency = metric.find((c) => c.name === 'claim_latency');
  checks.ok(
    'claim_latency reads the named metric at p99',
    attr(latency, 'extended_statistic') === 'p99' &&
      attr(latency, 'namespace') === 'Qelay' &&
      attr(latency, 'metric_name') === 'claim_ms'
  );
  const growth = metric.find((c) => c.name === 'dead_letter_queue_growth');
  const queries = attr(growth, 'metric_query');
  const find = (id: string) => (Array.isArray(queries) ? queries.find((q) => get(q, 'id') === id) : undefined);
  checks.ok(
    'dead_letter_queue_growth alarms on the rate of the total, not its level',
    get(find('total'), 'return_data') === false &&
      get(find('total'), 'metric', 0, 'metric_name') === 'failed_total' &&
      get(find('total'), 'metric', 0, 'period') === window &&
      get(find('grown'), 'expression') === `RATE(total) * ${window}` &&
      get(find('grown'), 'return_data') === true &&
      attr(growth, 'metric_name') === null,
    JSON.stringify(queries)
  );
}
