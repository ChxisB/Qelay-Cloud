/**
 * What `scripts/check-terraform-control-plane-aws.ts` asserts about the services of `infra/aws/control-plane`: the
 * acceptance lines of task 43 (the same image as on any cloud, configured by environment only; non-secret
 * environment; event stream timeouts that outlast a stream; the migration kept out of the serving tasks) and the
 * places where the Terraform must agree with the code.
 */
import type { Checks, Plan, ResourceChange } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export interface Fixture {
  readonly account: string;
  readonly region: string;
  readonly name: string;
  readonly namespace: string;
  readonly cluster: string;
  readonly tasksGroup: string;
  readonly privateSubnets: readonly string[];
  readonly vpcCidr: string;
  readonly igw: string;
  readonly queueArns: readonly string[];
  readonly deadLetterArns: readonly string[];
  readonly databaseSecret: string;
  /** The key that seals webhook signing secrets: the API reads it, the panel and the migration do not. */
  readonly webhookKeySecret: string;
  readonly repositories: readonly string[];
  readonly apiImage: string;
  readonly panelImage: string;
  readonly apiHost: string;
  readonly panelHost: string;
  readonly certificate: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: string;
  readonly clientId: string;
}

/** What differs between the plans the check makes. */
export interface Variation {
  readonly apiInstances: number;
  /** Where autoscaling stops; absent: the same as apiInstances, a fixed count. */
  readonly apiMaxInstances?: number;
  readonly pooled: boolean;
  /** The one TLS variable the processes are given, and its value. */
  readonly tls: Readonly<Record<string, string>>;
  /** The secret the migration reads, and the pooler setting it runs with. */
  readonly migrateSecret: string;
  readonly migratePooler: 'none' | 'transaction';
}

interface Container {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[];
  readonly stopTimeout?: number;
  readonly portMappings?: ReadonlyArray<{ readonly containerPort: number }>;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly valueFrom: string }>;
  readonly logConfiguration?: { readonly options: Readonly<Record<string, string>> };
}

export const find = (plan: Plan, type: string, name: string): ResourceChange | undefined =>
  plan.resource_changes.find((c) => c.type === type && c.name === name);

/** The references of one expression of a root-module resource: the addresses it is built from. */
export function rootReferences(plan: Plan, address: string, ...path: ReadonlyArray<string | number>) {
  const found = plan.configuration.root_module.resources?.find((c) => c.address === address);
  const references = get(found?.expressions, ...path, 'references');
  return Array.isArray(references) ? references.map(String) : [];
}

/** The one container of a task definition, read from the JSON string the plan carries. */
export function containerOf(change: ResourceChange | undefined): Container | undefined {
  if (change === undefined) return undefined;
  const raw = get(after(change), 'container_definitions');
  if (typeof raw !== 'string') return undefined;
  const all = JSON.parse(raw) as Container[];
  return all.length === 1 ? all[0] : undefined;
}

const envOf = (c: Container) => new Map(c.environment.map((e) => [e.name, e.value]));
const secretsOf = (c: Container) => new Map(c.secrets.map((s) => [s.name, s.valueFrom]));
const TLS = ['QCLOUD_DATABASE_TLS', 'QCLOUD_DATABASE_TLS_CA', 'QCLOUD_DATABASE_TLS_CA_FILE'];

/** The checks every container shares: no credential value, nothing secret-looking in the plain environment. */
export function checkHygiene(checks: Checks, who: string, c: Container): void {
  const env = envOf(c);
  const secrets = secretsOf(c);
  const leaked = [...env].filter(([, value]) => /:\/\/[^/]*:[^/@]*@/.test(value)).map(([n]) => n);
  checks.ok(`${who}: no credential in an environment value`, leaked.length === 0, leaked.join(', '));
  const secretish = [...env.keys()].filter((n) => /(SECRET|PASSWORD|TOKEN)/.test(n));
  checks.ok(`${who}: no secret-looking plain setting`, secretish.length === 0, secretish.join(', '));
  checks.ok(
    `${who}: no emulator endpoint, no development token`,
    !env.has('QCLOUD_AWS_SQS_ENDPOINT') && ![...env.keys()].some((n) => n.startsWith('QCLOUD_API_DEV_TOKEN'))
  );
  checks.ok(
    `${who}: a secret is never also a plain value`,
    [...secrets.keys()].every((n) => !env.has(n))
  );
}

