/**
 * Plans `infra/gcp/control-plane` without credentials and checks the plan against task 36's acceptance:
 * it validates, plans cleanly, leaves no route open but `/health`, keeps credentials out of the plan, and
 * agrees with the data plane (`infra/gcp/example`) on every value it takes from it.
 *
 *   bun run check:terraform
 *
 * Hermetic like `check-terraform-plan.ts`: every GOOGLE_* and CLOUDSDK_* variable is dropped and the
 * provider gets a placeholder access token, so nothing reaches a project. Needs `terraform` 1.5 or later;
 * without it the check is skipped with a warning, unless QCLOUD_REQUIRE_TERRAFORM=1 (CI sets it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Fixture } from './terraform-control-plane-assertions';
import {
  checkIdentities,
  checkMigration,
  checkServices,
} from './terraform-control-plane-assertions';
import { checkGcpApiAlert } from './terraform-control-plane-alerts';
import { checkEdge } from './terraform-control-plane-edge';
import { checkIngest, checkIngestEdge } from './terraform-control-plane-ingest';
import type { Plan } from './terraform-plan-model';
import { Checks, get } from './terraform-plan-model';

const ROOT = resolve(import.meta.dir, '..');
const CONTROL = join(ROOT, 'infra/gcp/control-plane');
const EXAMPLE = join(ROOT, 'infra/gcp/example');
const VARS = '-var-file=ci.tfvars.example';
const FIXTURE: Fixture = {
  name: 'qcloud-ci',
  projectNumber: '123456789012',
  region: 'europe-west2',
  namespace: 'ci',
  queues: ['default', 'emails'],
  hotQueues: ['emails'],
};

const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GOOGLE_|CLOUDSDK_)/.test(k))
  ),
  GOOGLE_OAUTH_ACCESS_TOKEN: 'placeholder-not-a-token',
  TF_IN_AUTOMATION: '1',
  TF_INPUT: '0',
};

function terraform(cwd: string, args: string[]) {
  const done = Bun.spawnSync(['terraform', ...args], { cwd, env });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

if (Bun.which('terraform') === null) {
  const message = 'terraform is not installed: the control-plane plan check did not run';
  if (process.env.QCLOUD_REQUIRE_TERRAFORM === '1') throw new Error(message);
  console.warn(`WARNING: ${message}`);
  process.exit(0);
}

const checks = new Checks();
const scratch = mkdtempSync(join(tmpdir(), 'qcloud-tf-cp-'));
try {
  const fmt = terraform(CONTROL, ['fmt', '-check', '-recursive', '-diff', '-no-color']);
  checks.ok('control plane: terraform fmt -check -recursive', fmt.code === 0, fmt.out);
  const init = terraform(CONTROL, ['init', '-backend=false', '-input=false', '-no-color']);
  checks.ok('control plane: terraform init -backend=false', init.code === 0, init.err);
  const validate = terraform(CONTROL, ['validate', '-no-color']);
  checks.ok('control plane: terraform validate', validate.code === 0, validate.err);
  checks.ok(
    'control plane: the provider lock file is committed',
    readFileSync(join(CONTROL, '.terraform.lock.hcl'), 'utf8').includes('hashicorp/google')
  );

  function plan(cwd: string, label: string, ...overrides: string[]) {
    const file = join(scratch, `${label}.tfplan`);
    const vars = overrides.flatMap((v) => ['-var', v]);
    const planned = terraform(cwd, ['plan', '-lock=false', VARS, ...vars, `-out=${file}`, '-no-color']);
    if (planned.code !== 0) {
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

  const base = plan(CONTROL, 'base');
  checks.ok('the control plane plans', base.plan !== null, base.diagnostics);
  if (base.plan !== null) {
    checkServices(base.plan, checks, FIXTURE);
    checkMigration(base.plan, checks);
    checkIdentities(base.plan, checks, FIXTURE);
    checkGcpApiAlert(base.plan, checks, ROOT, plan(CONTROL, 'no-alert', 'alert_api_errors=false').plan);
  }

  // The data plane hands over exactly what the control plane asks for, and the fixture is not stale.
  terraform(EXAMPLE, ['init', '-backend=false', '-input=false', '-no-color']);
  const data = plan(EXAMPLE, 'data-plane');
  checks.ok('the data plane plans', data.plan !== null, data.diagnostics);
  if (data.plan !== null && base.plan !== null) {
    const handed = get(data.plan.output_changes.control_plane_inputs, 'after');
    const unknown = get(data.plan.output_changes.control_plane_inputs, 'after_unknown');
    const keys = Object.keys((handed as object | undefined) ?? {});
    const declared = get(base.plan.configuration.root_module, 'variables') as
      | Record<string, { default?: unknown }>
      | undefined;
    checks.ok('control_plane_inputs is in the data plane plan', keys.length > 0);
    for (const key of keys) {
      checks.ok(`control plane declares ${key}`, declared !== undefined && key in declared);
      const value = get(handed, key);
      const given = get(
        (base.plan as unknown as { variables?: unknown }).variables,
        key,
        'value'
      );
      // Secret versions are known only after apply; everything else must equal the fixture's value.
      if (value !== null && typeof value !== 'object') {
        checks.ok(`the fixture's ${key} is the data plane's`, given === value, `${given} vs ${value}`);
      } else if (value !== null && get(unknown, key) === undefined) {
        checks.ok(
          `the fixture's ${key} is the data plane's`,
          JSON.stringify(given) === JSON.stringify(value),
          `${JSON.stringify(given)} vs ${JSON.stringify(value)}`
        );
      }
    }
    // What the control plane asks for and the data plane does not hand over is the deployer's: images and sign-in.
    const own = new Set([
      'api_image',
      'panel_image',
      'oidc_issuer',
      'oidc_audience',
      'oidc_jwks_url',
      'oidc_client_id',
    ]);
    const missing = Object.entries(declared ?? {})
      .filter(([key, v]) => !('default' in v) && !keys.includes(key) && !own.has(key))
      .map(([key]) => key);
    checks.ok('every required variable has a source', missing.length === 0, missing.join(', '));
  }

  // The other exposure: internal ingress, and nothing else changes.
  const privately = plan(CONTROL, 'private', 'exposure=private');
  checks.ok('exposure=private plans', privately.plan !== null, privately.diagnostics);
  if (privately.plan !== null) {
    const ingress = privately.plan.resource_changes
      .filter((c) => c.type === 'google_cloud_run_v2_service')
      .map((c) => get(c.change.after, 'ingress'));
    checks.ok(
      'exposure=private: both services take internal traffic only',
      ingress.length === 2 && ingress.every((i) => i === 'INGRESS_TRAFFIC_INTERNAL_ONLY')
    );
  }

  // The opt-in edge: a load balancer with a Cloud Armor rate limit, and nothing else changes for the services.
  const edgeVar = 'edge={api_hostname="api.example.com",panel_hostname="qelay.example.com",rate_limit_per_minute=900}';
  const edge = plan(CONTROL, 'edge', edgeVar);
  checks.ok('edge plans', edge.plan !== null, edge.diagnostics);
  if (edge.plan !== null) checkEdge(edge.plan, checks, { apiHost: 'api.example.com', panelHost: 'qelay.example.com', limit: 900, apiTimeout: 900 });
  checks.ok('no load balancer unless asked for', base.plan !== null && base.plan.resource_changes.every((c) => !c.type.startsWith('google_compute_')));
  checks.ok('no ingest unless asked for', base.plan !== null && base.plan.resource_changes.every((c) => !c.address.includes('ingest')));

  // The opt-in ingest (inbound sources): its own service and account, and the connection budget counts its instances.
  const ingestImage = 'europe-west2-docker.pkg.dev/qcloud-ci/qcloud/ingest:ci';
  const ingestVar = `ingest={image="${ingestImage}"}`;
  const withIngest = plan(CONTROL, 'ingest', ingestVar, 'budgeted_control_processes=5');
  checks.ok('ingest plans', withIngest.plan !== null, withIngest.diagnostics);
  if (withIngest.plan !== null) checkIngest(withIngest.plan, checks, FIXTURE, ingestImage);
  const ingestEdge = plan(CONTROL, 'ingest-edge', ingestVar, 'budgeted_control_processes=5', 'edge={api_hostname="api.example.com",panel_hostname="qelay.example.com",ingest_hostname="in.example.com",ingest_rate_limit_per_minute=3000}');
  checks.ok('ingest behind the edge plans', ingestEdge.plan !== null, ingestEdge.diagnostics);
  if (ingestEdge.plan !== null) checkIngestEdge(ingestEdge.plan, checks, { ingestHost: 'in.example.com', limit: 3000 });

  // What must be refused, and why.
  const refusals: Array<[string, string[], RegExp]> = [
    ['an unknown exposure', ['exposure=iap'], /exposure must be/],
    ['an edge on a private deployment', ['exposure=private', 'edge={api_hostname="a.example.com",panel_hostname="b.example.com"}'], /Use one or the other/],
    ['an edge with one host name for both', ['edge={api_hostname="a.example.com",panel_hostname="a.example.com"}'], /different names/],
    ['more API instances than the connection budget counts', ['api_max_instances=3'], /connection budget counts/],
    ['a pool bigger than the budgeted one', ['api_pool_size=5'], /connections per control process/],
    ['an ingest the connection budget does not count', ['ingest={image="x"}'], /connection budget counts/],
    ['an ingest pool bigger than the budgeted one', ['ingest={image="x",max_instances=1,pool_size=5}', 'budgeted_control_processes=5'], /ingest\.pool_size is 5/],
    ['an ingest behind an edge with no host name', ['ingest={image="x"}', 'budgeted_control_processes=5', 'edge={api_hostname="a.example.com",panel_hostname="b.example.com"}'], /needs edge\.ingest_hostname/],
    ['an ingest host name with no ingest', ['edge={api_hostname="a.example.com",panel_hostname="b.example.com",ingest_hostname="c.example.com"}'], /nothing would answer/],
    ['an ingest host name that is the API\'s', ['ingest={image="x"}', 'budgeted_control_processes=5', 'edge={api_hostname="a.example.com",panel_hostname="b.example.com",ingest_hostname="a.example.com"}'], /different names/],
    ['a request timeout that cuts streams', ['api_request_timeout_seconds=620'], /close a stream before Cloud Run/],
    ['a timeout past the platform maximum', ['api_request_timeout_seconds=7200'], /at most 3600/],
    ['a heartbeat longer than proxies keep an idle connection', ['event_heartbeat_seconds=120'], /between 15 and 60/],
    ['streams that fill every request slot', ['api_event_streams=100'], /must be below api_concurrency/],
    ['no audience', ['oidc_audience=[]'], /at least one value/],
    ['an http issuer', ['oidc_issuer=http://idp.example.com'], /https URL/],
    ['a wildcard origin', ['extra_cors_origins=["*"]'], /exact origins/],
    ['plaintext without a pooler', ['database_tls=off'], /needs a pooler/],
    ['a subnet with no room', ['subnet_cidr=10.10.0.0/28'], /usable addresses/],
    ['verified TLS with no CA', ['database_ca_secret=null'], /needs database_ca_secret/],
  ];
  for (const [what, overrides, expected] of refusals) {
    const refused = plan(CONTROL, what.replace(/\W+/g, '-'), ...overrides);
    checks.ok(
      `refused: ${what}`,
      refused.plan === null && expected.test(refused.diagnostics),
      refused.plan === null ? refused.diagnostics : 'it planned'
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (checks.failures.length > 0) {
  console.error(
    `${checks.failures.length} of ${checks.passed + checks.failures.length} checks failed:`
  );
  for (const failure of checks.failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`terraform control-plane check: ${checks.passed} checks passed`);
