/**
 * Plans `infra/aws/example` without credentials and checks the plan against task 42's acceptance: formatting and
 * validation, every identity's permissions, the database's safety settings, the queues against `queueNames` (the
 * names `ensureQueue` makes), the processes' environment, the connection budget against the TypeScript one, and that
 * a configuration that cannot work is refused.
 *
 *   bun run check:terraform
 *
 * Hermetic by construction: every AWS_* variable is dropped, the instance metadata service is switched off, and the
 * example's `offline_plan` makes the provider take a placeholder key and skip every call that needs the network. A plan
 * of a fresh state reads nothing from the account. Needs `terraform` (1.5 or later); without it the check is skipped
 * with a warning, unless QCLOUD_REQUIRE_TERRAFORM=1 (CI sets it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { budget } from '../packages/store-postgres/src/connection/budget';
import { checkAlarms, checkDatabase, checkMessaging, checkNetwork, checkProxy } from './terraform-plan-aws-data';
import { checkIdentities } from './terraform-plan-aws-iam';
import { checkAlarmRunbooks, checkAwsAlerts, checkAwsOptInAlerts } from './terraform-plan-aws-alerts';
import { checkProcesses, checkScheduler, checkServices } from './terraform-plan-aws-services';
import { budgetOf, checkLevers, checkRefusals, checkScaling, checkTickSchedule } from './terraform-plan-aws-variations';
import type { Plan } from './terraform-plan-model';
import { Checks, get } from './terraform-plan-model';

const ROOT = resolve(import.meta.dir, '..');
const EXAMPLE = join(ROOT, 'infra/aws/example');
const VARS = '-var-file=ci.tfvars.example';
const ACCOUNT = '123456789012';
const REGION = 'eu-west-2';
const KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/00000000-0000-0000-0000-000000000000`;
const QUEUES = { default: {}, emails: { visibility_timeout_seconds: 60, max_receive_count: 10 } };
const SERVICES = {
  worker: { min: 1, max: 10, pool: 2, scaled: false },
  batch: { min: 0, max: 4, pool: 2, scaled: true },
};
const TICK_ENTRY = ['bun', '/app/packages/maintenance/src/bin.ts'];
const CA_FILE = '/etc/ssl/certs/rds-global-bundle.pem';
/** The heredoc in ci.tfvars.example, which Terraform strips of its indentation and ends with a newline. */
const CA_PEM = '-----BEGIN CERTIFICATE-----\nY2ktcGxhbi1ub3QtYS1yZWFsLWNlcnRpZmljYXRl\n-----END CERTIFICATE-----\n';
/** 70 characters, so the dead-letter name passes 80 and the name is hashed; the 40-character slug ends in a hyphen. */
const LONG = `${'a'.repeat(36)}-${'b'.repeat(33)}`;

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AWS_/.test(k))),
  AWS_EC2_METADATA_DISABLED: 'true',
  TF_IN_AUTOMATION: '1',
  TF_INPUT: '0',
};

