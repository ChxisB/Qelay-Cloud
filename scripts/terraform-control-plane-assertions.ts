/**
 * What `scripts/check-terraform-control-plane.ts` asserts about a plan of `infra/gcp/control-plane`: the
 * acceptance lines of task 36 (no unauthenticated route but `/health`, non-secret environment only, event
 * stream timeouts that outlast a stream) and the places where the Terraform must agree with the code.
 */
import { queueNames } from '../packages/transport-gcp/src/names';
import type { Checks, Plan, ResourceChange } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export interface Fixture {
  readonly name: string;
  readonly projectNumber: string;
  readonly region: string;
  readonly namespace: string;
  readonly queues: readonly string[];
}

function find(plan: Plan, type: string, name: string): ResourceChange | undefined {
  return plan.resource_changes.find((c) => c.type === type && c.name === name);
}

interface EnvEntry {
  readonly value?: string;
  readonly secret?: string;
}

/** A container's environment: plain values and secret references, kept apart. */
export function envOf(service: ResourceChange | undefined, template: 'service' | 'job') {
  const container =
    template === 'service'
      ? get(after(service as ResourceChange), 'template', 0, 'containers', 0)
      : get(after(service as ResourceChange), 'template', 0, 'template', 0, 'containers', 0);
  const list = get(container, 'env');
  const out = new Map<string, EnvEntry>();
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const secret = get(entry, 'value_source', 0, 'secret_key_ref', 0, 'secret');
    const value = get(entry, 'value');
    out.set(String(get(entry, 'name')), {
      ...(typeof value === 'string' && value !== '' ? { value } : {}),
      ...(typeof secret === 'string' ? { secret } : {}),
    });
  }
  return out;
}

export function checkServices(plan: Plan, checks: Checks, fx: Fixture): void {
  const api = find(plan, 'google_cloud_run_v2_service', 'api');
  const panel = find(plan, 'google_cloud_run_v2_service', 'panel');
  checks.ok('the API service is planned', api !== undefined);
  checks.ok('the panel service is planned', panel !== undefined);
  if (api === undefined || panel === undefined) return;
  const url = (service: string) =>
    `https://${fx.name}-${service}-${fx.projectNumber}.${fx.region}.run.app`;
  const apiEnv = envOf(api, 'service');
  const panelEnv = envOf(panel, 'service');

  // Exposure: public by default, and every request is checked by the application.
  checks.ok('the API takes traffic from the internet by default', get(after(api), 'ingress') === 'INGRESS_TRAFFIC_ALL');
  checks.ok('the API answers to its own service account', String(get(after(api), 'template', 0, 'service_account')).startsWith(`${fx.name}-api@`));
  checks.ok('the panel answers to its own service account', String(get(after(panel), 'template', 0, 'service_account')).startsWith(`${fx.name}-panel@`));

  // The API's sign-in is configured, and nothing that turns it off is.
  for (const name of [
    'QCLOUD_API_OIDC_ISSUER',
    'QCLOUD_API_OIDC_AUDIENCE',
    'QCLOUD_API_OIDC_JWKS_URL',
    'QCLOUD_API_CORS_ORIGINS',
  ]) {
    checks.ok(`the API is given ${name}`, apiEnv.get(name)?.value !== undefined);
  }
  checks.ok(
    'no development token in the API',
    ![...apiEnv.keys()].some((name) => name.startsWith('QCLOUD_API_DEV_TOKEN'))
  );
  checks.ok(
    "the API's only cross-origin caller is the panel",
    apiEnv.get('QCLOUD_API_CORS_ORIGINS')?.value === url('panel'),
    apiEnv.get('QCLOUD_API_CORS_ORIGINS')?.value
  );
  checks.ok(
    "the panel is configured with the API's URL",
    panelEnv.get('QCLOUD_PANEL_API_BASE_URL')?.value === url('api')
  );
  checks.ok('the panel signs in with OIDC', panelEnv.get('QCLOUD_PANEL_AUTH_MODE')?.value === 'oidc');

  // A credential is a secret reference, never a value in the plan.
  const url_ = apiEnv.get('QCLOUD_DATABASE_URL');
  checks.ok('the database URL is a secret reference', url_?.secret !== undefined && url_.value === undefined);
  for (const [service, env] of [['API', apiEnv], ['panel', panelEnv]] as const) {
    const leaked = [...env.entries()].filter(([, e]) => /:\/\/[^/]*:[^/@]*@/.test(e.value ?? ''));
    checks.ok(`no credential in the ${service}'s environment values`, leaked.length === 0, leaked.map(([n]) => n).join(', '));
    const secretish = [...env.keys()].filter((n) => /(SECRET|PASSWORD|TOKEN)/.test(n) && env.get(n)?.secret === undefined);
    checks.ok(`no secret-looking plain setting in the ${service}`, secretish.length === 0, secretish.join(', '));
  }

  // Probes use the one route without a token.
  for (const [service, resource] of [['API', api], ['panel', panel]] as const) {
    const container = get(after(resource), 'template', 0, 'containers', 0);
    checks.ok(`${service}: startup probe on /health`, get(container, 'startup_probe', 0, 'http_get', 0, 'path') === '/health');
    checks.ok(`${service}: liveness probe on /health`, get(container, 'liveness_probe', 0, 'http_get', 0, 'path') === '/health');
  }

  // The event stream's numbers: heartbeat 15 s, a stream closes at 600 s, the platform allows more.
  const timeout = Number(String(get(after(api), 'template', 0, 'timeout')).replace('s', ''));
  const lifetime = Number(apiEnv.get('QCLOUD_API_EVENTS_MAX_LIFETIME_MS')?.value);
  const heartbeat = Number(apiEnv.get('QCLOUD_API_EVENTS_HEARTBEAT_MS')?.value);
  const concurrency = Number(get(after(api), 'template', 0, 'max_instance_request_concurrency'));
  const streams = Number(apiEnv.get('QCLOUD_API_EVENTS_MAX_STREAMS')?.value);
  checks.ok('the request timeout is at least 600 s and at most 3600 s', timeout >= 600 && timeout <= 3600, String(timeout));
  checks.ok('a stream closes a minute or more before the request timeout', lifetime + 60_000 <= timeout * 1000, `${lifetime} vs ${timeout}`);
  checks.ok('the heartbeat is 15 s', heartbeat === 15_000, String(heartbeat));
  checks.ok('streams leave request slots for ordinary requests', streams < concurrency, `${streams} vs ${concurrency}`);
  checks.ok('one instance is kept warm', get(after(api), 'template', 0, 'scaling', 0, 'min_instance_count') === 1);
}

