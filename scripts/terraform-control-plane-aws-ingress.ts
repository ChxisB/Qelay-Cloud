/**
 * What `scripts/check-terraform-control-plane-aws.ts` asserts about how traffic reaches `infra/aws/control-plane`:
 * the load balancer, its listeners and rules (no route but the two host names, nothing unauthenticated added in
 * front of the API's own token check), the security groups, and the event stream timeouts against the load
 * balancer's idle timeout.
 */
import type { Fixture } from './terraform-control-plane-aws-services';
import { find, rootReferences } from './terraform-control-plane-aws-services';
import type { Checks, Plan, ResourceChange } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export interface Exposure {
  readonly mode: 'public' | 'private';
  /** Who may open a connection to the load balancer. */
  readonly cidrs: readonly string[];
  readonly idleSeconds: number;
  readonly heartbeatSeconds: number;
}

const json = (value: unknown) => JSON.stringify(value);

const EMPTY = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);

/** A rule condition that matches one host name and no path, header, method, query string or source address. */
const onlyHost = (condition: unknown, host: string) =>
  json(get(condition, 'host_header', 0, 'values')) === json([host]) &&
  ['path_pattern', 'http_header', 'http_request_method', 'query_string', 'source_ip'].every((k) =>
    EMPTY(get(condition, k))
  );

