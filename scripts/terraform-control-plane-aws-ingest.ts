/**
 * What `scripts/check-terraform-control-plane-aws.ts` asserts about the opt-in `ingest` of `infra/aws/control-plane`
 * (inbound sources, task 09): its own ECS service behind the shared load balancer on a host name of its own, reached
 * on `/s/*` only, reading the database secrets with an execution role and holding no task role (so no queue and no
 * other AWS credential), counted in the connection budget, and rate limited by its own WAF rule when there is one.
 */
import type { Fixture } from './terraform-control-plane-aws-services';
import { checkHygiene, containerOf, find, rootReferences } from './terraform-control-plane-aws-services';
import { list, policyOf, same } from './terraform-plan-aws-model';
import type { Checks, Plan, ResourceChange } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export const INGEST_HOST = 'in.qcloud-ci.example.com';
const json = (value: unknown) => JSON.stringify(value);
const TLS = ['QCLOUD_DATABASE_TLS', 'QCLOUD_DATABASE_TLS_CA', 'QCLOUD_DATABASE_TLS_CA_FILE'];

type Planner = (label: string, ...overrides: string[]) => { plan: Plan | null; diagnostics: string };

/** The ingest as the plans below give it: two tasks and the default pool, which the budget of 6 processes covers. */
function ingestVar(image: string, extra = ''): string {
  return `ingest={image="${image}",hostname="${INGEST_HOST}"${extra}}`;
}

export function checkAwsIngestPlans(here: Planner, checks: Checks, fx: Fixture, secretsKey: string, base: Plan | null): void {
  const image = `${fx.account}.dkr.ecr.${fx.region}.amazonaws.com/qcloud-ingest:ci`;
  const repositories = [...fx.repositories, `arn:aws:ecr:${fx.region}:${fx.account}:repository/qcloud-ingest`];
  const common = ['budgeted_control_processes=6', `image_repository_arns=${json(repositories)}`];

  checks.ok(
    'ingest: nothing of it unless asked for',
    base !== null &&
      ['aws_ecs_service', 'aws_ecs_task_definition', 'aws_lb_target_group', 'aws_cloudwatch_log_group'].every((t) => !ofType(base, t).some((c) => c.name === 'ingest')) &&
      find(base, 'aws_lb_listener_rule', 'ingest') === undefined &&
      get(base.output_changes.ingest_url, 'after') == null
  );

  const plain = here('ingest', ...common, ingestVar(image));
  checks.ok('ingest: a plan with an ingest plans', plain.plan !== null, plain.diagnostics);
  if (plain.plan !== null) checkAwsIngest(plain.plan, checks, fx, image, repositories, undefined);

  const keyed = here('ingest-secrets-key', ...common, ingestVar(image), `secrets_kms_key_arn=${secretsKey}`);
  checks.ok('ingest: a plan with an ingest and a secrets key plans', keyed.plan !== null, keyed.diagnostics);
  if (keyed.plan !== null) checkAwsIngest(keyed.plan, checks, fx, image, repositories, secretsKey);

  const edge = here('ingest-edge', ...common, ingestVar(image, ',rate_limit_per_minute=3000'), 'edge_rate_limit_per_minute=1200');
  checks.ok('ingest: a plan with an ingest behind the WAF plans', edge.plan !== null, edge.diagnostics);
  if (edge.plan !== null) checkAwsIngestEdge(edge.plan, checks, 1200, 3000);

  const refusals: Array<[string, string[], RegExp]> = [
    ['more tasks than the connection budget counts, the ingest included', [ingestVar(image)], /would run/],
    ['an ingest pool bigger than the budgeted one', ['budgeted_control_processes=6', ingestVar(image, ',pool_size=5')], /ingest\.pool_size/],
    ['an ingest on the API host name', ['budgeted_control_processes=6', `ingest={image="${image}",hostname="${fx.apiHost}"}`], /three different names/],
    ['an upper-case ingest host name', ['budgeted_control_processes=6', `ingest={image="${image}",hostname="IN.example.com"}`], /lowercase DNS name/],
    ['no ingest task', ['budgeted_control_processes=6', ingestVar(image, ',instances=0')], /whole numbers/],
    ['an ingest rate limit under 10', ['budgeted_control_processes=6', ingestVar(image, ',rate_limit_per_minute=5')], /from 10/],
  ];
  for (const [what, overrides, expected] of refusals) {
    const refused = here(`ingest-${what.replace(/\W+/g, '-')}`, ...overrides);
    checks.ok(`refused: ${what}`, refused.plan === null && expected.test(refused.diagnostics), refused.plan === null ? refused.diagnostics : 'it planned');
  }
}

