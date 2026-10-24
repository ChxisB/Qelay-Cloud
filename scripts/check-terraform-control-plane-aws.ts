/**
 * Plans `infra/aws/control-plane` without credentials and checks the plan against task 43's acceptance: it
 * validates, plans cleanly, leaves no route open but the two host names (the API's own token check guards every route
 * but `/health`), keeps credentials out of the plan, gives the API exactly the queue access the code uses, keeps the
 * event stream timeouts consistent, and agrees with the data plane (`infra/aws/example`) on every value it takes from it.
 *
 *   bun run check:terraform
 *
 * Hermetic like `check-terraform-plan-aws.ts`: every AWS_* variable is dropped, the instance metadata service is
 * switched off, and `offline_plan` makes the provider take a placeholder key and make no call to AWS. Needs `terraform`
 * 1.5 or later; without it the check is skipped with a warning, unless QCLOUD_REQUIRE_TERRAFORM=1 (CI sets it).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkAwsApiAlarm } from './terraform-control-plane-alerts';
import { checkEdgeRateLimit, checkIngress } from './terraform-control-plane-aws-ingress';
import { checkIdentities } from './terraform-control-plane-aws-iam';
import { checkAwsIngestPlans } from './terraform-control-plane-aws-ingest';
import type { Fixture, Variation } from './terraform-control-plane-aws-services';
import { checkEcsServices, checkServices } from './terraform-control-plane-aws-services';
import type { Plan } from './terraform-plan-model';
import { Checks, get, ofType } from './terraform-plan-model';

const ROOT = resolve(import.meta.dir, '..');
const CONTROL = join(ROOT, 'infra/aws/control-plane');
const EXAMPLE = join(ROOT, 'infra/aws/example');
const VARS = '-var-file=ci.tfvars.example';
const ACCOUNT = '123456789012';
const REGION = 'eu-west-2';
const KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
const KEY2 = `arn:aws:kms:${REGION}:${ACCOUNT}:key/11111111-1111-1111-1111-111111111111`;
const DIRECT = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:qcloud-ci/database-listen-url-GhIjKl`;
/** The heredoc in ci.tfvars.example, which Terraform strips of its indentation and ends with a newline. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nY2ktcGxhbi1ub3QtYS1yZWFsLWNlcnRpZmljYXRl\n-----END CERTIFICATE-----\n';
const CA_FILE = '/etc/ssl/certs/rds-global-bundle.pem';

const FIXTURE: Fixture = {
  account: ACCOUNT,
  region: REGION,
  name: 'qcloud-ci',
  namespace: 'ci',
  cluster: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/qcloud-ci`,
  tasksGroup: 'sg-0123456789abcdef0',
  privateSubnets: ['subnet-0aaaaaaaaaaaaaaa1', 'subnet-0bbbbbbbbbbbbbbb2'],
  vpcCidr: '10.20.0.0/16',
  igw: 'igw-0123456789abcdef0',
  queueArns: ['default', 'emails'].map((q) => `arn:aws:sqs:${REGION}:${ACCOUNT}:qcloud-ci__${q}`),
  deadLetterArns: ['default', 'emails'].map((q) => `arn:aws:sqs:${REGION}:${ACCOUNT}:qcloud-ci__${q}__dlq`),
  databaseSecret: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:qcloud-ci/database-url-AbCdEf`,
  webhookKeySecret: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:qcloud-ci/webhook-key-AbCdEf`,
  repositories: [`arn:aws:ecr:${REGION}:${ACCOUNT}:repository/qcloud-api`, `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/qcloud-panel`],
  apiImage: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/qcloud-api:ci`,
  panelImage: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/qcloud-panel:ci`,
  apiHost: 'api.qcloud-ci.example.com',
  panelHost: 'qelay.qcloud-ci.example.com',
  certificate: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/00000000-0000-0000-0000-000000000000`,
  issuer: 'https://idp.example.com/',
  audience: 'qcloud-ci-panel',
  jwks: 'https://idp.example.com/.well-known/jwks.json',
  clientId: 'qcloud-ci-panel',
};
const BASE: Variation = {
  apiInstances: 2,
  pooled: false,
  tls: { QCLOUD_DATABASE_TLS_CA: CA_PEM },
  migrateSecret: FIXTURE.databaseSecret,
  migratePooler: 'none',
};
const INTERNET = ['0.0.0.0/0'];
const EXPOSURE = { mode: 'public', cidrs: INTERNET, idleSeconds: 60, heartbeatSeconds: 15 } as const;
const IAM = { monitoring: true, ecr: true, migrateSecret: FIXTURE.databaseSecret, queueKey: KEY };

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_/.test(k))),
  AWS_EC2_METADATA_DISABLED: 'true',
  TF_IN_AUTOMATION: '1',
  TF_INPUT: '0',
};

function terraform(cwd: string, args: string[]) {
  const done = Bun.spawnSync(['terraform', ...args], { cwd, env });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

if (Bun.which('terraform') === null) {
  const message = 'terraform is not installed: the AWS control-plane plan check did not run';
  if (process.env.QCLOUD_REQUIRE_TERRAFORM === '1') throw new Error(message);
  console.warn(`WARNING: ${message}`);
  process.exit(0);
}

const checks = new Checks();
const scratch = mkdtempSync(join(tmpdir(), 'qcloud-tf-cp-aws-'));
try {
  const fmt = terraform(CONTROL, ['fmt', '-check', '-recursive', '-diff', '-no-color']);
  checks.ok('control plane: terraform fmt -check -recursive', fmt.code === 0, fmt.out);
  const init = terraform(CONTROL, ['init', '-backend=false', '-input=false', '-no-color']);
  checks.ok('control plane: terraform init -backend=false', init.code === 0, init.err);
  const validate = terraform(CONTROL, ['validate', '-no-color']);
  checks.ok('control plane: terraform validate', validate.code === 0, validate.err);
  checks.ok('control plane: the provider lock file is committed', readFileSync(join(CONTROL, '.terraform.lock.hcl'), 'utf8').includes('hashicorp/aws'));

  function plan(cwd: string, label: string, ...overrides: string[]) {
    const file = join(scratch, `${label}.tfplan`);
    // `-var name=null` would set the string "null" on a string variable: a null goes in a variable file, after the CI values.
    const nulls = overrides.filter((v) => v.endsWith('=null')).map((v) => v.slice(0, -'=null'.length));
    const nullFile = join(scratch, `${label}.null.tfvars`);
    writeFileSync(nullFile, nulls.map((name) => `${name} = null\n`).join(''));
    const vars = [
      ...(nulls.length === 0 ? [] : [`-var-file=${nullFile}`]),
      ...overrides.filter((v) => !v.endsWith('=null')).flatMap((v) => ['-var', v]),
    ];
    const planned = terraform(cwd, ['plan', '-lock=false', VARS, ...vars, `-out=${file}`, '-no-color']);
    if (planned.code !== 0) {
      // `-json` prints each diagnostic whole; the plain text wraps at 78 columns and breaks a message.
      const json = terraform(cwd, ['plan', '-lock=false', VARS, ...vars, '-json', '-no-color']);
      const diagnostics = json.out
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        })
        .filter((entry) => get(entry, 'type') === 'diagnostic')
        .map((entry) => `${get(entry, 'diagnostic', 'summary')}: ${get(entry, 'diagnostic', 'detail')}`);
      return { plan: null, diagnostics: diagnostics.join('\n') || planned.err };
    }
    const shown = terraform(cwd, ['show', '-json', file]);
    return { plan: JSON.parse(shown.out) as Plan, diagnostics: '' };
  }
  const here = (label: string, ...overrides: string[]) => plan(CONTROL, label, ...overrides);

  /** Plans a variation and, when it plans, runs every assertion that applies to it. */
  function variation(
    label: string,
    overrides: string[],
    v: Variation,
    exposure: Parameters<typeof checkIngress>[3],
    iam: Parameters<typeof checkIdentities>[3]
  ) {
    const result = here(label, ...overrides);
    checks.ok(`${label} plans`, result.plan !== null, result.diagnostics);
    if (result.plan === null) return;
    checkServices(result.plan, checks, FIXTURE, v);
    checkEcsServices(result.plan, checks, FIXTURE, v);
    checkIngress(result.plan, checks, FIXTURE, exposure);
    checkIdentities(result.plan, checks, FIXTURE, iam);
  }

  // --- the control plane as CI plans it ---------------------------------------------------------------------------
  variation('base', [], BASE, EXPOSURE, IAM);
  const base = here('base-count');
  checks.ok('the base plan has 37 resources', base.plan?.resource_changes.length === 37, String(base.plan?.resource_changes.length));
  if (base.plan !== null) checkAwsApiAlarm(base.plan, checks, ROOT, here('no-alarm', 'alert_api_errors=false').plan);
  for (const name of ['api_url', 'panel_url', 'alb_dns_name', 'api_task_role_arn', 'migrate', 'event_stream', 'oidc_redirect_uris']) {
    checks.ok(`output ${name}`, base.plan !== null && name in base.plan.output_changes);
  }
  checks.ok(
    'the event stream numbers are the documented ones',
    JSON.stringify(get(base.plan?.output_changes.event_stream, 'after')) === JSON.stringify({ alb_idle_timeout_seconds: 60, heartbeat_seconds: 15, lifetime_seconds: 600, shutdown_grace_seconds: 8, streams_per_task: 50 })
  );

  // --- variations ----------------------------------------------------------------------------------------------------
  variation('private', ['exposure=private'], BASE, { ...EXPOSURE, mode: 'private', cidrs: [FIXTURE.vpcCidr] }, IAM);
  variation('restricted-ingress', ['ingress_cidrs=["203.0.113.0/24","198.51.100.0/24"]'], BASE, { ...EXPOSURE, cidrs: ['203.0.113.0/24', '198.51.100.0/24'] }, IAM);
  variation('secrets-key', [`secrets_kms_key_arn=${KEY2}`], BASE, EXPOSURE, { ...IAM, secretsKey: KEY2 });
  variation('sqs-managed-key', ['queue_kms_key_arn=null'], BASE, EXPOSURE, { ...IAM, queueKey: undefined });
  variation('no-monitoring', ['monitoring_read=false'], BASE, EXPOSURE, { ...IAM, monitoring: false });
  variation('not-ecr', ['image_repository_arns=[]'], BASE, EXPOSURE, { ...IAM, ecr: false });
  variation('one-api-task', ['api_instances=1'], { ...BASE, apiInstances: 1 }, EXPOSURE, IAM);
  variation('longer-idle', ['alb_idle_timeout_seconds=300'], BASE, { ...EXPOSURE, idleSeconds: 300 }, IAM);
  const edge = here('edge-rate-limit', 'edge_rate_limit_per_minute=1200');
  checks.ok('an edge rate limit plans', edge.plan !== null, edge.diagnostics);
  if (edge.plan !== null) checkEdgeRateLimit(edge.plan, checks, 1200);
  checkAwsIngestPlans(here, checks, FIXTURE, KEY2, base.plan);
  checks.ok('no WAF unless asked for', base.plan !== null && ofType(base.plan, 'aws_wafv2_web_acl').length === 0);
  checks.ok('a rate limit under 10 is refused', here('edge-too-low', 'edge_rate_limit_per_minute=5').plan === null);
  variation(
    'pooled-with-direct',
    ['pooled=true', `database_direct_url_secret=${DIRECT}`],
    { ...BASE, pooled: true, migrateSecret: DIRECT },
    EXPOSURE,
    { ...IAM, migrateSecret: DIRECT }
  );
  variation(
    'pooled-without-direct',
    ['pooled=true'],
    { ...BASE, pooled: true, migratePooler: 'transaction' },
    EXPOSURE,
    IAM
  );
  variation(
    'ca-file',
    [`database_tls_env={QCLOUD_DATABASE_TLS_CA_FILE="${CA_FILE}"}`],
    { ...BASE, tls: { QCLOUD_DATABASE_TLS_CA_FILE: CA_FILE } },
    EXPOSURE,
    IAM
  );
  variation(
    'plaintext-to-a-pooler',
    ['pooled=true', 'database_tls_env={QCLOUD_DATABASE_TLS="off"}'],
    { ...BASE, pooled: true, migratePooler: 'transaction', tls: { QCLOUD_DATABASE_TLS: 'off' } },
    EXPOSURE,
    IAM
  );
  // No route out of the VPC: the API can only fetch the provider's keys through a route the deployer provides.
  const closed = here('closed', 'egress=none', 'internet_gateway_id=null', 'exposure=private', 'jwks_reachable_in_vpc=true');
  checks.ok('no route out, a private load balancer and a provider the VPC can reach plans', closed.plan !== null, closed.diagnostics);

  // --- the data plane hands over exactly what the control plane asks for, and the fixture is not stale -----------------
  terraform(EXAMPLE, ['init', '-backend=false', '-input=false', '-no-color']);
  const data = plan(EXAMPLE, 'data-plane');
  checks.ok('the data plane plans', data.plan !== null, data.diagnostics);
  const vars = (base.plan as unknown as { variables?: unknown } | null)?.variables;
  if (data.plan !== null && base.plan !== null) {
    const handed = get(data.plan.output_changes.control_plane_inputs, 'after');
    const unknown = get(data.plan.output_changes.control_plane_inputs, 'after_unknown');
    // An attribute the apply makes is missing from `after` and listed in `after_unknown`: both are handed over.
    const keys = [...new Set([...Object.keys((handed as object | undefined) ?? {}), ...Object.keys((unknown as object | undefined) ?? {})])];
    const declared = get(base.plan.configuration.root_module, 'variables') as Record<string, { default?: unknown }> | undefined;
    checks.ok('control_plane_inputs is in the data plane plan', keys.length > 0);
    for (const key of keys) {
      checks.ok(`control plane declares ${key}`, declared !== undefined && key in declared);
      const value = get(handed, key);
      const given = get(vars, key, 'value');
      // Anything the apply makes (ids, secret versions) is unknown now; everything else must equal the fixture's value.
      if (value === undefined) {
        // the apply makes it: nothing to compare
      } else if (value !== null && typeof value !== 'object') {
        checks.ok(`the fixture's ${key} is the data plane's`, given === value, `${String(given)} vs ${String(value)}`);
      } else if (value !== null && get(unknown, key) === undefined) {
        checks.ok(`the fixture's ${key} is the data plane's`, JSON.stringify(given) === JSON.stringify(value), `${JSON.stringify(given)} vs ${JSON.stringify(value)}`);
      }
    }
    // What the control plane asks for and the data plane does not hand over is the deployer's: images, sign-in, names.
    const own = new Set(['api_image', 'panel_image', 'oidc_issuer', 'oidc_audience', 'oidc_jwks_url', 'oidc_client_id', 'certificate_arn', 'api_hostname', 'panel_hostname']);
    const missing = Object.entries(declared ?? {})
      .filter(([key, v]) => !('default' in v) && !keys.includes(key) && !own.has(key))
      .map(([key]) => key);
    checks.ok('every required variable has a source', missing.length === 0, missing.join(', '));
    // The data plane's queue policies admit the API's role by the ARN this plan makes it.
    const tfvars = readFileSync(join(EXAMPLE, 'ci.tfvars.example'), 'utf8');
    checks.ok('the data plane example admits the API task role by its ARN', tfvars.includes(`"arn:aws:iam::${ACCOUNT}:role/qcloud-ci-api-task"`));
    checks.ok('both plans count the same connection budget', get(handed, 'budgeted_control_processes') === 4 && get(handed, 'budgeted_control_pool_size') === 2);
  }

  // --- what must be refused, and why ---------------------------------------------------------------------------------
  const refusals: Array<[string, string[], RegExp]> = [
    ['an unknown exposure', ['exposure=iap'], /exposure must be/],
    ['a public load balancer with no internet gateway', ['internet_gateway_id=null'], /needs the data plane's internet gateway/],
    ['no route out and no way to reach the provider', ['egress=none', 'internet_gateway_id=null', 'exposure=private'], /egress is none/],
    ['more API tasks than the connection budget counts', ['api_instances=3'], /connection budget counts/],
    ['a pool bigger than the budgeted one', ['api_pool_size=5'], /connections per control process/],
    ['a load balancer timeout that would cut a stream', ['event_heartbeat_seconds=40'], /at least twice/],
    ['a heartbeat longer than proxies keep an idle connection', ['event_heartbeat_seconds=120'], /between 15 and 60/],
    ['an idle timeout under 30 s', ['alb_idle_timeout_seconds=10'], /from 30 to 4000/],
    ['a stream lifetime under ten minutes', ['event_stream_lifetime_seconds=300'], /at least 600/],
    ['no audience', ['oidc_audience=[]'], /at least one value/],
    ['an http issuer', ['oidc_issuer=http://idp.example.com'], /https URL/],
    ['a wildcard origin', ['extra_cors_origins=["*"]'], /exact origins/],
    ['two TLS settings', ['database_tls_env={QCLOUD_DATABASE_TLS="off",QCLOUD_DATABASE_TLS_CA="x"}'], /exactly one/],
    ['a secret named, not given by ARN', ['database_url_secret=qcloud-ci/database-url'], /full ARN/],
    ['a certificate that is not an ACM ARN', ['certificate_arn=nope'], /ARN of an ACM certificate/],
    ['one host name for both services', ['panel_hostname=api.qcloud-ci.example.com'], /must differ/],
    ['an upper-case host name', ['api_hostname=API.example.com'], /lowercase DNS name/],
    ['a subnet with no room', ['vpc_cidr=10.20.0.0/24'], /usable addresses/],
    ['load balancer subnets that collide with the data plane', ['alb_subnet_slot=3'], /slots from alb_subnet_slot/],
    ['an ingress range that is not a CIDR', ['ingress_cidrs=["everyone"]'], /IPv4 CIDR ranges/],
    ['an account id that is not 12 digits', ['account_id=1234'], /12-digit/],
    ['a name that would break a resource name', ['name=Bad_Name'], /lowercase letter/],
    ['one zone', ['availability_zones=["eu-west-2a"]'], /at least two zones/],
  ];
  for (const [what, overrides, expected] of refusals) {
    const refused = here(what.replace(/\W+/g, '-'), ...overrides);
    checks.ok(`refused: ${what}`, refused.plan === null && expected.test(refused.diagnostics), refused.plan === null ? refused.diagnostics : 'it planned');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (checks.failures.length > 0) {
  console.error(`${checks.failures.length} of ${checks.passed + checks.failures.length} checks failed:`);
  for (const failure of checks.failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`terraform AWS control-plane check: ${checks.passed} checks passed`);