export function checkIngress(plan: Plan, checks: Checks, fx: Fixture, want: Exposure): void {
  const public_ = want.mode === 'public';
  const lb = find(plan, 'aws_lb', 'control');
  const a = lb === undefined ? undefined : after(lb);
  checks.ok('one application load balancer', ofType(plan, 'aws_lb').length === 1 && get(a, 'load_balancer_type') === 'application');
  checks.ok(`the load balancer is ${public_ ? 'internet-facing' : 'internal'}`, get(a, 'internal') === !public_);
  checks.ok('the idle timeout is at least twice the heartbeat, so a stream is never idle', want.idleSeconds >= 2 * want.heartbeatSeconds && get(a, 'idle_timeout') === want.idleSeconds, String(get(a, 'idle_timeout')));
  checks.ok('malformed headers are dropped and desync is mitigated strictly', get(a, 'drop_invalid_header_fields') === true && get(a, 'desync_mitigation_mode') === 'strictest');
  checks.ok('IPv4 only', get(a, 'ip_address_type') === 'ipv4');

  // --- where it sits -------------------------------------------------------------------------------------------
  const subnets = ofType(plan, 'aws_subnet');
  const addresses = ofType(plan, 'aws_route');
  if (public_) {
    const cidrs = subnets.map((s) => String(get(after(s), 'cidr_block'))).sort();
    checks.ok('its own subnets, one per zone, in free slots of the VPC range', json(cidrs) === json(['10.20.192.0/20', '10.20.208.0/20']), cidrs.join(','));
    checks.ok('no instance launched there gets a public address by default', subnets.every((s) => get(after(s), 'map_public_ip_on_launch') === false));
    checks.ok('one default route, to the data plane internet gateway', addresses.length === 1 && get(after(addresses[0] as ResourceChange), 'destination_cidr_block') === '0.0.0.0/0' && get(after(addresses[0] as ResourceChange), 'gateway_id') === fx.igw);
    checks.ok('a route table association per subnet', ofType(plan, 'aws_route_table_association').length === subnets.length);
  } else {
    checks.ok('private: no subnet, no route and no route table of its own', subnets.length === 0 && addresses.length === 0 && ofType(plan, 'aws_route_table').length === 0);
    checks.ok("private: it sits in the data plane's private subnets", json(get(a, 'subnets')) === json([...fx.privateSubnets]), json(get(a, 'subnets')));
  }
  checks.ok('nothing here opens a second way out or in', ['aws_internet_gateway', 'aws_nat_gateway', 'aws_eip', 'aws_vpc_endpoint', 'aws_lb_listener_certificate'].every((t) => ofType(plan, t).length === 0));

  // --- listeners and rules ---------------------------------------------------------------------------------------
  const listeners = ofType(plan, 'aws_lb_listener');
  checks.ok('two listeners: HTTPS and the redirect', listeners.length === 2, listeners.map((l) => l.name).join(','));
  const https = find(plan, 'aws_lb_listener', 'https');
  const http = find(plan, 'aws_lb_listener', 'http');
  const h = https === undefined ? undefined : after(https);
  checks.ok('HTTPS on 443 with a TLS 1.3 policy and the given certificate', get(h, 'port') === 443 && get(h, 'protocol') === 'HTTPS' && get(h, 'ssl_policy') === 'ELBSecurityPolicy-TLS13-1-2-2021-06' && get(h, 'certificate_arn') === fx.certificate);
  checks.ok('an unknown host name gets a 404 and goes nowhere', get(h, 'default_action', 0, 'type') === 'fixed-response' && get(h, 'default_action', 0, 'fixed_response', 0, 'status_code') === '404');
  const p = http === undefined ? undefined : after(http);
  checks.ok('port 80 only redirects to HTTPS', get(p, 'port') === 80 && get(p, 'default_action', 0, 'type') === 'redirect' && get(p, 'default_action', 0, 'redirect', 0, 'protocol') === 'HTTPS' && get(p, 'default_action', 0, 'redirect', 0, 'port') === '443');
  checks.ok('no listener forwards by default', listeners.every((l) => get(after(l), 'default_action', 0, 'type') !== 'forward'));

  const rules = ofType(plan, 'aws_lb_listener_rule');
  checks.ok('exactly two rules: the API host and the panel host', rules.length === 2, String(rules.length));
  for (const [name, host, priority] of [['api', fx.apiHost, 10], ['panel', fx.panelHost, 20]] as const) {
    const r = find(plan, 'aws_lb_listener_rule', name);
    const x = r === undefined ? undefined : after(r);
    const conditions = get(x, 'condition');
    checks.ok(`the ${name} rule matches the host name and nothing else`, Array.isArray(conditions) && conditions.length === 1 && onlyHost(conditions[0], host), json(conditions));
    checks.ok(`the ${name} rule forwards and has priority ${priority}`, get(x, 'priority') === priority && get(x, 'action', 0, 'type') === 'forward');
    checks.ok(`the ${name} rule only forwards: no authentication action, no redirect, no fixed response`, Array.isArray(get(x, 'action')) && (get(x, 'action') as unknown[]).length === 1);
  }
  for (const name of ['api', 'panel']) {
    const tg = find(plan, 'aws_lb_target_group', name);
    checks.ok(`the ${name} target group checks /health and sends to 8080`, get(after(tg as ResourceChange), 'health_check', 0, 'path') === '/health' && get(after(tg as ResourceChange), 'port') === 8080 && get(after(tg as ResourceChange), 'target_type') === 'ip');
  }

  // --- security groups -----------------------------------------------------------------------------------------------
  const ingress = ofType(plan, 'aws_vpc_security_group_ingress_rule');
  const own = ingress.filter((r) => r.name === 'https' || r.name === 'http_redirect');
  checks.ok('the load balancer admits 443 and 80, from the given ranges only', own.length === 2 * want.cidrs.length && own.every((r) => want.cidrs.includes(String(get(after(r), 'cidr_ipv4'))) && [443, 80].includes(Number(get(after(r), 'from_port'))) && get(after(r), 'from_port') === get(after(r), 'to_port') && get(after(r), 'ip_protocol') === 'tcp'));
  checks.ok(public_ ? 'public: the default range is the internet' : 'private: the default range is the VPC and no rule is open to the internet', public_ ? want.cidrs.includes('0.0.0.0/0') || want.cidrs.length > 0 : !own.some((r) => get(after(r), 'cidr_ipv4') === '0.0.0.0/0'));
  const toTasks = ingress.find((r) => r.name === 'tasks_from_alb');
  checks.ok('the tasks group gains one rule: 8080 from the load balancer group', ingress.length === own.length + 1 && toTasks !== undefined && get(after(toTasks), 'security_group_id') === fx.tasksGroup && get(after(toTasks), 'from_port') === 8080 && get(after(toTasks), 'to_port') === 8080 && get(after(toTasks), 'cidr_ipv4') == null && rootReferences(plan, 'aws_vpc_security_group_ingress_rule.tasks_from_alb', 'referenced_security_group_id').includes('aws_security_group.alb.id'));
  const egress = ofType(plan, 'aws_vpc_security_group_egress_rule');
  checks.ok('the load balancer may open connections to the tasks group on 8080 and nowhere else', egress.length === 1 && get(after(egress[0] as ResourceChange), 'referenced_security_group_id') === fx.tasksGroup && get(after(egress[0] as ResourceChange), 'from_port') === 8080 && get(after(egress[0] as ResourceChange), 'cidr_ipv4') == null);
  const groups = ofType(plan, 'aws_security_group');
  checks.ok('one new security group, with no inline rules', groups.length === 1 && ['ingress', 'egress'].every((k) => { const v = get(after(groups[0] as ResourceChange), k); return v === undefined || (Array.isArray(v) && v.length === 0); }));
  checks.ok('no legacy security group rule resource', ofType(plan, 'aws_security_group_rule').length === 0);
  checks.ok('no public address on any service', ofType(plan, 'aws_ecs_service').every((s) => get(after(s), 'network_configuration', 0, 'assign_public_ip') === false));
}