function checkAwsIngest(plan: Plan, checks: Checks, fx: Fixture, image: string, repositories: readonly string[], secretsKey: string | undefined): void {
  const def = find(plan, 'aws_ecs_task_definition', 'ingest');
  const box = containerOf(def);
  checks.ok('ingest: its task definition is planned', box !== undefined);
  if (def === undefined || box === undefined) return;
  const env = new Map(box.environment.map((e) => [e.name, e.value]));
  const secrets = new Map(box.secrets.map((s) => [s.name, s.valueFrom]));
  const api = containerOf(find(plan, 'aws_ecs_task_definition', 'api'));

  checks.ok('ingest: Fargate on awsvpc, the image it is given', get(after(def), 'network_mode') === 'awsvpc' && get(after(def), 'requires_compatibilities', 0) === 'FARGATE' && box.image === image, box.image);
  checks.ok('ingest: it listens on 8081 and logs to its own group', box.portMappings?.length === 1 && box.portMappings[0]?.containerPort === 8081 && get(box.logConfiguration, 'options', 'awslogs-group') === `/qcloud/${fx.name}/ingest`);
  checks.ok('ingest: it has no command, so it runs its own entrypoint', box.command === undefined);
  checkHygiene(checks, 'ingest', box);

  const want: Record<string, string> = {
    QCLOUD_NAMESPACE: fx.namespace,
    QCLOUD_DATABASE_POOL_SIZE: '2',
    QCLOUD_DATABASE_POOLER: 'none',
    QCLOUD_INGEST_HOST: '0.0.0.0',
    QCLOUD_INGEST_PORT: '8081',
    QCLOUD_INGEST_SHUTDOWN_GRACE_MS: '8000',
  };
  for (const [name, value] of Object.entries(want)) checks.ok(`ingest: ${name}`, env.get(name) === value, `${env.get(name)} vs ${value}`);
  const apiEnv = new Map((api?.environment ?? []).map((e) => [e.name, e.value]));
  checks.ok(
    'ingest: it checks the database certificate the way the API does',
    TLS.filter((n) => env.has(n)).length === 1 && TLS.every((n) => env.get(n) === apiEnv.get(n))
  );
  const foreign = [...env.keys()].filter((n) => /^(QCLOUD_API_|QCLOUD_PANEL_|QCLOUD_AWS_|QCLOUD_TRANSPORT|QCLOUD_FLEET_)/.test(n));
  checks.ok("ingest: none of the API's, the panel's or the transport's settings", foreign.length === 0, foreign.join(', '));
  checks.ok(
    'ingest: the database URL and the webhook key are secret references, and nothing else is',
    secrets.size === 2 && secrets.get('QCLOUD_DATABASE_URL') === fx.databaseSecret && secrets.get('QCLOUD_WEBHOOK_KEY') === fx.webhookKeySecret,
    json([...secrets])
  );
  checks.ok('ingest: ECS waits ten seconds past the shutdown grace before it kills a task', box.stopTimeout === 18, String(box.stopTimeout));

  // --- no AWS credential beyond starting up ---------------------------------------------------------------------
  checks.ok('ingest: no task role, so no queue and no AWS credential', get(after(def), 'task_role_arn') == null);
  checks.ok('ingest: it starts under its own execution role', rootReferences(plan, 'aws_ecs_task_definition.ingest', 'execution_role_arn').some((r) => r.startsWith('aws_iam_role.execution["ingest"]')));
  const roles = ofType(plan, 'aws_iam_role').map((r) => String(get(after(r), 'name'))).sort();
  checks.ok(
    'ingest: it adds one role, an execution role, to the four',
    json(roles) === json(['api-execution', 'api-task', 'ingest-execution', 'migrate-execution', 'panel-execution'].map((r) => `${fx.name}-${r}`)),
    roles.join(',')
  );
  const policy = ofType(plan, 'aws_iam_role_policy').find((c) => c.address === 'aws_iam_role_policy.execution["ingest"]');
  const parsed = policy === undefined ? undefined : policyOf(policy);
  const statements = parsed?.known === true ? parsed.statements : [];
  const sid = (id: string) => statements.find((s) => s.Sid === id);
  checks.ok('ingest: its execution role can be read whole', parsed?.known === true);
  checks.ok('ingest: it reads the database URL and the webhook key and no other secret', same(list(sid('ReadSecrets')?.Resource), [fx.databaseSecret, fx.webhookKeySecret]) && same(list(sid('ReadSecrets')?.Action), ['secretsmanager:GetSecretValue']));
  checks.ok('ingest: it writes its own log group and no other', same(list(sid('WriteLogs')?.Resource), [`arn:aws:logs:${fx.region}:${fx.account}:log-group:/qcloud/${fx.name}/ingest:*`]));
  checks.ok('ingest: it pulls from the named repositories only', same(list(sid('PullImage')?.Resource), repositories));
  checks.ok(
    'ingest: it decrypts through Secrets Manager only, and only when there is a key',
    secretsKey === undefined ? sid('DecryptSecrets') === undefined : same(list(sid('DecryptSecrets')?.Resource), [secretsKey]) && get(sid('DecryptSecrets'), 'Condition', 'StringEquals', 'kms:ViaService') === `secretsmanager.${fx.region}.amazonaws.com`
  );
  checks.ok('ingest: nothing in its policy touches a queue, a key of the queues or a metric', statements.every((s) => list(s.Action).every((a) => !/^(sqs|cloudwatch|iam|sts):/.test(a))));

  // --- the service ------------------------------------------------------------------------------------------------
  const service = find(plan, 'aws_ecs_service', 'ingest');
  const a = service === undefined ? undefined : after(service);
  checks.ok('ingest: two tasks on Fargate in the data plane\'s cluster, rolling with half serving', get(a, 'desired_count') === 2 && get(a, 'launch_type') === 'FARGATE' && get(a, 'cluster') === fx.cluster && get(a, 'deployment_minimum_healthy_percent') === 50 && get(a, 'deployment_maximum_percent') === 100);
  checks.ok('ingest: a failed deployment rolls back', get(a, 'deployment_circuit_breaker', 0, 'enable') === true && get(a, 'deployment_circuit_breaker', 0, 'rollback') === true);
  checks.ok('ingest: private subnets, the tasks group, no public address, no shell', json(get(a, 'network_configuration', 0, 'subnets')) === json([...fx.privateSubnets]) && json(get(a, 'network_configuration', 0, 'security_groups')) === json([fx.tasksGroup]) && get(a, 'network_configuration', 0, 'assign_public_ip') === false && get(a, 'enable_execute_command') === false);
  checks.ok('ingest: behind the load balancer on 8081', get(a, 'load_balancer', 0, 'container_name') === 'ingest' && get(a, 'load_balancer', 0, 'container_port') === 8081);
  checks.ok('ingest: the service rolls when the data plane says a secret changed', get(a, 'triggers', 'rollout') !== undefined);
  checks.ok('ingest: three services in all', ofType(plan, 'aws_ecs_service').length === 3);

  // --- the load balancer ----------------------------------------------------------------------------------------------
  const tg = find(plan, 'aws_lb_target_group', 'ingest');
  checks.ok('ingest: its target group sends to 8081 and checks /healthz, which touches nothing', get(after(tg as ResourceChange), 'port') === 8081 && get(after(tg as ResourceChange), 'health_check', 0, 'path') === '/healthz' && get(after(tg as ResourceChange), 'target_type') === 'ip');
  const rule = find(plan, 'aws_lb_listener_rule', 'ingest');
  const x = rule === undefined ? undefined : after(rule);
  const conditions = get(x, 'condition');
  const hostOnly = Array.isArray(conditions) && conditions.some((c) => json(get(c, 'host_header', 0, 'values')) === json([INGEST_HOST]));
  const pathOnly = Array.isArray(conditions) && conditions.some((c) => json(get(c, 'path_pattern', 0, 'values')) === json(['/s/*']));
  checks.ok('ingest: its rule matches its host name and `/s/*` and nothing else', Array.isArray(conditions) && conditions.length === 2 && hostOnly && pathOnly, json(conditions));
  checks.ok('ingest: its rule only forwards, at priority 30', get(x, 'priority') === 30 && Array.isArray(get(x, 'action')) && (get(x, 'action') as unknown[]).length === 1 && get(x, 'action', 0, 'type') === 'forward');
  checks.ok('ingest: three rules in all, and the default is still the 404', ofType(plan, 'aws_lb_listener_rule').length === 3 && get(after(find(plan, 'aws_lb_listener', 'https') as ResourceChange), 'default_action', 0, 'fixed_response', 0, 'status_code') === '404');

  // --- the security groups: 8081 from the load balancer, to the tasks, and nowhere else ---------------------------
  const inbound = find(plan, 'aws_vpc_security_group_ingress_rule', 'tasks_from_alb_ingest');
  checks.ok('ingest: the tasks group gains 8081 from the load balancer group only', inbound !== undefined && get(after(inbound), 'security_group_id') === fx.tasksGroup && get(after(inbound), 'from_port') === 8081 && get(after(inbound), 'to_port') === 8081 && get(after(inbound), 'cidr_ipv4') == null && rootReferences(plan, 'aws_vpc_security_group_ingress_rule.tasks_from_alb_ingest', 'referenced_security_group_id').includes('aws_security_group.alb.id'));
  const outbound = find(plan, 'aws_vpc_security_group_egress_rule', 'to_ingest');
  checks.ok('ingest: the load balancer may open 8081 to the tasks group and nowhere else', outbound !== undefined && get(after(outbound), 'referenced_security_group_id') === fx.tasksGroup && get(after(outbound), 'from_port') === 8081 && get(after(outbound), 'cidr_ipv4') == null && ofType(plan, 'aws_vpc_security_group_egress_rule').length === 2);

  // --- the budget and the outputs ----------------------------------------------------------------------------------------
  checks.ok('ingest: its connections are counted', get(plan.output_changes.connection_budget, 'after', 'ingest_connections') === 4 && get(plan.output_changes.connection_budget, 'after', 'api_connections') === 4);
  checks.ok('ingest: its URL is output', get(plan.output_changes.ingest_url, 'after') === `https://${INGEST_HOST}`);
  checks.ok('ingest: its service and execution role are output', get(plan.output_changes.services, 'after', 'ingest') === `${fx.name}-ingest`);
}

