/**
 * What `scripts/check-terraform-plan.ts` asserts about a plan of `infra/gcp/example`. Each check is
 * one line of task 21's acceptance, or one place where the Terraform must agree with the code: the
 * Pub/Sub names with `packages/transport-gcp/src/names.ts`, the connection budget with
 * `packages/store-postgres/src/connection/budget.ts`.
 */
import { environmentNames, queueNames } from '../packages/transport-gcp/src/names';
import type { Plan, ResourceChange } from './terraform-plan-model';
import { ALLOWED_ROLES, after, envValue, get, ofType, referencesOf } from './terraform-plan-model';
import type { Checks } from './terraform-plan-model';

export function checkIdentities(plan: Plan, checks: Checks): void {
  const iam = plan.resource_changes.filter((c) => /_iam_(member|binding|policy)$/.test(c.type));
  const wide = plan.resource_changes.filter((c) =>
    /^google_(project|folder|organization)_iam/.test(c.type)
  );
  checks.ok(
    'no project, folder or organization IAM resource',
    wide.length === 0,
    wide.map((c) => c.address).join(', ')
  );
  for (const binding of iam) {
    const role = get(after(binding), 'role');
    // The member of a service-account binding is the deployer, which the operator names; the rest are ours.
    checks.ok(
      `${binding.address} grants an allowed role`,
      typeof role === 'string' && ALLOWED_ROLES.has(role),
      String(role)
    );
    checks.ok(
      `${binding.address} is not public`,
      !/all(Authenticated)?Users/.test(String(get(after(binding), 'member')))
    );
  }
  const roles = new Set(iam.map((binding) => get(after(binding), 'role')));
  checks.ok(
    'the roles in use are exactly the five the README lists',
    roles.size === ALLOWED_ROLES.size,
    [...roles].join(', ')
  );
}

export function checkDatabase(plan: Plan, checks: Checks, maxConnections: number): void {
  const [instance, ...rest] = ofType(plan, 'google_sql_database_instance');
  checks.ok('one database instance', instance !== undefined && rest.length === 0);
  if (instance === undefined) return;
  const db = after(instance);
  const settings = (...path: Array<string | number>) => get(db, 'settings', 0, ...path);
  checks.ok('PostgreSQL 16', get(db, 'database_version') === 'POSTGRES_16');
  checks.ok('deletion protection (API)', get(db, 'deletion_protection') === true);
  checks.ok(
    'deletion protection (instance setting)',
    settings('deletion_protection_enabled') === true
  );
  checks.ok('automated backups', settings('backup_configuration', 0, 'enabled') === true);
  checks.ok(
    'point-in-time recovery',
    settings('backup_configuration', 0, 'point_in_time_recovery_enabled') === true
  );
  checks.ok('private IP only', settings('ip_configuration', 0, 'ipv4_enabled') === false);
  checks.ok(
    'encrypted connections only',
    settings('ip_configuration', 0, 'ssl_mode') === 'ENCRYPTED_ONLY'
  );
  const flags = settings('database_flags');
  const flag = Array.isArray(flags)
    ? flags.find((f) => get(f, 'name') === 'max_connections')
    : undefined;
  checks.ok('max_connections is the budgeted flag', get(flag, 'value') === String(maxConnections));
}

