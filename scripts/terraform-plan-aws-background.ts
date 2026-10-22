/**
 * What `scripts/check-terraform-plan-aws.ts` asserts about the loop and the sender of `infra/aws/example` (two ECS
 * services of the tick image on the tick's roles, holding the webhook key) and about the Multi-AZ DB cluster variant.
 */
import { callReferences, same } from './terraform-plan-aws-model';
import type { Planner } from './terraform-plan-aws-variations';
import type { Checks, Plan } from './terraform-plan-model';
import { after, attr, get, ofType } from './terraform-plan-model';

const POOLS = [
  ['tick-loop', 'loop', 1],
  ['webhook-sender', 'send', 2],
] as const;

/** The two pools of the CI variables: a fixed number of tasks, the tick's roles, the key, and no scaling. */
export function checkBackground(plan: Plan, checks: Checks, tickEntry: readonly string[]): void {
  const out = get(plan.output_changes.processes, 'after', 'background') as Record<string, Record<string, unknown>>;
  for (const [key, subcommand, instances] of POOLS) {
    const address = `module.background["${key}"]`;
    const service = ofType(plan, 'aws_ecs_service').find((c) => c.address === `${address}.aws_ecs_service.this`);
    const process = out[key] ?? {};
    checks.ok(`${key}: runs \`${subcommand}\` from the tick's entry point`, same(process.command as string[], [subcommand]) && same(process.entry_point as string[], tickEntry), JSON.stringify([process.entry_point, process.command]));
    checks.ok(`${key}: ${instances} fixed task(s), no scaling`, attr(service, 'desired_count') === instances && process.max_instances === instances, String(attr(service, 'desired_count')));
    const target = ofType(plan, 'aws_appautoscaling_target').find((c) => c.address === `${address}.aws_appautoscaling_target.this`);
    checks.ok(`${key}: its scaling range is the one count`, attr(target, 'min_capacity') === instances && attr(target, 'max_capacity') === instances);
    checks.ok(`${key}: no scaling policy`, !ofType(plan, 'aws_appautoscaling_policy').some((c) => c.address.startsWith(address)));
    checks.ok(`${key}: no public address`, attr(service, 'network_configuration', 0, 'assign_public_ip') === false);
    checks.ok(`${key}: holds the database URL and the webhook key as secrets`, same(process.secret_env as string[], ['QCLOUD_DATABASE_URL', 'QCLOUD_WEBHOOK_KEY']), String(process.secret_env));
    checks.ok(`${key}: its own log group`, ofType(plan, 'aws_cloudwatch_log_group').some((c) => c.address === `${address}.aws_cloudwatch_log_group.this`));
    const env = (process.environment ?? {}) as Record<string, string>;
    checks.ok(`${key}: its pool is the one the budget counts`, env.QCLOUD_DATABASE_POOL_SIZE === '2', env.QCLOUD_DATABASE_POOL_SIZE);
    checks.ok(`${key}: no key or URL in the plain environment`, !Object.keys(env).some((k) => /WEBHOOK_KEY|DATABASE_(LISTEN_)?URL/.test(k)));
  }
  checks.ok(
    'the loop and the sender run as the tick roles, not the workers',
    callReferences(plan, 'background', 'task_role_arn').includes('module.iam.tick_task_role_arn') &&
      callReferences(plan, 'background', 'execution_role_arn').includes('module.iam.tick_execution_role_arn')
  );
  checks.ok(
    'the webhook key is a secret of its own',
    ofType(plan, 'aws_secretsmanager_secret').some((c) => get(after(c), 'name') === 'qcloud-ci/webhook-key')
  );
  checks.ok(
    'one ECS service per background pool',
    ofType(plan, 'aws_ecs_service').filter((c) => c.address.startsWith('module.background[')).length === POOLS.length
  );
}

/** The Multi-AZ DB cluster in place of the instance, and what is refused beside it. */
export function checkCluster(plan: Planner, checks: Checks): void {
  const cluster = plan('cluster', 'database_cluster={instance_class="db.m6gd.large",storage_type="io1",iops=3000}');
  checks.ok('a Multi-AZ DB cluster plans', cluster.plan !== null, cluster.diagnostics);
  if (cluster.plan !== null) {
    const p = cluster.plan;
    checks.ok('no single instance beside it', ofType(p, 'aws_db_instance').length === 0);
    const [db, ...more] = ofType(p, 'aws_rds_cluster');
    checks.ok('one cluster', db !== undefined && more.length === 0);
    const a = after(db);
    checks.ok('the class, storage and IOPS asked for', get(a, 'db_cluster_instance_class') === 'db.m6gd.large' && get(a, 'storage_type') === 'io1' && get(a, 'iops') === 3000);
    checks.ok('PostgreSQL 18', get(a, 'engine') === 'postgres' && String(get(a, 'engine_version')).startsWith('18'));
    checks.ok('encrypted, protected from deletion, a final snapshot, backups kept', get(a, 'storage_encrypted') === true && get(a, 'deletion_protection') === true && get(a, 'skip_final_snapshot') === false && Number(get(a, 'backup_retention_period')) >= 1);
    checks.ok('no IAM database authentication', get(a, 'iam_database_authentication_enabled') === false);
    const [group] = ofType(p, 'aws_rds_cluster_parameter_group');
    const parameter = (name: string) => (attr(group, 'parameter') as unknown[] | undefined)?.find((x) => get(x, 'name') === name);
    checks.ok('the cluster group is postgres18 with the budget\'s max_connections at the next reboot and TLS forced', attr(group, 'family') === 'postgres18' && get(parameter('max_connections'), 'value') === '100' && get(parameter('max_connections'), 'apply_method') === 'pending-reboot' && get(parameter('rds.force_ssl'), 'value') === '1');
    checks.ok('the cluster group sets the same session timeouts', ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout'].every((name) => get(parameter(name), 'apply_method') === 'immediate') && get(parameter('statement_timeout'), 'value') === '30000');
    const alarm = ofType(p, 'aws_cloudwatch_metric_alarm').find((c) => c.name === 'database_cpu');
    checks.ok('the database alarms follow the cluster dimension', get(attr(alarm, 'dimensions'), 'DBClusterIdentifier') !== undefined && get(attr(alarm, 'dimensions'), 'DBInstanceIdentifier') === undefined, JSON.stringify(attr(alarm, 'dimensions')));
  }
  const refused = (label: string, why: RegExp, what: string, ...overrides: string[]) => {
    const result = plan(label, ...overrides);
    checks.ok(what, result.plan === null && why.test(result.diagnostics), result.diagnostics);
  };
  const cl = 'database_cluster={instance_class="db.m6gd.large",storage_type="io1",iops=3000}';
  refused('cluster-proxy', /cluster and proxy are exclusive/, 'a cluster behind an RDS Proxy is refused', cl, 'rds_proxy={}');
  refused('cluster-multi-az', /cluster and multi_az are exclusive/, 'a cluster with database_multi_az is refused', cl, 'database_multi_az=true');
  refused('sender-no-key', /webhooks/, 'a sender without webhooks is refused', 'webhooks=false');
}
