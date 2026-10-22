/**
 * What `scripts/check-terraform-plan-aws.ts` asserts about the data side of `infra/aws/example`: the database and its
 * safety settings, the network it sits in, the queues against `queueNames`, and the alarms.
 */
import { queueNames } from '../packages/transport-aws/src/names';
import { callReferences } from './terraform-plan-aws-model';
import type { Plan } from './terraform-plan-model';
import type { Checks } from './terraform-plan-model';
import { after, attr, get, isUnknown, ofType } from './terraform-plan-model';

export interface QueueSettings {
  readonly visibility_timeout_seconds?: number;
  readonly max_receive_count?: number;
  readonly retention_seconds?: number;
  readonly dead_letter_retention_seconds?: number;
}

const named = (plan: Plan, type: string) =>
  Object.fromEntries(ofType(plan, type).map((c) => [c.address, c]));

export function checkDatabase(plan: Plan, checks: Checks, maxConnections: number): void {
  const [db, ...more] = ofType(plan, 'aws_db_instance');
  checks.ok('one database instance', db !== undefined && more.length === 0);
  if (db === undefined) return;
  const a = after(db);
  checks.ok(
    'PostgreSQL 18',
    get(a, 'engine') === 'postgres' && String(get(a, 'engine_version')).startsWith('18')
  );
  checks.ok('the storage is encrypted', get(a, 'storage_encrypted') === true);
  checks.ok('deletion protection is on', get(a, 'deletion_protection') === true);
  checks.ok(
    'automated backups are kept',
    Number(get(a, 'backup_retention_period')) >= 1,
    String(get(a, 'backup_retention_period'))
  );
  checks.ok('a final snapshot is taken on deletion', get(a, 'skip_final_snapshot') === false);
  checks.ok('the instance has no public address', get(a, 'publicly_accessible') === false);
  checks.ok(
    'no IAM database authentication (a direct connection uses the password)',
    get(a, 'iam_database_authentication_enabled') === false
  );
  checks.ok('storage autoscaling has a ceiling', Number(get(a, 'max_allocated_storage')) > 0);

  const [group, ...others] = ofType(plan, 'aws_db_parameter_group');
  checks.ok('one parameter group', group !== undefined && others.length === 0);
  const parameters = attr(group, 'parameter');
  const parameter = (name: string) =>
    Array.isArray(parameters) ? parameters.find((p) => get(p, 'name') === name) : undefined;
  checks.ok('the parameter group is postgres18', attr(group, 'family') === 'postgres18');
  checks.ok(
    "max_connections is the budget's number, applied at the next reboot",
    get(parameter('max_connections'), 'value') === String(maxConnections) &&
      get(parameter('max_connections'), 'apply_method') === 'pending-reboot',
    JSON.stringify(parameter('max_connections'))
  );
  checks.ok('plaintext connections are refused', get(parameter('rds.force_ssl'), 'value') === '1');
  checks.ok(
    'the session timeouts are set on the server, at once: statement 30 s, lock 5 s, idle in transaction 30 s',
    ['statement_timeout:30000', 'lock_timeout:5000', 'idle_in_transaction_session_timeout:30000'].every((pair) => {
      const [name, value] = pair.split(':') as [string, string];
      return get(parameter(name), 'value') === value && get(parameter(name), 'apply_method') === 'immediate';
    })
  );

  checks.ok(
    "the database's group admits the tasks' group",
    callReferences(plan, 'database', 'client_security_group_ids').includes(
      'module.network.tasks_security_group_id'
    )
  );
}

/** The proxy's plan: what is added, and what is still direct. */
export function checkProxy(plan: Plan, checks: Checks, present: boolean): void {
  const proxies = ofType(plan, 'aws_db_proxy');
  checks.ok(`${present ? 'an' : 'no'} RDS Proxy`, proxies.length === (present ? 1 : 0));
  const [proxy] = proxies;
  if (proxy === undefined) return;
  checks.ok(
    'the proxy speaks PostgreSQL and requires TLS',
    get(after(proxy), 'engine_family') === 'POSTGRESQL' && get(after(proxy), 'require_tls') === true
  );
  checks.ok(
    'the proxy signs in with the secret, not IAM',
    get(after(proxy), 'auth', 0, 'auth_scheme') === 'SECRETS' &&
      get(after(proxy), 'auth', 0, 'iam_auth') === 'DISABLED'
  );
  const [target] = ofType(plan, 'aws_db_proxy_default_target_group');
  checks.ok(
    'the proxy takes a share of max_connections, not all of it',
    Number(attr(target, 'connection_pool_config', 0, 'max_connections_percent')) <=
      50
  );
}