function terraform(args: string[]) {
  const done = Bun.spawnSync(['terraform', ...args], { cwd: EXAMPLE, env });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

if (Bun.which('terraform') === null) {
  const message = 'terraform is not installed: the AWS plan check did not run';
  if (process.env.QCLOUD_REQUIRE_TERRAFORM === '1') throw new Error(message);
  console.warn(`WARNING: ${message}`);
  process.exit(0);
}

const checks = new Checks();
const scratch = mkdtempSync(join(tmpdir(), 'qcloud-tf-aws-'));
try {
  const fmt = terraform(['fmt', '-check', '-recursive', '-diff', '-no-color', '..']);
  checks.ok('terraform fmt -check -recursive', fmt.code === 0, fmt.out);
  const init = terraform(['init', '-backend=false', '-input=false', '-no-color']);
  checks.ok('terraform init -backend=false', init.code === 0, init.err);
  const validate = terraform(['validate', '-no-color']);
  checks.ok('terraform validate', validate.code === 0, validate.err);
  const lock = readFileSync(join(EXAMPLE, '.terraform.lock.hcl'), 'utf8');
  checks.ok(
    'the provider lock file is committed',
    lock.includes('hashicorp/aws') && lock.includes('hashicorp/random')
  );
  checks.ok(
    'the database has prevent_destroy',
    readFileSync(join(ROOT, 'infra/aws/modules/database/main.tf'), 'utf8').includes(
      'prevent_destroy = true'
    )
  );

  /** Plans with the CI variables plus overrides and returns the plan as JSON, or the diagnostics of a refusal. */
  function plan(label: string, ...overrides: string[]) {
    const file = join(scratch, `${label}.tfplan`);
    const vars = overrides.flatMap((v) => ['-var', v]);
    const planned = terraform(['plan', '-lock=false', VARS, ...vars, `-out=${file}`, '-no-color']);
    if (planned.code !== 0) {
      // `-json` prints each diagnostic whole; the plain text wraps at 78 columns and breaks a message.
      const json = terraform(['plan', '-lock=false', VARS, ...vars, '-json', '-no-color']);
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
        .map(
          (entry) => `${get(entry, 'diagnostic', 'summary')}: ${get(entry, 'diagnostic', 'detail')}`
        );
      return { plan: null, diagnostics: diagnostics.join('\n') || planned.err };
    }
    const shown = terraform(['show', '-json', file]);
    return { plan: JSON.parse(shown.out) as Plan, diagnostics: '' };
  }


  // --- the example as CI plans it --------------------------------------------------------------------------
  const iam = {
    account: ACCOUNT,
    region: REGION,
    name: 'qcloud-ci',
    logGroups: {
      workers: ['/qcloud/qcloud-ci/workers/batch', '/qcloud/qcloud-ci/workers/worker'],
      tick: '/qcloud/qcloud-ci/tick',
    },
    secrets: {
      workers: ['qcloud-ci/database-url'],
      tick: ['qcloud-ci/database-url'],
    },
    queueArns: ['default', 'emails'].map((q) => `arn:aws:sqs:${REGION}:${ACCOUNT}:qcloud-ci__${q}`),
    deadLetterArns: ['default', 'emails'].map(
      (q) => `arn:aws:sqs:${REGION}:${ACCOUNT}:qcloud-ci__${q}__dlq`
    ),
    additionalPrincipals: [`arn:aws:iam::${ACCOUNT}:role/qcloud-ci-api-task`],
    repositories: [
      `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/qcloud-worker`,
      `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/qcloud-api`,
    ],
  };
  const processes = {
    namespace: 'ci',
    region: REGION,
    pooled: false,
    controlPool: 2,
    caPem: CA_PEM,
  };

  const base = plan('base');
  checks.ok('the example plans', base.plan !== null, base.diagnostics);
  if (base.plan !== null) {
    const p = base.plan;
    checkIdentities(p, checks, iam);
    checkDatabase(p, checks, 100);
    checkProxy(p, checks, false);
    checkNetwork(p, checks, 'nat');
    checkMessaging(p, checks, 'ci', QUEUES);
    checkAlarms(p, checks, ['default', 'emails'], 100);
    checkAwsAlerts(p, checks, ['qcloud-ci-worker', 'qcloud-ci-batch'], ['default', 'emails']);
    checkAlarmRunbooks(p, checks, ROOT);
    checkServices(p, checks, SERVICES);
    checkProcesses(p, checks, processes, SERVICES, TICK_ENTRY);
    checkScheduler(p, checks);
    checkTickSchedule(p, checks, 1);
    // 10 + 4 worker instances and four control processes, all at pool 2, six reserved.
    const ts = budget({ workers: 14, controlProcesses: 4 });
    const out = budgetOf(p);
    checks.ok(
      'the Terraform budget is the TypeScript budget (direct)',
      get(out, 'direct_required') === ts.direct,
      `${get(out, 'direct_required')} vs ${ts.direct}`
    );
    checks.ok(
      'the Terraform budget is the TypeScript budget (pooled)',
      get(out, 'pooled_required') === ts.pooled,
      `${get(out, 'pooled_required')} vs ${ts.pooled}`
    );
    checks.ok('the example fits', Number(get(out, 'required')) <= 100);
    checks.ok(
      'every output the control plane reads is there',
      ['queue_urls', 'queue_arns', 'dead_letter_urls', 'tick_target', 'control_plane_inputs'].every(
        (name) => name in p.output_changes
      )
    );
  }

  // --- the alarms that read a metric you export yourself, named -------------------------------------------------
  const exported = plan(
    'exported-metrics',
    'claim_latency_metric={namespace="Qelay",name="claim_ms"}',
    'failed_total_metric={namespace="Qelay",name="failed_total"}'
  );
  checks.ok('the example plans with the exported-metric alarms', exported.plan !== null, exported.diagnostics);
  if (exported.plan !== null) {
    checkAwsOptInAlerts(exported.plan, checks, 300);
    checkAlarmRunbooks(exported.plan, checks, ROOT);
  }

  // --- the queues' key given, so the grants on it can be read --------------------------------------------------
  const keyed = plan('keyed', `queue_kms_key_arn=${KEY}`);
  checks.ok('an existing queue key plans', keyed.plan !== null, keyed.diagnostics);
  if (keyed.plan !== null) {
    checkIdentities(keyed.plan, checks, { ...iam, queueKey: KEY });
    checkMessaging(keyed.plan, checks, 'ci', QUEUES, KEY);
    checks.ok(
      'no key is created when one is given',
      keyed.plan.resource_changes.every((c) => c.type !== 'aws_kms_key')
    );
  }

  // --- a queue whose name is hashed, and the Terraform sha256 against the transport's -----------------------------
  // (`emails` stays: the batch service scales on it.)
  const hashed = plan('hashed', `queues={default={},emails={},"${LONG}"={}}`);
  checks.ok('a queue with a long name plans', hashed.plan !== null, hashed.diagnostics);
  if (hashed.plan !== null) {
    checkMessaging(hashed.plan, checks, 'ci', { default: {}, emails: {}, [LONG]: {} });
  }

  // --- an RDS Proxy ----------------------------------------------------------------------------------------------
  const proxied = plan('proxy', 'rds_proxy={}');
  checks.ok('an RDS Proxy plans', proxied.plan !== null, proxied.diagnostics);
  if (proxied.plan !== null) {
    const p = proxied.plan;
    checkProxy(p, checks, true);
    checkProcesses(p, checks, { ...processes, pooled: true }, SERVICES, TICK_ENTRY);
    const ts = budget({ workers: 14, controlProcesses: 4, poolerPoolSize: 50 });
    checks.ok(
      'behind the proxy the budget is pooled, at half of max_connections',
      get(budgetOf(p), 'mode') === 'pooled' && get(budgetOf(p), 'required') === ts.pooled,
      JSON.stringify(budgetOf(p))
    );
    checkIdentities(p, checks, {
      ...iam,
      secrets: {
        workers: ['qcloud-ci/database-listen-url', 'qcloud-ci/database-url'],
        tick: ['qcloud-ci/database-url'],
      },
    });
    const off = plan('proxy-plaintext', 'rds_proxy={}', 'database_tls=off');
    checks.ok('plaintext to the proxy is accepted', off.plan !== null, off.diagnostics);
    if (off.plan !== null) {
      checkProcesses(off.plan, checks, { ...processes, pooled: true, caPem: undefined, tlsMode: 'off' }, SERVICES, TICK_ENTRY);
    }
  }
  const caFile = plan('ca-file', 'database_tls=ca-file', 'database_ca_pem=');
  checks.ok('a CA file in the image plans', caFile.plan !== null, caFile.diagnostics);
  if (caFile.plan !== null) {
    checkProcesses(
      caFile.plan,
      checks,
      { ...processes, caPem: undefined, caFile: CA_FILE },
      SERVICES,
      TICK_ENTRY
    );
  }
  const unverified = plan('unverified', 'database_tls=unverified');
  checks.ok('an unverified connection plans', unverified.plan !== null, unverified.diagnostics);
  if (unverified.plan !== null) {
    checkProcesses(
      unverified.plan,
      checks,
      { ...processes, caPem: undefined, tlsMode: 'unverified' },
      SERVICES,
      TICK_ENTRY
    );
  }

  // --- no route to the internet ----------------------------------------------------------------------------------
  const closed = plan('closed', 'egress=none');
  checks.ok('an environment with no route out plans', closed.plan !== null, closed.diagnostics);
  if (closed.plan !== null) checkNetwork(closed.plan, checks, 'none');

  checkScaling(plan, checks);
  checkLevers(plan, checks);
  checkRefusals(plan, checks);
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
console.log(`terraform AWS plan check: ${checks.passed} checks passed`);
