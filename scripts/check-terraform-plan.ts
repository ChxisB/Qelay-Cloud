/**
 * Plans `infra/gcp/example` without credentials and checks the plan against task 21's acceptance:
 * formatting and validation, the resources and their safety settings, the Pub/Sub names the transport
 * expects, the connection budget against the TypeScript one, and that a fleet that cannot fit is refused.
 *
 *   bun run check:terraform
 *
 * Hermetic by construction: every GOOGLE_* and CLOUDSDK_* variable is dropped and the provider gets a
 * placeholder access token, so a developer's real credentials are never used and nothing reaches a
 * project. A plan of a fresh state reads nothing from the cloud. Needs `terraform` (1.5 or later);
 * without it the check is skipped with a warning, unless QCLOUD_REQUIRE_TERRAFORM=1 (CI sets it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { budget, workerRoleLimit } from '../packages/store-postgres/src/connection/budget';
import {
  checkDatabase,
  checkIdentities,
  checkMessaging,
  checkServices,
  workerProcesses,
} from './terraform-plan-assertions';
import { checkAlerts, checkOptInAlerts } from './terraform-plan-alerts';
import { checkAutoscaler } from './terraform-plan-autoscaler';
import { checkBackground, checkManagedPooling } from './terraform-plan-background';
import type { Plan } from './terraform-plan-model';
import { Checks, get, ofType } from './terraform-plan-model';

const ROOT = resolve(import.meta.dir, '..');
const EXAMPLE = join(ROOT, 'infra/gcp/example');
const VARS = '-var-file=ci.tfvars.example';
const NAMESPACE = 'ci';
/** Overrides that take the loop and the sender out, so a plan's connection count is the workers' alone. */
const NO_BACKGROUND = ['tick_loop=null', 'webhook_sender=null'];
const QUEUES = { default: {}, emails: { ack_deadline_seconds: 60, max_delivery_attempts: 10, hot: true },
};

const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GOOGLE_|CLOUDSDK_)/.test(k))
  ),
  GOOGLE_OAUTH_ACCESS_TOKEN: 'placeholder-not-a-token',
  TF_IN_AUTOMATION: '1',
  TF_INPUT: '0',
};