export function checkServices(plan: Plan, checks: Checks, fx: Fixture, v: Variation): void {
  const defs = {
    api: find(plan, 'aws_ecs_task_definition', 'api'),
    panel: find(plan, 'aws_ecs_task_definition', 'panel'),
    migrate: find(plan, 'aws_ecs_task_definition', 'migrate'),
  };
  const api = containerOf(defs.api);
  const panel = containerOf(defs.panel);
  const migrate = containerOf(defs.migrate);
  checks.ok('the API, panel and migration task definitions are planned', api && panel && migrate ? true : false);
  if (api === undefined || panel === undefined || migrate === undefined) return;

  for (const [who, def, box, image] of [
    ['API', defs.api, api, fx.apiImage],
    ['panel', defs.panel, panel, fx.panelImage],
    ['migration', defs.migrate, migrate, fx.apiImage],
  ] as const) {
    checks.ok(`${who}: Fargate on awsvpc`, get(after(def as ResourceChange), 'network_mode') === 'awsvpc' && get(after(def as ResourceChange), 'requires_compatibilities', 0) === 'FARGATE');
    checks.ok(`${who}: runs the image it is given`, box.image === image, box.image);
    checks.ok(
      `${who}: logs to its own group`,
      get(box.logConfiguration, 'options', 'awslogs-group') === `/qcloud/${fx.name}/${who === 'migration' ? 'migrate' : who.toLowerCase()}`
    );
    checkHygiene(checks, who, box);
  }
  checks.ok('the migration is the API image: one build is every cloud and every role', migrate.image === api.image);

  // --- the API ------------------------------------------------------------------------------------------------
  const env = envOf(api);
  const want: Record<string, string> = {
    QCLOUD_NAMESPACE: fx.namespace,
    QCLOUD_TRANSPORT: 'aws-sqs',
    QCLOUD_AWS_REGION: fx.region,
    QCLOUD_DATABASE_POOL_SIZE: '2',
    QCLOUD_DATABASE_POOLER: v.pooled ? 'transaction' : 'none',
    QCLOUD_API_OIDC_ISSUER: fx.issuer,
    QCLOUD_API_OIDC_AUDIENCE: fx.audience,
    QCLOUD_API_OIDC_JWKS_URL: fx.jwks,
    QCLOUD_API_CORS_ORIGINS: `https://${fx.panelHost}`,
    QCLOUD_API_EVENTS_HEARTBEAT_MS: '15000',
    QCLOUD_API_EVENTS_MAX_LIFETIME_MS: '600000',
    QCLOUD_API_EVENTS_MAX_STREAMS: '50',
    QCLOUD_API_SHUTDOWN_GRACE_MS: '8000',
    ...v.tls,
  };
  for (const [name, value] of Object.entries(want)) {
    checks.ok(`the API's ${name}`, env.get(name) === value, `${env.get(name)} vs ${value}`);
  }
  checks.ok('the API starts `serve`', api.command?.join(' ') === 'serve');
  checks.ok('the API listens on 8080', api.portMappings?.length === 1 && api.portMappings[0]?.containerPort === 8080);
  checks.ok('the API has exactly one TLS setting', TLS.filter((n) => env.has(n)).length === 1);
  checks.ok("the API's only cross-origin caller is the panel", env.get('QCLOUD_API_CORS_ORIGINS') === `https://${fx.panelHost}`);
  checks.ok('the API holds no listen URL: its streams poll', !env.has('QCLOUD_DATABASE_LISTEN_URL'));
  const apiSecrets = secretsOf(api);
  checks.ok(
    'the database URL and the webhook key are secret references to the data plane secrets',
    apiSecrets.get('QCLOUD_DATABASE_URL') === fx.databaseSecret &&
      apiSecrets.get('QCLOUD_WEBHOOK_KEY') === fx.webhookKeySecret &&
      apiSecrets.size === 2,
    JSON.stringify([...apiSecrets])
  );
  // The heartbeat, the stream lifetime and the stop window.
  checks.ok('ECS waits ten seconds past the shutdown grace before it kills the API', api.stopTimeout === 18, String(api.stopTimeout));

  // --- the panel ---------------------------------------------------------------------------------------------
  const panelEnv = envOf(panel);
  checks.ok("the panel is configured with the API's URL", panelEnv.get('QCLOUD_PANEL_API_BASE_URL') === `https://${fx.apiHost}`);
  checks.ok('the panel signs in with OIDC', panelEnv.get('QCLOUD_PANEL_AUTH_MODE') === 'oidc');
  checks.ok('the panel names the provider and its own client', panelEnv.get('QCLOUD_PANEL_OIDC_AUTHORITY') === fx.issuer && panelEnv.get('QCLOUD_PANEL_OIDC_CLIENT_ID') === fx.clientId);
  checks.ok('the panel holds no secret and no database setting', panel.secrets.length === 0 && ![...panelEnv.keys()].some((n) => n.startsWith('QCLOUD_DATABASE')));
  checks.ok('the panel starts its own entrypoint', panel.command === undefined);

  // --- the migration ----------------------------------------------------------------------------------------------
  const migrateEnv = envOf(migrate);
  checks.ok('the migration runs `migrate`', migrate.command?.join(' ') === 'migrate');
  checks.ok('the migration holds one connection', migrateEnv.get('QCLOUD_DATABASE_POOL_SIZE') === '1');
  checks.ok('the migration runs with the right pooler setting', migrateEnv.get('QCLOUD_DATABASE_POOLER') === v.migratePooler, migrateEnv.get('QCLOUD_DATABASE_POOLER'));
  checks.ok('the migration reads the database URL from a secret', secretsOf(migrate).get('QCLOUD_DATABASE_URL') === v.migrateSecret);
  checks.ok('the migration checks the certificate the same way', TLS.filter((n) => migrateEnv.has(n)).length === 1 && Object.entries(v.tls).every(([n, value]) => migrateEnv.get(n) === value));
  checks.ok('the migration needs no sign-in setting', ![...migrateEnv.keys()].some((n) => n.startsWith('QCLOUD_API_') || n.startsWith('QCLOUD_PANEL_')));
  checks.ok('no ECS service exists for the migration', find(plan, 'aws_ecs_service', 'migrate') === undefined);
  checks.ok(
    'no serving task migrates at start',
    ofType(plan, 'aws_ecs_task_definition')
      .filter((c) => c.name !== 'migrate')
      .every((c) => !(containerOf(c)?.command ?? []).includes('migrate'))
  );

  // Roles: only the API has a task role, so only the API holds an AWS credential.
  checks.ok('the API has a task role', typeof get(after(defs.api as ResourceChange), 'task_role_arn') === 'string' || rootReferences(plan, 'aws_ecs_task_definition.api', 'task_role_arn').includes('aws_iam_role.api_task.arn'));
  checks.ok('the panel has no task role', get(after(defs.panel as ResourceChange), 'task_role_arn') == null);
  checks.ok('the migration has no task role', get(after(defs.migrate as ResourceChange), 'task_role_arn') == null);
  for (const [who, def, role] of [
    ['api', 'api', 'api'],
    ['panel', 'panel', 'panel'],
    ['migrate', 'migrate', 'migrate'],
  ] as const) {
    checks.ok(
      `${who}: starts under its own execution role`,
      rootReferences(plan, `aws_ecs_task_definition.${def}`, 'execution_role_arn').some((r) => r.startsWith(`aws_iam_role.execution["${role}"]`)),
      rootReferences(plan, `aws_ecs_task_definition.${def}`, 'execution_role_arn').join(',')
    );
  }
}