export function checkMigration(plan: Plan, checks: Checks): void {
  const job = find(plan, 'google_cloud_run_v2_job', 'migrate');
  checks.ok('the migration is a Cloud Run job', job !== undefined);
  if (job === undefined) return;
  const container = get(after(job), 'template', 0, 'template', 0, 'containers', 0);
  const args = get(container, 'args');
  checks.ok('the job runs `migrate`', Array.isArray(args) && args.join(' ') === 'migrate');
  checks.ok('the job is not retried', get(after(job), 'template', 0, 'template', 0, 'max_retries') === 0);
  checks.ok(
    'the job has its own service account',
    String(get(after(job), 'template', 0, 'template', 0, 'service_account')).includes('-migrate@')
  );
  const env = envOf(job, 'job');
  checks.ok('the job reads the database URL from a secret', env.get('QCLOUD_DATABASE_URL')?.secret !== undefined);
  const services = ofType(plan, 'google_cloud_run_v2_service');
  checks.ok(
    'no serving instance migrates at start: no service runs `migrate`',
    services.every((s) => {
      const args = get(after(s), 'template', 0, 'containers', 0, 'args');
      return !(Array.isArray(args) && args.includes('migrate'));
    })
  );
}

export function checkIdentities(plan: Plan, checks: Checks, fx: Fixture): void {
  const members = (type: string) => ofType(plan, type).map((c) => after(c));
  const invokers = members('google_cloud_run_v2_service_iam_member');
  checks.ok(
    'exactly the API and the panel are invokable by all, and as nothing but invoker',
    invokers.length === 2 &&
      invokers.every((m) => get(m, 'member') === 'allUsers' && get(m, 'role') === 'roles/run.invoker')
  );
  const everything = plan.resource_changes.filter((c) => /_iam_(member|binding|policy)$/.test(c.type));
  for (const binding of everything) {
    const role = String(get(after(binding), 'role'));
    const known = new Set([
      'roles/pubsub.publisher',
      'roles/pubsub.subscriber',
      'roles/secretmanager.secretAccessor',
      'roles/run.invoker',
      'roles/iam.serviceAccountUser',
    ]);
    // The custom role's name is known only after apply, so the project binding is checked by its type.
    checks.ok(
      `${binding.address} grants an allowed role`,
      known.has(role) || binding.type === 'google_project_iam_member',
      role
    );
  }
  const project = ofType(plan, 'google_project_iam_member');
  checks.ok('at most one project-level binding', project.length <= 1);
  const roles = ofType(plan, 'google_project_iam_custom_role');
  checks.ok(
    'the only custom role holds the single permission it needs',
    roles.length === 1 &&
      JSON.stringify(get(after(roles[0] as ResourceChange), 'permissions')) ===
        JSON.stringify(['monitoring.timeSeries.list'])
  );
  const publishers = members('google_pubsub_topic_iam_member');
  checks.ok('the API publishes to the bells topic and nothing else', publishers.length === 1 && get(publishers[0], 'role') === 'roles/pubsub.publisher');
  // It may peek at the dead-letter subscription of each queue, by the names the transport computes.
  const expected = fx.queues.map((q) => queueNames(fx.namespace, q).deadLetterSubscription).sort();
  const peeked = members('google_pubsub_subscription_iam_member')
    .map((m) => String(get(m, 'subscription')))
    .sort();
  checks.ok('the API peeks only at dead-letter subscriptions', JSON.stringify(peeked) === JSON.stringify(expected), `${peeked} vs ${expected}`);
  checks.ok(
    'no role on any main subscription',
    members('google_pubsub_subscription_iam_member').every((m) => get(m, 'role') === 'roles/pubsub.subscriber')
  );
  const secrets = ofType(plan, 'google_secret_manager_secret_iam_member');
  checks.ok('the API and the migration read the secrets they use and nothing else', secrets.length === 4, String(secrets.length));
}
