/**
 * What `scripts/check-terraform-plan.ts` asserts about a plan of `infra/gcp/example` in which worker pools follow a
 * queue's backlog: the autoscaler exists, is not reachable by anyone, can touch only what it must, and is configured
 * with the same pools, subscriptions and ceilings as the Terraform that created them.
 */
import { queueNames } from '../packages/transport-gcp/src/names';
import type { Checks, Plan, ResourceChange } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

/** The roles the autoscaler's service account holds, and no others. */
const AUTOSCALER_ROLES = new Set([
  'roles/parametermanager.parameterViewer',
  'roles/run.developer',
  'roles/pubsub.viewer',
  'roles/iam.serviceAccountUser',
  'roles/monitoring.viewer',
]);

/** `pools`: pool name => the queue it follows, its floor and its ceiling. */
export function checkAutoscaler(
  plan: Plan,
  checks: Checks,
  namespace: string,
  pools: Record<string, { queue: string; min: number; max: number; backlog: number }>
): void {
  const service = ofType(plan, 'google_cloud_run_v2_service').find((s) => s.name === 'autoscaler');
  checks.ok('the autoscaler service exists', service !== undefined);
  if (service === undefined) return;
  const scaling = get(after(service), 'template', 0, 'scaling', 0);
  checks.ok(
    'the autoscaler is one always-on instance',
    get(scaling, 'min_instance_count') === 1 && get(scaling, 'max_instance_count') === 1
  );
  checks.ok(
    'the autoscaler keeps its CPU outside requests (it polls on a timer)',
    get(after(service), 'template', 0, 'containers', 0, 'resources', 0, 'cpu_idle') === false
  );
  checks.ok(
    'the autoscaler is internal and open to no one',
    get(after(service), 'ingress') === 'INGRESS_TRAFFIC_INTERNAL_ONLY' &&
      ofType(plan, 'google_cloud_run_v2_service_iam_member').every(
        (m) => !String(get(after(m), 'name')).includes('autoscaler')
      )
  );
  checks.ok(
    'the autoscaler image is pinned to a tag or digest, not latest',
    /:[0-9][^:/]*$|@sha256:/.test(
      String(get(after(service), 'template', 0, 'containers', 0, 'image'))
    )
  );
  const version = ofType(plan, 'google_parameter_manager_parameter_version')[0];
  checks.ok('the config is a parameter version', version !== undefined);
  const env = get(after(service), 'template', 0, 'containers', 0, 'env');
  checks.ok(
    'the autoscaler is told where its config is',
    Array.isArray(env) && env.some((e) => get(e, 'name') === 'CREMA_CONFIG')
  );
  const parsed: unknown = Bun.YAML.parse(String(get(after(version as ResourceChange), 'parameter_data')));
  checks.ok(
    'the config is a CremaConfig',
    get(parsed, 'apiVersion') === 'crema/v1' && get(parsed, 'kind') === 'CremaConfig'
  );
  checks.ok(
    'the config authenticates as the autoscaler (pod identity: gcp)',
    get(parsed, 'spec', 'triggerAuthentications', 0, 'spec', 'podIdentity', 'provider') === 'gcp'
  );
  const objects = get(parsed, 'spec', 'scaledObjects');
  const targets = Array.isArray(objects) ? objects.map((o) => get(o, 'spec')) : [];
  checks.ok('one scaled object per pool', targets.length === Object.keys(pools).length);
  for (const [pool, wanted] of Object.entries(pools)) {
    const target = targets.find((t) => String(get(t, 'scaleTargetRef', 'name')).endsWith(`/workerPools/${pool}`));
    const trigger = get(target, 'triggers', 0);
    checks.ok(`${pool}: the config targets the pool`, target !== undefined);
    checks.ok(
      `${pool}: its floor and ceiling are the pool's`,
      get(target, 'minReplicaCount') === wanted.min && get(target, 'maxReplicaCount') === wanted.max,
      JSON.stringify(target)
    );
    checks.ok(
      `${pool}: it follows the queue's subscription, by size`,
      get(trigger, 'type') === 'gcp-pubsub' &&
        get(trigger, 'metadata', 'subscriptionName') === queueNames(namespace, wanted.queue).subscription &&
        get(trigger, 'metadata', 'mode') === 'SubscriptionSize' &&
        get(trigger, 'metadata', 'value') === String(wanted.backlog),
      JSON.stringify(trigger)
    );
  }
  const ours = ofType(plan, 'google_project_iam_member')
    .concat(ofType(plan, 'google_cloud_run_v2_worker_pool_iam_member'))
    .concat(ofType(plan, 'google_pubsub_subscription_iam_member'))
    .concat(ofType(plan, 'google_service_account_iam_member'))
    .filter((c) => String(get(after(c), 'member')).includes('-autoscaler@'));
  const roles = new Set(ours.map((c) => String(get(after(c), 'role'))));
  checks.ok(
    'the autoscaler holds exactly its five roles',
    roles.size === AUTOSCALER_ROLES.size && [...roles].every((r) => AUTOSCALER_ROLES.has(r)),
    [...roles].join(', ')
  );
  const wide = ours.filter((c) => /^google_project_iam/.test(c.type)).map((c) => get(after(c), 'role'));
  checks.ok(
    'its project-level grants are the two read-only ones',
    wide.length === 2 &&
      wide.includes('roles/monitoring.viewer') &&
      wide.includes('roles/parametermanager.parameterViewer'),
    wide.join(', ')
  );
  checks.ok(
    'it may scale each followed pool and read each followed subscription, and no more',
    ours.filter((c) => get(after(c), 'role') === 'roles/run.developer').length ===
      Object.keys(pools).length &&
      ours.filter((c) => get(after(c), 'role') === 'roles/pubsub.viewer').length ===
        new Set(Object.values(pools).map((p) => p.queue)).size
  );
}