/** The two ECS services: where they run, how they roll, and that nothing has a public address. */
export function checkEcsServices(plan: Plan, checks: Checks, fx: Fixture, v: Variation): void {
  const services = ofType(plan, 'aws_ecs_service');
  checks.ok('two services: the API and the panel', services.length === 2, String(services.length));
  for (const [name, count, container] of [
    ['api', v.apiInstances, 'api'],
    ['panel', 2, 'panel'],
  ] as const) {
    const s = find(plan, 'aws_ecs_service', name);
    const a = s === undefined ? undefined : after(s);
    checks.ok(`${name}: ${count} tasks on Fargate in the data plane's cluster`, get(a, 'desired_count') === count && get(a, 'launch_type') === 'FARGATE' && get(a, 'cluster') === fx.cluster);
    checks.ok(`${name}: a rollover never runs more tasks than the count`, get(a, 'deployment_maximum_percent') === 100);
    checks.ok(`${name}: a rollover keeps ${count >= 2 ? 'half' : 'none'} serving`, get(a, 'deployment_minimum_healthy_percent') === (count >= 2 ? 50 : 0));
    checks.ok(`${name}: a failed deployment rolls back`, get(a, 'deployment_circuit_breaker', 0, 'enable') === true && get(a, 'deployment_circuit_breaker', 0, 'rollback') === true);
    checks.ok(`${name}: private subnets, the tasks group, no public address`, JSON.stringify(get(a, 'network_configuration', 0, 'subnets')) === JSON.stringify([...fx.privateSubnets]) && JSON.stringify(get(a, 'network_configuration', 0, 'security_groups')) === JSON.stringify([fx.tasksGroup]) && get(a, 'network_configuration', 0, 'assign_public_ip') === false);
    checks.ok(`${name}: no shell into the task`, get(a, 'enable_execute_command') === false);
    checks.ok(`${name}: behind the load balancer on 8080`, get(a, 'load_balancer', 0, 'container_name') === container && get(a, 'load_balancer', 0, 'container_port') === 8080);
    checks.ok(`${name}: a grace period for start-up`, Number(get(a, 'health_check_grace_period_seconds')) >= 30);
  }
  const api = find(plan, 'aws_ecs_service', 'api');
  checks.ok('the API service rolls when the data plane says a secret changed', get(after(api as ResourceChange), 'triggers', 'rollout') !== undefined);
}

