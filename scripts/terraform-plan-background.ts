/**
 * What `scripts/check-terraform-plan.ts` asserts about the always-on pools of `infra/gcp/example` (the tick loop and
 * the webhook sender, R19) and about Cloud SQL's managed connection pooling: what they run, whose identity they run
 * as, which secrets they and the job workers can read, and what the budget counts.
 */
import type { Checks, Plan } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

/** The names of the environment variables a pool takes from Secret Manager. */
function secretEnvNames(pool: unknown): string[] {
  const env = get(pool, 'template', 0, 'containers', 0, 'env');
  return Array.isArray(env)
    ? env.filter((e) => get(e, 'value_source', 0) !== undefined).map((e) => String(get(e, 'name')))
    : [];
}

export function checkBackground(plan: Plan, checks: Checks, prefix: string): void {
  const pools = new Map(
    ofType(plan, 'google_cloud_run_v2_worker_pool').map((c) => [String(get(after(c), 'name')), after(c)])
  );
  const calls = plan.configuration.root_module.module_calls;
  const wanted = [
    { name: `${prefix}-tick-loop`, args: ['loop'], instances: 1 },
    { name: `${prefix}-webhook-sender`, args: ['send'], instances: 2 },
  ];
  for (const { name, args, instances } of wanted) {
    const pool = pools.get(name);
    checks.ok(`${name}: a worker pool`, pool !== undefined);
    checks.ok(
      `${name}: runs qcloud-tick ${args[0]}`,
      JSON.stringify(get(pool, 'template', 0, 'containers', 0, 'args')) === JSON.stringify(args) &&
        JSON.stringify(get(pool, 'template', 0, 'containers', 0, 'command')) ===
          JSON.stringify(['bun', '/app/packages/maintenance/src/bin.ts'])
    );
    checks.ok(
      `${name}: a fixed ${instances}`,
      get(pool, 'scaling', 0, 'manual_instance_count') === instances &&
        get(pool, 'labels', 'qcloud-max-instances') === String(instances)
    );
    checks.ok(
      `${name}: reads the database URL and the webhook key`,
      ['QCLOUD_DATABASE_URL', 'QCLOUD_WEBHOOK_KEY'].every((v) => secretEnvNames(pool).includes(v))
    );
  }
  // Their identity is the tick's: it can ring and read the webhook key; the workers' cannot read the key.
  const background = calls?.background?.expressions?.service_account_email?.references ?? [];
  checks.ok('the loop and the sender run as the tick identity', background.includes('module.iam.tick_email'));
  const readers = ofType(plan, 'google_secret_manager_secret_iam_member').map((c) => c.address);
  const reads = (who: string) => readers.some((a) => a.includes(`${who}_read["webhook-key"]`));
  checks.ok('the tick identity reads the webhook key', reads('tick'));
  checks.ok('the job workers do not read the webhook key', !reads('workers'));
  for (const [name, pool] of pools) {
    if (/-(tick-loop|webhook-sender)$/.test(name)) continue;
    checks.ok(`${name}: no webhook key`, !secretEnvNames(pool).includes('QCLOUD_WEBHOOK_KEY'));
  }
}

/** Managed pooling: Enterprise Plus, the pool on, and every process told it is behind a transaction pooler. */
export function checkManagedPooling(plan: Plan, checks: Checks): void {
  const [instance] = ofType(plan, 'google_sql_database_instance');
  const settings = get(after(instance as never), 'settings', 0);
  checks.ok('managed pooling: Enterprise Plus', get(settings, 'edition') === 'ENTERPRISE_PLUS');
  checks.ok(
    'managed pooling: the pool is on',
    get(settings, 'connection_pool_config', 0, 'connection_pooling_enabled') === true
  );
  const pools = ofType(plan, 'google_cloud_run_v2_worker_pool');
  const env = (c: (typeof pools)[number]) => get(after(c), 'template', 0, 'containers', 0, 'env');
  checks.ok(
    'managed pooling: every pool is told it is behind a transaction pooler',
    pools.length > 0 &&
      pools.every(
        (c) =>
          Array.isArray(env(c)) &&
          (env(c) as unknown[]).some(
            (e) => get(e, 'name') === 'QCLOUD_DATABASE_POOLER' && get(e, 'value') === 'transaction'
          )
      )
  );
}
