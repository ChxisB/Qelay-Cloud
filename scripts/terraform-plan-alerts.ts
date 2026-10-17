/**
 * The GCP alert policies of a plan (task 71): every policy names a runbook that exists in the repository, the two
 * policies that watch for something missing say so in a way Cloud Monitoring reads, and the ones that need an
 * exported metric exist only when a metric type is given.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, ResourceChange } from './terraform-plan-model';
import { after, Checks, get, ofType } from './terraform-plan-model';

const RUNBOOK = /Runbook: (?:[^\s]+)\/([a-z-]+)\.md/;

/** The runbook an alert's text points at, as a name, or undefined when it points at none. */
export const runbookOf = (text: unknown): string | undefined => RUNBOOK.exec(String(text))?.[1];

/** Each text carries a runbook link and the file is there. `where` names the thing being checked. */
export function checkRunbookLinks(
  texts: ReadonlyMap<string, unknown>,
  root: string,
  checks: Checks
): void {
  for (const [where, text] of texts) {
    const name = runbookOf(text);
    checks.ok(`${where} names a runbook`, name !== undefined);
    checks.ok(
      `${where}: docs/runbooks/${name}.md exists`,
      name !== undefined && existsSync(join(root, 'docs/runbooks', `${name}.md`))
    );
  }
}

const policies = (plan: Plan): ReadonlyMap<string, ResourceChange> =>
  new Map(
    ofType(plan, 'google_monitoring_alert_policy').map((c) => [String(c.name), c] as const)
  );

/** Alert policies of the example with no metric type given: the six that read Google's own metrics. */
export function checkAlerts(plan: Plan, checks: Checks, root: string): void {
  const found = policies(plan);
  checks.ok(
    'the default alert policies are the six that need no exported metric',
    [...found.keys()].sort().join() ===
      [
        'backlog_age',
        'database_connections',
        'dead_letter_depth',
        'scheduler_failures',
        'tick_absent',
        'workers_idle_with_backlog',
      ].join()
  );
  checkRunbookLinks(
    new Map(
      [...found].map(([name, c]) => [
        `alert ${name}`,
        get(after(c), 'documentation', 0, 'content'),
      ])
    ),
    root,
    checks
  );
  const absent = found.get('tick_absent');
  const absence = get(after(absent as ResourceChange), 'conditions', 0, 'condition_absent', 0);
  checks.ok(
    'tick_absent watches the scheduler job for a missing log entry',
    String(get(absence, 'filter')).includes('cloud_scheduler_job') &&
      String(get(absence, 'filter')).includes('log_entry_count')
  );
  checks.ok('tick_absent waits 900 s', get(absence, 'duration') === '900s');
  const idle = found.get('workers_idle_with_backlog');
  const conditions = get(after(idle as ResourceChange), 'conditions');
  const instances = get(conditions, 1, 'condition_threshold', 0);
  checks.ok(
    'workers_idle_with_backlog needs both: a backlog and no running instance',
    get(after(idle as ResourceChange), 'combiner') === 'AND' &&
      String(get(conditions, 0, 'condition_threshold', 0, 'filter')).includes('oldest_unacked') &&
      String(get(instances, 'filter')).includes('container/instance_count') &&
      String(get(instances, 'filter')).includes('resource.type="cloud_run_worker_pool"') &&
      String(get(instances, 'filter')).includes('worker_pool_name=one_of(') &&
      String(get(instances, 'filter')).includes('-worker')
  );
  checks.ok(
    'an absent instance series counts as no instance',
    get(instances, 'evaluation_missing_data') === 'EVALUATION_MISSING_DATA_ACTIVE'
  );
}

/** With a metric type for each, the two opt-in policies exist, read that metric, and name their runbook. */
export function checkOptInAlerts(plan: Plan, checks: Checks, root: string, types: string[]): void {
  const found = policies(plan);
  const latency = found.get('claim_latency');
  const growth = found.get('dead_letter_queue_growth');
  checks.ok('claim_latency exists once its metric type is given', latency !== undefined);
  checks.ok('dead_letter_queue_growth exists once its metric type is given', growth !== undefined);
  for (const [alert, type] of [
    [latency, types[0]],
    [growth, types[1]],
  ] as const) {
    checks.ok(
      `${alert?.name ?? 'an opt-in alert'} reads ${type}`,
      String(get(after(alert as ResourceChange), 'conditions', 0, 'condition_threshold', 0, 'filter')).includes(
        String(type)
      )
    );
  }
  checkRunbookLinks(
    new Map(
      [latency, growth].flatMap((c) =>
        c === undefined
          ? []
          : [[`alert ${c.name}`, get(after(c), 'documentation', 0, 'content')] as const]
      )
    ),
    root,
    checks
  );
}