export function checkNetwork(plan: Plan, checks: Checks, egress: 'nat' | 'none'): void {
  const subnets = ofType(plan, 'aws_subnet');
  const privateSubnets = subnets.filter((s) => get(after(s), 'tags', 'tier') === 'private');
  checks.ok('a private subnet per zone', privateSubnets.length === 2, String(privateSubnets.length));
  checks.ok(
    'no subnet hands its instances a public address',
    subnets.every((s) => get(after(s), 'map_public_ip_on_launch') === false)
  );
  const gateways = ofType(plan, 'aws_internet_gateway').length + ofType(plan, 'aws_nat_gateway').length;
  checks.ok(
    egress === 'nat'
      ? 'one internet gateway and one NAT gateway'
      : 'no internet gateway, no NAT gateway, no public subnet, no route out',
    egress === 'nat'
      ? gateways === 2 && subnets.length === 3
      : gateways === 0 &&
          subnets.length === 2 &&
          ofType(plan, 'aws_route').length === 0 &&
          ofType(plan, 'aws_eip').length === 0
  );
  const [fallback] = ofType(plan, 'aws_default_security_group');
  checks.ok(
    "the VPC's default security group has no rules",
    fallback !== undefined &&
      ['ingress', 'egress'].every((side) => {
        const rules = get(after(fallback), side);
        return rules === undefined || (Array.isArray(rules) && rules.length === 0);
      })
  );
  checks.ok(
    'no inbound rule is open to the internet',
    ofType(plan, 'aws_vpc_security_group_ingress_rule').every(
      (r) => get(after(r), 'cidr_ipv4') == null && get(after(r), 'cidr_ipv6') == null
    )
  );
  checks.ok(
    'the only outbound rule to the internet is HTTPS',
    ofType(plan, 'aws_vpc_security_group_egress_rule').every(
      (r) =>
        get(after(r), 'cidr_ipv4') !== '0.0.0.0/0' ||
        (get(after(r), 'from_port') === 443 && get(after(r), 'to_port') === 443)
    )
  );
  const endpoints = ofType(plan, 'aws_vpc_endpoint').map((e) => String(get(after(e), 'service_name')));
  checks.ok(
    'an S3 gateway endpoint, whatever the egress',
    endpoints.includes('com.amazonaws.eu-west-2.s3')
  );
  const wanted =
    egress === 'nat' ? ['sqs', 'secretsmanager'] : ['sqs', 'secretsmanager', 'logs', 'ecr.api', 'ecr.dkr'];
  for (const service of wanted) {
    const found = ofType(plan, 'aws_vpc_endpoint').find(
      (e) => get(after(e), 'service_name') === `com.amazonaws.eu-west-2.${service}`
    );
    checks.ok(
      `${service} is reached through a private-DNS interface endpoint`,
      attr(found, 'vpc_endpoint_type') === 'Interface' &&
        attr(found, 'private_dns_enabled') === true
    );
  }
  checks.ok(
    'no interface endpoint beyond those asked for',
    endpoints.length === wanted.length + 1,
    endpoints.join(', ')
  );
}

