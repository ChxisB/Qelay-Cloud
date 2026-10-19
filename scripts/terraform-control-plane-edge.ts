/**
 * What `scripts/check-terraform-control-plane.ts` asserts about the opt-in `edge` of `infra/gcp/control-plane`: the
 * Cloud Run services take traffic from the load balancer only, Cloud Armor's rate rule is on both backend services,
 * and the services are named by the host names the certificate covers.
 */
import type { Checks, Plan } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export interface Edge {
  readonly apiHost: string;
  readonly panelHost: string;
  readonly limit: number;
  /** The API's request timeout in seconds, which the load balancer's backend timeout must match. */
  readonly apiTimeout: number;
}

const references = (plan: Plan, address: string, key: string) => {
  const found = plan.configuration.root_module.resources?.find((c) => c.address === address);
  const list = get(found?.expressions, key, 'references');
  return Array.isArray(list) ? list.map(String) : [];
};

export function checkEdge(plan: Plan, checks: Checks, want: Edge): void {
  const services = ofType(plan, 'google_cloud_run_v2_service');
  checks.ok(
    'edge: both Cloud Run services take traffic from the load balancer only',
    services.length === 2 && services.every((s) => get(after(s), 'ingress') === 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER')
  );

  const policies = ofType(plan, 'google_compute_security_policy');
  const rules = get(policies[0] === undefined ? undefined : after(policies[0]), 'rule');
  const rule = Array.isArray(rules) ? rules.find((r) => get(r, 'priority') === 1000) : undefined;
  const options = get(rule, 'rate_limit_options', 0);
  checks.ok(
    'edge: one policy, one rate rule per address over a minute, 429 over the limit',
    policies.length === 1 &&
      get(rule, 'action') === 'throttle' &&
      get(options, 'enforce_on_key') === 'IP' &&
      get(options, 'exceed_action') === 'deny(429)' &&
      get(options, 'conform_action') === 'allow' &&
      get(options, 'rate_limit_threshold', 0, 'count') === want.limit &&
      get(options, 'rate_limit_threshold', 0, 'interval_sec') === 60,
    JSON.stringify(options)
  );
  checks.ok(
    'edge: everything else is allowed by the default rule',
    Array.isArray(rules) && rules.some((r) => get(r, 'priority') === 2147483647 && get(r, 'action') === 'allow')
  );

  for (const [name, timeout] of [['api', want.apiTimeout], ['panel', 60]] as const) {
    const backend = ofType(plan, 'google_compute_backend_service').find((b) => b.name === name);
    checks.ok(
      `edge: the ${name} backend is a managed external one behind the policy, with a timeout of ${timeout} s`,
      backend !== undefined &&
        get(after(backend), 'load_balancing_scheme') === 'EXTERNAL_MANAGED' &&
        get(after(backend), 'timeout_sec') === timeout &&
        references(plan, `google_compute_backend_service.${name}`, 'security_policy').includes('google_compute_security_policy.edge')
    );
  }
  const certificates = ofType(plan, 'google_compute_managed_ssl_certificate');
  checks.ok(
    'edge: one certificate for the two host names, and nothing listens on port 80',
    certificates.length === 1 &&
      JSON.stringify(get(after(certificates[0]!), 'managed', 0, 'domains')) === JSON.stringify([want.apiHost, want.panelHost].sort()) &&
      ofType(plan, 'google_compute_global_forwarding_rule').every((f) => get(after(f), 'port_range') === '443')
  );
  const urls = plan.output_changes.api_url;
  checks.ok('edge: the API is named by its host name', get(urls, 'after') === `https://${want.apiHost}`, String(get(urls, 'after')));
  checks.ok('edge: the panel is named by its host name', get(plan.output_changes.panel_url, 'after') === `https://${want.panelHost}`);
}