/** Every queue has its own subscription, and each agrees with what the transport looks up. */
export function checkMessaging(
  plan: Plan,
  checks: Checks,
  namespace: string,
  queues: Record<string, unknown>
): void {
  const names = environmentNames(namespace);
  const topics = ofType(plan, 'google_pubsub_topic').map((c) => get(after(c), 'name'));
  checks.ok(
    "the doorbell topic has the transport's name",
    topics.includes(names.topic),
    String(topics)
  );
  checks.ok(
    "the dead-letter topic has the transport's name",
    topics.includes(names.deadLetterTopic)
  );
  const subscriptions = ofType(plan, 'google_pubsub_subscription');
  const byName = new Map(subscriptions.map((c) => [String(get(after(c), 'name')), after(c)]));
  checks.ok('two subscriptions per queue', subscriptions.length === 2 * Object.keys(queues).length);
  // A resource's id is unknown until it exists, so the topics a subscription points at are checked in the
  // configuration: what the expression refers to, not what it evaluates to.
  const refs = (resource: string, ...path: Array<string | number>) =>
    referencesOf(plan, 'messaging', resource, ...path);
  checks.ok(
    'queue subscriptions are on the doorbell topic',
    refs('google_pubsub_subscription.queue', 'topic').includes('google_pubsub_topic.bells.id')
  );
  checks.ok(
    'queue subscriptions dead-letter to the dead-letter topic',
    refs('google_pubsub_subscription.queue', 'dead_letter_policy', 0, 'dead_letter_topic').includes(
      'google_pubsub_topic.dead_letter.id'
    )
  );
  checks.ok(
    'dead-letter subscriptions are on the dead-letter topic',
    refs('google_pubsub_subscription.dead_letter', 'topic').includes(
      'google_pubsub_topic.dead_letter.id'
    )
  );
  for (const [queue, given] of Object.entries(queues)) {
    const wanted = queueNames(namespace, queue);
    const main = byName.get(wanted.subscription);
    const dead = byName.get(wanted.deadLetterSubscription);
    checks.ok(`${queue}: its own subscription`, main !== undefined);
    checks.ok(`${queue}: its own dead-letter subscription`, dead !== undefined);
    checks.ok(
      `${queue}: the transport's filter`,
      get(main, 'filter') === wanted.filter && get(dead, 'filter') === wanted.filter
    );
    checks.ok(
      `${queue}: no ordering, no exactly-once`,
      [main, dead].every(
        (s) =>
          get(s, 'enable_message_ordering') === false &&
          get(s, 'enable_exactly_once_delivery') === false
      )
    );
    checks.ok(
      `${queue}: never expires`,
      [main, dead].every((s) => get(s, 'expiration_policy', 0, 'ttl') === '')
    );
    const options = given as { ack_deadline_seconds?: number; max_delivery_attempts?: number };
    checks.ok(
      `${queue}: ack deadline`,
      get(main, 'ack_deadline_seconds') === (options.ack_deadline_seconds ?? 30)
    );
    checks.ok(
      `${queue}: delivery attempts`,
      get(main, 'dead_letter_policy', 0, 'max_delivery_attempts') ===
        (options.max_delivery_attempts ?? 5)
    );
    checks.ok(
      `${queue}: retry backoff 1 s to 10 s`,
      get(main, 'retry_policy', 0, 'minimum_backoff') === '1s' &&
        get(main, 'retry_policy', 0, 'maximum_backoff') === '10s'
    );
  }
  const alert = ofType(plan, 'google_monitoring_alert_policy').find((c) =>
    /dead-letter/.test(String(get(after(c), 'display_name')))
  );
  const filter = String(
    get(after(alert as ResourceChange), 'conditions', 0, 'condition_threshold', 0, 'filter')
  );
  const covered = Object.keys(queues).every((queue) =>
    filter.includes(queueNames(namespace, queue).deadLetterSubscription)
  );
  checks.ok(
    'the dead-letter depth alert covers every dead-letter subscription',
    alert !== undefined && covered
  );
}