/**
 * Autoscaling of the API and, with an ingest, of the ingest: the target is registered for the right service between
 * the minimum and the maximum, one CPU target-tracking policy follows it, and the service does not fight it for the count.
 */
export function checkAutoscaling(plan: Plan, checks: Checks, fx: Fixture, api: { min: number; max: number }, ingest?: { min: number; max: number }): void {
  const scaled: Array<[string, string, number, number]> = [['api', 'api', api.min, api.max]];
  if (ingest !== undefined) scaled.push(['ingest', 'ingest', ingest.min, ingest.max]);
  const targets = ofType(plan, 'aws_appautoscaling_target');
  const policies = ofType(plan, 'aws_appautoscaling_policy');
  checks.ok('autoscaling: one target and one policy for each service that takes outside load', targets.length === scaled.length && policies.length === scaled.length, `${targets.length} targets, ${policies.length} policies`);
  for (const [name, who, min, max] of scaled) {
    const t = after(find(plan, 'aws_appautoscaling_target', name) as ResourceChange);
    const p = after(find(plan, 'aws_appautoscaling_policy', `${name}_cpu`) as ResourceChange);
    checks.ok(`${who}: scaled between ${min} and ${max} tasks, on the ECS desired count`, get(t, 'min_capacity') === min && get(t, 'max_capacity') === max && get(t, 'scalable_dimension') === 'ecs:service:DesiredCount' && get(t, 'service_namespace') === 'ecs');
    checks.ok(`${who}: the target is the service in the data plane's cluster`, get(t, 'resource_id') === `service/${fx.cluster.split('/')[1]}/${fx.name}-${who}`, String(get(t, 'resource_id')));
    checks.ok(`${who}: one target-tracking policy on average CPU, 60 by default, slow to scale in`, get(p, 'policy_type') === 'TargetTrackingScaling' && get(p, 'target_tracking_scaling_policy_configuration', 0, 'target_value') === 60 && get(p, 'target_tracking_scaling_policy_configuration', 0, 'predefined_metric_specification', 0, 'predefined_metric_type') === 'ECSServiceAverageCPUUtilization' && Number(get(p, 'target_tracking_scaling_policy_configuration', 0, 'scale_in_cooldown')) > Number(get(p, 'target_tracking_scaling_policy_configuration', 0, 'scale_out_cooldown')));
  }
}
