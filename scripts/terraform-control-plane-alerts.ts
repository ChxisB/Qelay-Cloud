/**
 * The control plane's one alert (task 71), on GCP and on AWS: it watches the API's own 5xx answers, links a runbook
 * that exists, and is absent when `alert_api_errors` is false. It does not watch the load balancer's or Cloud Run's
 * own errors, which say "no healthy instance" and are the health check's business.
 */
import { checkRunbookLinks } from './terraform-plan-alerts';
import type { Plan } from './terraform-plan-model';
import { after, attr, Checks, get, ofType } from './terraform-plan-model';

export function checkGcpApiAlert(plan: Plan, checks: Checks, root: string, off: Plan | null): void {
  const [policy] = ofType(plan, 'google_monitoring_alert_policy');
  checks.ok('the control API has an error alert', policy?.name === 'api_errors');
  if (policy === undefined) return;
  const threshold = get(after(policy), 'conditions', 0, 'condition_threshold', 0);
  checks.ok(
    'the alert counts 5xx responses of the API service for five minutes',
    String(get(threshold, 'filter')).includes('response_code_class="5xx"') &&
      String(get(threshold, 'filter')).includes('request_count') &&
      String(get(threshold, 'filter')).includes('qcloud-ci-api') &&
      get(threshold, 'duration') === '300s',
    String(get(threshold, 'filter'))
  );
  checkRunbookLinks(
    new Map([['control API alert', get(after(policy), 'documentation', 0, 'content')]]),
    root,
    checks
  );
  checks.ok(
    'alert_api_errors=false removes it',
    off !== null && ofType(off, 'google_monitoring_alert_policy').length === 0
  );
}

export function checkAwsApiAlarm(plan: Plan, checks: Checks, root: string, off: Plan | null): void {
  const [alarm] = ofType(plan, 'aws_cloudwatch_metric_alarm');
  checks.ok('the control API has an error alarm', alarm?.name === 'api_errors');
  if (alarm === undefined) return;
  checks.ok(
    'the alarm counts the target group’s 5xx for five minutes in a row, and quiet is not an alarm',
    attr(alarm, 'namespace') === 'AWS/ApplicationELB' &&
      attr(alarm, 'metric_name') === 'HTTPCode_Target_5XX_Count' &&
      attr(alarm, 'statistic') === 'Sum' &&
      attr(alarm, 'evaluation_periods') === 5 &&
      attr(alarm, 'datapoints_to_alarm') === 5 &&
      attr(alarm, 'treat_missing_data') === 'notBreaching'
  );
  const referenced = (plan.configuration.root_module as { resources?: ReadonlyArray<{ address: string; expressions?: unknown }> }).resources;
  const refs = get(referenced?.find((r) => r.address === alarm.address.replace(/\[\d+\]$/, ''))?.expressions, 'dimensions', 'references');
  checks.ok(
    'its dimensions are the API’s own load balancer and target group',
    Array.isArray(refs) && refs.includes('aws_lb.control.arn_suffix') && refs.includes('aws_lb_target_group.api.arn_suffix'),
    JSON.stringify(refs)
  );
  checkRunbookLinks(new Map([['control API alarm', attr(alarm, 'alarm_description')]]), root, checks);
  checks.ok(
    'alert_api_errors=false removes it',
    off !== null && ofType(off, 'aws_cloudwatch_metric_alarm').length === 0
  );
}