/** With an ingest and the WAF: the ingest's host has its own rule and the first rule stops counting it. */
function checkAwsIngestEdge(plan: Plan, checks: Checks, limit: number, ingestLimit: number): void {
  const acl = ofType(plan, 'aws_wafv2_web_acl')[0];
  const rules = get(acl === undefined ? undefined : after(acl), 'rule');
  const [first, second] = Array.isArray(rules) ? rules : [];
  checks.ok('ingest edge: two rules, 10 and 20', Array.isArray(rules) && rules.length === 2 && get(first, 'priority') === 10 && get(second, 'priority') === 20, json(rules));
  const own = get(first, 'statement', 0, 'rate_based_statement', 0);
  const ingest = get(second, 'statement', 0, 'rate_based_statement', 0);
  const match = (statement: unknown) => get(statement, 'byte_match_statement', 0);
  const skip = match(get(own, 'scope_down_statement', 0, 'not_statement', 0, 'statement', 0));
  const only = match(get(ingest, 'scope_down_statement', 0));
  checks.ok('ingest edge: the first rule keeps its limit and skips the ingest host', get(own, 'limit') === limit && get(skip, 'search_string') === INGEST_HOST && get(skip, 'positional_constraint') === 'STARTS_WITH', json(own));
  checks.ok('ingest edge: the second rule counts the ingest host only, at its own limit', get(ingest, 'limit') === ingestLimit && get(only, 'search_string') === INGEST_HOST && get(only, 'positional_constraint') === 'STARTS_WITH' && get(ingest, 'aggregate_key_type') === 'IP' && get(ingest, 'evaluation_window_sec') === 60, json(ingest));
  checks.ok('ingest edge: both match the host header, lower-cased', [skip, only].every((m) => get(m, 'field_to_match', 0, 'single_header', 0, 'name') === 'host' && get(m, 'text_transformation', 0, 'type') === 'LOWERCASE'));
  const block = get(second, 'action', 0, 'block', 0, 'custom_response', 0);
  checks.ok('ingest edge: over its limit it answers 429 with Retry-After', get(block, 'response_code') === 429 && get(block, 'response_header', 0, 'name') === 'Retry-After');
  checks.ok('ingest edge: the metric names differ', get(first, 'visibility_config', 0, 'metric_name') !== get(second, 'visibility_config', 0, 'metric_name'));
}