export function checkServices(plan: Plan, checks: Checks): void {
  const services = ofType(plan, 'google_cloud_run_v2_service');
  for (const service of services) {
    const scaling = get(after(service), 'template', 0, 'scaling', 0);
    const max = get(scaling, 'max_instance_count');
    checks.ok(
      `${service.address} sets max_instance_count`,
      typeof max === 'number' && max >= 1,
      String(max)
    );
    checks.ok(
      `${service.address} is not open to everyone`,
      !JSON.stringify(after(service)).includes('allUsers')
    );
    const env = get(after(service), 'template', 0, 'containers', 0, 'env');
    const plain = Array.isArray(env) ? env.map((e) => String(get(e, 'value') ?? '')) : [];
    checks.ok(
      `${service.address} has no connection string in plain env`,
      plain.every((v) => !/postgres(ql)?:\/\//.test(v))
    );
    checks.ok(
      `${service.address} sets QCLOUD_DATABASE_POOL_SIZE`,
      envValue(service, 'QCLOUD_DATABASE_POOL_SIZE') !== undefined
    );
  }
  // A worker pool has no listener, no ceiling of its own and no plain connection string. Its ceiling is the
  // `qcloud-max-instances` label, which the budget counts and the autoscaler caps at.
  const pools = ofType(plan, 'google_cloud_run_v2_worker_pool');
  checks.ok('the workers are worker pools, one per worker service', pools.length > 0);
  for (const pool of pools) {
    const max = Number(get(after(pool), 'labels', 'qcloud-max-instances'));
    const count = Number(get(after(pool), 'scaling', 0, 'manual_instance_count'));
    checks.ok(`${pool.address} carries its ceiling`, Number.isInteger(max) && max >= 1, String(max));
    checks.ok(
      `${pool.address} starts at a fixed count inside the ceiling`,
      get(after(pool), 'scaling', 0, 'scaling_mode') === 'MANUAL' && count >= 0 && count <= max,
      `${count} of ${max}`
    );
    checks.ok(
      `${pool.address} has no connection string in plain env`,
      envPlain(pool).every((v) => !/postgres(ql)?:\/\//.test(v))
    );
    checks.ok(
      `${pool.address} sets QCLOUD_DATABASE_POOL_SIZE`,
      envValue(pool, 'QCLOUD_DATABASE_POOL_SIZE') !== undefined
    );
  }
  const tick = services.find((service) => service.name === 'tick');
  const scheduler = ofType(plan, 'google_cloud_scheduler_job')[0];
  const invoker = ofType(plan, 'google_cloud_run_v2_service_iam_member')[0];
  checks.ok(
    'the tick is fixed at one instance',
    get(after(tick as ResourceChange), 'template', 0, 'scaling', 0, 'max_instance_count') === 1
  );
  const tickContainer = get(after(tick as ResourceChange), 'template', 0, 'containers', 0);
  checks.ok(
    "the tick starts the maintenance package's CLI and serves (not the API's entrypoint)",
    JSON.stringify(get(tickContainer, 'command')) ===
      JSON.stringify(['bun', '/app/packages/maintenance/src/bin.ts']) &&
      JSON.stringify(get(tickContainer, 'args')) === JSON.stringify(['serve'])
  );
  const audience = envValue(tick as ResourceChange, 'QCLOUD_TICK_AUDIENCE');
  const email = envValue(tick as ResourceChange, 'QCLOUD_TICK_ALLOWED_EMAILS');
  checks.ok(
    'the scheduler signs for the audience the tick requires',
    get(after(scheduler as ResourceChange), 'http_target', 0, 'oidc_token', 0, 'audience') ===
      audience
  );
  checks.ok(
    'the scheduler posts to the tick',
    get(after(scheduler as ResourceChange), 'http_target', 0, 'uri') === `${audience}/internal/tick`
  );
  checks.ok(
    "only the scheduler's account may call the tick",
    get(
      after(scheduler as ResourceChange),
      'http_target',
      0,
      'oidc_token',
      0,
      'service_account_email'
    ) === email && get(after(invoker as ResourceChange), 'member') === `serviceAccount:${email}`
  );
  checks.ok(
    'Cloud Scheduler runs every minute',
    get(after(scheduler as ResourceChange), 'schedule') === '* * * * *'
  );
}

/** The pools' own `max_instances x pool` against the budget the plan reports, and against the TypeScript budget. */
export function workerProcesses(plan: Plan): { instances: number; connections: number } {
  let instances = 0;
  let connections = 0;
  for (const pool of ofType(plan, 'google_cloud_run_v2_worker_pool')) {
    const max = Number(get(after(pool), 'labels', 'qcloud-max-instances'));
    instances += max;
    connections += max * Number(envValue(pool, 'QCLOUD_DATABASE_POOL_SIZE'));
  }
  return { instances, connections };
}

function envPlain(resource: ResourceChange): string[] {
  const env = get(after(resource), 'template', 0, 'containers', 0, 'env');
  return Array.isArray(env) ? env.map((e) => String(get(e, 'value') ?? '')) : [];
}