function terraform(args: string[]) {
  const done = Bun.spawnSync(['terraform', ...args], { cwd: EXAMPLE, env });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

if (Bun.which('terraform') === null) {
  const message = 'terraform is not installed: the plan check did not run';
  if (process.env.QCLOUD_REQUIRE_TERRAFORM === '1') throw new Error(message);
  console.warn(`WARNING: ${message}`);
  process.exit(0);
}

const checks = new Checks();
const scratch = mkdtempSync(join(tmpdir(), 'qcloud-tf-'));
try {
  const fmt = terraform(['fmt', '-check', '-recursive', '-diff', '-no-color', '..']);
  checks.ok('terraform fmt -check -recursive', fmt.code === 0, fmt.out);
  const init = terraform(['init', '-backend=false', '-input=false', '-no-color']);
  checks.ok('terraform init -backend=false', init.code === 0, init.err);
  const validate = terraform(['validate', '-no-color']);
  checks.ok('terraform validate', validate.code === 0, validate.err);
  checks.ok(
    'the provider lock file is committed',
    readFileSync(join(EXAMPLE, '.terraform.lock.hcl'), 'utf8').includes('hashicorp/google')
  );
  checks.ok(
    'an apply does not undo the autoscaler\'s count of a worker pool',
    readFileSync(join(ROOT, 'infra/gcp/modules/workers/main.tf'), 'utf8').includes(
      'ignore_changes = [scaling[0].manual_instance_count]'
    )
  );
  checks.ok(
    'the database has prevent_destroy',
    readFileSync(join(ROOT, 'infra/gcp/modules/database/main.tf'), 'utf8').includes(
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

  const base = plan('base');
  checks.ok('the example plans', base.plan !== null, base.diagnostics);
  if (base.plan !== null) {
    const p = base.plan;
    const budgetOut = get(p.output_changes.connection_budget, 'after');
    checkIdentities(p, checks);
    checkDatabase(p, checks, 100);
    checkMessaging(p, checks, NAMESPACE, QUEUES);
    checkServices(p, checks);
    checkBackground(p, checks, 'qcloud-ci');
    checkAlerts(p, checks, ROOT);
    // 10 + 4 worker instances at pool 2, three control processes at pool 2, six reserved.
    const { instances, connections } = workerProcesses(p);
    const ts = budget({ workers: instances, controlProcesses: 3 });
    checks.ok(
      "the services' max_instances x pool is the budget's worker share",
      connections === Number(get(budgetOut, 'direct_required')) - 6 - 6
    );
    checks.ok(
      'the Terraform budget is the TypeScript budget (direct)',
      get(budgetOut, 'direct_required') === ts.direct,
      `${get(budgetOut, 'direct_required')} vs ${ts.direct}`
    );
    checks.ok(
      'the Terraform budget is the TypeScript budget (pooled)',
      get(budgetOut, 'pooled_required') === ts.pooled,
      `${get(budgetOut, 'pooled_required')} vs ${ts.pooled}`
    );
    checks.ok('the example fits', Number(get(budgetOut, 'required')) <= 100);
  }

  // The README's figures: 10 / 50 / 200 worker processes, with and without a listener per process.
  for (const workers of [10, 50, 200]) {
    for (const listen of [0, 1]) {
      const where = `${workers} workers, listen ${listen}`;
      const scaled = plan(
        `scale-${workers}-${listen}`,
        `worker_services={worker={max_instances=${workers},listen_connections=${listen}}}`,
        'max_connections=1000',
        'subnet_cidr=10.0.0.0/22',
        ...NO_BACKGROUND
      );
      const out =
        scaled.plan === null
          ? undefined
          : get(scaled.plan.output_changes.connection_budget, 'after');
      const ts = budget({ workers, listeners: listen === 1 ? workers : 0 });
      checks.ok(
        `${where}: direct matches the TypeScript budget`,
        get(out, 'direct_required') === ts.direct,
        `${get(out, 'direct_required')} vs ${ts.direct} ${scaled.diagnostics}`
      );
      checks.ok(
        `${where}: pooled matches the TypeScript budget`,
        get(out, 'pooled_required') === ts.pooled,
        `${get(out, 'pooled_required')} vs ${ts.pooled}`
      );
      checks.ok(
        `${where}: the worker role limit matches the TypeScript budget`,
        get(out, 'worker_role_limit') === workerRoleLimit(ts),
        `${get(out, 'worker_role_limit')} vs ${workerRoleLimit(ts)}`
      );
    }
  }

  const managed = plan(
    'managed-pooling',
    'database_edition=ENTERPRISE_PLUS',
    'database_tier=db-perf-optimization-N8',
    'database_managed_pooling=true'
  );
  checks.ok('the example plans with managed pooling', managed.plan !== null, managed.diagnostics);
  if (managed.plan !== null) checkManagedPooling(managed.plan, checks);
  const both = plan(
    'both-poolers',
    'database_edition=ENTERPRISE_PLUS',
    'database_managed_pooling=true',
    'pooler={host="10.0.0.9"}'
  );
  checks.ok('managed pooling and an own pooler are exclusive', both.plan === null && /exclusive/.test(both.diagnostics));
  const standard = plan('managed-needs-plus', 'database_managed_pooling=true');
  checks.ok('managed pooling needs Enterprise Plus', standard.plan === null && /ENTERPRISE_PLUS/.test(standard.diagnostics));
  const negative = plan('negative-timeout', 'database_session_timeouts={lock_ms=-1}');
  checks.ok('a negative session timeout is refused', negative.plan === null && /non-negative/.test(negative.diagnostics));
  const noKey = plan('sender-without-key', 'webhooks=false');
  checks.ok('the sender needs the webhook key', noKey.plan === null && /webhook_sender needs webhooks/.test(noKey.diagnostics));

  const metrics = ['custom.googleapis.com/qcloud/claim_ms', 'custom.googleapis.com/qcloud/failed_total'];
  const optIn = plan(
    'opt-in-alerts',
    `claim_latency_metric_type=${metrics[0]}`,
    `failed_total_metric_type=${metrics[1]}`
  );
  checks.ok('the example plans with the exported-metric alerts', optIn.plan !== null, optIn.diagnostics);
  if (optIn.plan !== null) checkOptInAlerts(optIn.plan, checks, ROOT, metrics);

  // Pools that follow a queue's backlog get the autoscaler, and only they do.
  checks.ok(
    'without `autoscaling` no autoscaler exists',
    base.plan !== null && ofType(base.plan, 'google_parameter_manager_parameter').length === 0
  );
  const followed = plan(
    'autoscaled',
    'worker_services={worker={max_instances=10,autoscaling={queue="default"}},batch={max_instances=4,min_instances=0,memory="1Gi",autoscaling={queue="emails",backlog_per_instance=5}}}',
    ...NO_BACKGROUND
  );
  checks.ok('the example plans with autoscaled pools', followed.plan !== null, followed.diagnostics);
  if (followed.plan !== null) {
    checkAutoscaler(followed.plan, checks, NAMESPACE, {
      'qcloud-ci-worker': { queue: 'default', min: 1, max: 10, backlog: 10 },
      'qcloud-ci-batch': { queue: 'emails', min: 0, max: 4, backlog: 5 },
    });
    const { instances } = workerProcesses(followed.plan);
    checks.ok('the autoscaled fleet is counted at its ceilings', instances === 14, String(instances));
  }
  const typo = plan('autoscaling-typo', 'worker_services={worker={max_instances=2,autoscaling={queue="nope"}}}');
  checks.ok(
    'autoscaling on a queue that does not exist is refused',
    typo.plan === null && /not in `queues`/.test(typo.diagnostics),
    typo.diagnostics
  );

  // What must be refused, and why.
  const tooMany = plan('too-many', 'worker_services={worker={max_instances=60}}');
  checks.ok(
    'a fleet over max_connections is refused',
    tooMany.plan === null && /max_connections is 100/.test(tooMany.diagnostics),
    tooMany.diagnostics
  );
  const pooled = plan(
    'pooled',
    'worker_services={worker={max_instances=60}}',
    'pooler={host="10.10.0.9"}'
  );
  checks.ok('the same fleet behind a pooler is accepted', pooled.plan !== null, pooled.diagnostics);
  checks.ok(
    'and the budget says it is pooled',
    pooled.plan !== null &&
      get(pooled.plan.output_changes.connection_budget, 'after', 'mode') === 'pooled'
  );
  const plaintext = plan('plaintext', 'database_tls=off');
  checks.ok(
    'plaintext without a pooler is refused',
    plaintext.plan === null && /needs a pooler/.test(plaintext.diagnostics),
    plaintext.diagnostics
  );
  const tinySubnet = plan('subnet', 'subnet_cidr=10.10.0.0/28');
  checks.ok(
    'a subnet too small for the instances is refused',
    tinySubnet.plan === null && /usable addresses/.test(tinySubnet.diagnostics),
    tinySubnet.diagnostics
  );
  const badQueue = plan('bad-queue', 'queues={"a.b"={}}');
  checks.ok(
    'a queue name the transport would encode is refused',
    badQueue.plan === null && /letters, digits and dashes/.test(badQueue.diagnostics),
    badQueue.diagnostics
  );
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
console.log(`terraform plan check: ${checks.passed} checks passed`);