/** Every queue: its name, tags, settings, redrive policy and encryption, against what `ensureQueue` would make. */
export function checkMessaging(
  plan: Plan,
  checks: Checks,
  namespace: string,
  queues: Readonly<Record<string, QueueSettings>>,
  expectKey?: string
): void {
  const main = named(plan, 'aws_sqs_queue');
  checks.ok(
    'a queue and a dead-letter queue per Qelay queue',
    Object.keys(main).length === Object.keys(queues).length * 2
  );
  for (const [queue, settings] of Object.entries(queues)) {
    const names = queueNames(namespace, queue);
    const q = main[`module.messaging.aws_sqs_queue.main["${queue}"]`];
    const d = main[`module.messaging.aws_sqs_queue.dead_letter["${queue}"]`];
    const where = `${queue}${names.hashed ? ' (hashed)' : ''}`;
    checks.ok(`${where}: the name is the transport's`, attr(q, 'name') === names.queue);
    checks.ok(
      `${where}: the dead-letter name is the transport's`,
      attr(d, 'name') === names.deadLetter
    );
    for (const [label, change] of [
      ['queue', q],
      ['dead-letter queue', d],
    ] as const) {
      const tags = attr(change, 'tags') as Record<string, string>;
      checks.ok(
        `${where}: the ${label} carries the transport's tags`,
        Object.entries(names.tags).every(([key, value]) => tags?.[key] === value),
        JSON.stringify(tags)
      );
      checks.ok(`${where}: the ${label} is a standard queue`, attr(change, 'fifo_queue') === false);
      checks.ok(
        `${where}: the ${label} is encrypted`,
        expectKey === undefined
          ? isUnknown(change, 'kms_master_key_id')
          : attr(change, 'kms_master_key_id') === expectKey,
        String(attr(change, 'kms_master_key_id'))
      );
    }
    checks.ok(
      `${where}: the visibility timeout`,
      attr(q, 'visibility_timeout_seconds') === (settings.visibility_timeout_seconds ?? 30)
    );
    checks.ok(
      `${where}: the retention`,
      attr(q, 'message_retention_seconds') === (settings.retention_seconds ?? 345600) &&
        attr(d, 'message_retention_seconds') ===
          (settings.dead_letter_retention_seconds ?? 1209600)
    );
    const redrive = JSON.parse(String(attr(q, 'redrive_policy'))) as Record<string, unknown>;
    checks.ok(
      `${where}: gives up into its own dead-letter queue after the same count`,
      redrive.deadLetterTargetArn ===
        `arn:aws:sqs:eu-west-2:123456789012:${names.deadLetter}` &&
        redrive.maxReceiveCount === (settings.max_receive_count ?? 5),
      JSON.stringify(redrive)
    );
    const allow = named(plan, 'aws_sqs_queue_redrive_allow_policy')[
      `module.messaging.aws_sqs_queue_redrive_allow_policy.dead_letter["${queue}"]`
    ];
    checks.ok(
      `${where}: only its own queue may redrive into the dead-letter queue`,
      get(JSON.parse(String(attr(allow, 'redrive_allow_policy'))), 'redrivePermission') ===
        'byQueue'
    );
  }
}

/** The alarms: one set per queue, the database's, and the tick's. */
export function checkAlarms(plan: Plan, checks: Checks, queues: readonly string[], maxConnections: number): void {
  const alarms = ofType(plan, 'aws_cloudwatch_metric_alarm');
  const count = (name: string) => alarms.filter((a) => a.name === name).length;
  for (const kind of ['dead_letter_depth', 'dead_letter_age', 'queue_age']) {
    checks.ok(`${kind}: one alarm per queue`, count(kind) === queues.length, String(count(kind)));
  }
  const depth = alarms.find((a) => a.name === 'dead_letter_depth');
  checks.ok(
    'a bell in a dead-letter queue raises the alarm',
    attr(depth, 'threshold') === 0 &&
      attr(depth, 'comparison_operator') === 'GreaterThanThreshold'
  );
  const connections = alarms.find((a) => a.name === 'database_connections');
  checks.ok(
    'database connections alarm at 80% of max_connections',
    attr(connections, 'threshold') === maxConnections * 0.8,
    String(attr(connections, 'threshold'))
  );
  const stalled = alarms.find((a) => a.name === 'tick_stalled');
  checks.ok(
    'a tick that never reports is an alarm, not a missing datum',
    attr(stalled, 'treat_missing_data') === 'breaching' &&
      attr(stalled, 'metric_name') === 'TickSucceeded'
  );
  const [filter] = ofType(plan, 'aws_cloudwatch_log_metric_filter');
  checks.ok(
    "the tick's success is counted from its report line",
    attr(filter, 'pattern') === '{ $.ok = true }'
  );
  for (const name of ['database_storage', 'database_cpu', 'database_cpu_credits']) {
    checks.ok(`${name} is watched`, count(name) === 1);
  }
  const credits = alarms.find((a) => a.name === 'database_cpu_credits');
  checks.ok(
    'a burstable database alarms on borrowed credits, which are billed',
    attr(credits, 'metric_name') === 'CPUSurplusCreditBalance' &&
      attr(credits, 'threshold') === 0 &&
      attr(credits, 'comparison_operator') === 'GreaterThanThreshold'
  );
}
