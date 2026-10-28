/**
 * What `scripts/check-terraform-control-plane.ts` asserts about the opt-in `ingest` of `infra/gcp/control-plane`
 * (inbound sources, task 09): a Cloud Run service of its own, open to the internet and checking nothing at the door
 * but `/healthz`, that reads the database secrets and holds no Pub/Sub role, and that the connection budget counts.
 */
import type { Fixture } from './terraform-control-plane-assertions';
import { envOf } from './terraform-control-plane-assertions';
import type { Checks, Plan } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

const INGEST_ACCOUNT = 'google_service_account.ingest';

export function checkIngest(plan: Plan, checks: Checks, fx: Fixture, image: string): void {
  const service = ofType(plan, 'google_cloud_run_v2_service').find((s) => s.name === 'ingest');
  checks.ok('ingest: its own Cloud Run service is planned', service !== undefined);
  if (service === undefined) return;
  const container = get(after(service), 'template', 0, 'containers', 0);
  const env = envOf(service, 'service');

  checks.ok('ingest: it takes traffic from the internet by default', get(after(service), 'ingress') === 'INGRESS_TRAFFIC_ALL');
  checks.ok(
    'ingest: it answers to its own service account',
    String(get(after(service), 'template', 0, 'service_account')).startsWith(`${fx.name}-ingest@`)
  );
  checks.ok('ingest: the image is the one given', get(container, 'image') === image);
  checks.ok('ingest: it listens on 8081', get(container, 'ports', 0, 'container_port') === 8081);
  for (const probe of ['startup_probe', 'liveness_probe']) {
    checks.ok(`ingest: ${probe} on /healthz`, get(container, probe, 0, 'http_get', 0, 'path') === '/healthz');
  }

  checks.ok('ingest: the database URL is a secret reference', env.get('QCLOUD_DATABASE_URL')?.secret !== undefined && env.get('QCLOUD_DATABASE_URL')?.value === undefined);
  checks.ok('ingest: the webhook key is a secret reference', env.get('QCLOUD_WEBHOOK_KEY')?.secret !== undefined);
  checks.ok('ingest: it is told its namespace and pool', env.get('QCLOUD_NAMESPACE')?.value === fx.namespace && env.get('QCLOUD_DATABASE_POOL_SIZE')?.value === '2');
  const leaked = [...env.entries()].filter(([, e]) => /:\/\/[^/]*:[^/@]*@/.test(e.value ?? ''));
  checks.ok('ingest: no credential in its environment values', leaked.length === 0, leaked.map(([n]) => n).join(', '));
  const secretish = [...env.keys()].filter((n) => /(SECRET|PASSWORD|TOKEN)/.test(n) && env.get(n)?.secret === undefined);
  checks.ok('ingest: no secret-looking plain setting', secretish.length === 0, secretish.join(', '));
  // It is not the API: no sign-in settings, no queue, no event streams.
  const foreign = [...env.keys()].filter((n) => /^(QCLOUD_API_|QCLOUD_TRANSPORT|QCLOUD_GCP_|QCLOUD_FLEET_)/.test(n));
  checks.ok('ingest: none of the API\'s or the transport\'s settings', foreign.length === 0, foreign.join(', '));

  // The three services are invokable by all, as nothing but invoker.
  const invokers = ofType(plan, 'google_cloud_run_v2_service_iam_member').map((c) => after(c));
  checks.ok(
    'ingest: the API, the panel and the ingest are invokable by all, as nothing but invoker',
    invokers.length === 3 && invokers.every((m) => get(m, 'member') === 'allUsers' && get(m, 'role') === 'roles/run.invoker')
  );

  // No Pub/Sub role for it, and nothing beyond reading its secrets: every grant that names its account is a secret accessor.
  const named = (plan.configuration.root_module.resources ?? []).filter((c) => {
    const refs = get(c.expressions, 'member', 'references');
    return Array.isArray(refs) && refs.some((r) => String(r).startsWith(INGEST_ACCOUNT));
  });
  const grants = named.filter((c) => c.address.includes('_iam_'));
  checks.ok(
    'ingest: every grant to its account is a secret accessor',
    grants.length > 0 && grants.every((c) => c.address.startsWith('google_secret_manager_secret_iam_member.') && get(c.expressions, 'role', 'constant_value') === 'roles/secretmanager.secretAccessor'),
    grants.map((c) => c.address).join(', ')
  );
  checks.ok(
    'ingest: no Pub/Sub or project-level role names its account',
    named.every((c) => !c.address.startsWith('google_pubsub_') && !c.address.startsWith('google_project_iam'))
  );
  checks.ok(
    'ingest: the Pub/Sub grants are the API\'s alone',
    ofType(plan, 'google_pubsub_topic_iam_member').length === 1 + fx.hotQueues.length &&
      ofType(plan, 'google_pubsub_subscription_iam_member').length === fx.queues.length
  );
  const secrets = ofType(plan, 'google_secret_manager_secret_iam_member');
  checks.ok('ingest: it reads the same three secrets as the API and nothing more', secrets.length === 5 + 3, String(secrets.length));

  const url = get(plan.output_changes.ingest_url, 'after');
  checks.ok('ingest: its URL is output', typeof url === 'string' || get(plan.output_changes.ingest_url, 'after_unknown') === true);
}

/** The ingest behind the load balancer: its own host name, certificate entry, policy and rate. */
export function checkIngestEdge(plan: Plan, checks: Checks, want: { ingestHost: string; limit: number }): void {
  const service = ofType(plan, 'google_cloud_run_v2_service').find((s) => s.name === 'ingest');
  checks.ok(
    'ingest edge: the listener takes traffic from the load balancer only',
    get(service === undefined ? undefined : after(service), 'ingress') === 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER'
  );
  const policy = ofType(plan, 'google_compute_security_policy').find((p) => p.name === 'ingest');
  const rules = get(policy === undefined ? undefined : after(policy), 'rule');
  const rule = Array.isArray(rules) ? rules.find((r) => get(r, 'priority') === 1000) : undefined;
  const options = get(rule, 'rate_limit_options', 0);
  checks.ok(
    'ingest edge: its own policy, 429 over the limit per address in a minute',
    get(rule, 'action') === 'throttle' &&
      get(options, 'enforce_on_key') === 'IP' &&
      get(options, 'exceed_action') === 'deny(429)' &&
      get(options, 'rate_limit_threshold', 0, 'count') === want.limit &&
      get(options, 'rate_limit_threshold', 0, 'interval_sec') === 60,
    JSON.stringify(options)
  );
  const backend = ofType(plan, 'google_compute_backend_service').find((b) => b.name === 'ingest');
  const found = plan.configuration.root_module.resources?.find((c) => c.address === 'google_compute_backend_service.ingest');
  const refs = get(found?.expressions, 'security_policy', 'references');
  checks.ok(
    'ingest edge: its backend is behind its own policy, not the panel\'s',
    backend !== undefined && Array.isArray(refs) && refs.map(String).includes('google_compute_security_policy.ingest')
  );
  const certificate = ofType(plan, 'google_compute_managed_ssl_certificate')[0];
  const domains = get(certificate === undefined ? undefined : after(certificate), 'managed', 0, 'domains');
  checks.ok('ingest edge: the certificate covers its host name', Array.isArray(domains) && domains.includes(want.ingestHost), JSON.stringify(domains));
  checks.ok(
    'ingest edge: the listener is named by its host name',
    get(plan.output_changes.ingest_url, 'after') === `https://${want.ingestHost}`,
    String(get(plan.output_changes.ingest_url, 'after'))
  );
}
