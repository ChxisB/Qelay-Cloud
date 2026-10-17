/**
 * What `scripts/check-terraform-plan-aws.ts` asserts about the processes of `infra/aws/example`: the worker services
 * and their scaling, the tick's task and its schedule, and what each process is told (the `processes` output, since a
 * container definition is a JSON string that Terraform cannot read before the roles it names exist).
 */
import { callReferences, same } from './terraform-plan-aws-model';
import type { Plan } from './terraform-plan-model';
import type { Checks } from './terraform-plan-model';
import { attr, get, ofType } from './terraform-plan-model';

export interface ServiceExpectation {
  readonly min: number;
  readonly max: number;
  readonly pool: number;
  readonly scaled: boolean;
  readonly spot?: boolean;
}

export interface ProcessExpectation {
  readonly namespace: string;
  readonly region: string;
  readonly pooled: boolean;
  readonly controlPool: number;
  readonly caFile?: string;
  readonly caPem?: string;
  readonly tlsMode?: 'unverified' | 'off';
}

export function checkServices(
  plan: Plan,
  checks: Checks,
  services: Readonly<Record<string, ServiceExpectation>>
): void {
  const found = ofType(plan, 'aws_ecs_service');
  checks.ok('one ECS service per worker service', found.length === Object.keys(services).length);
  for (const [name, want] of Object.entries(services)) {
    const service = found.find((c) => c.address === `module.workers["${name}"].aws_ecs_service.this`);
    const strategy = attr(service, 'capacity_provider_strategy');
    const providers = Array.isArray(strategy)
      ? strategy.map((s) => `${get(s, 'capacity_provider')}:${get(s, 'base')}:${get(s, 'weight')}`).sort()
      : [];
    checks.ok(
      want.spot === true
        ? `${name}: on-demand up to min_instances, Spot above it`
        : `${name}: Fargate on demand`,
      want.spot === true
        ? attr(service, 'launch_type') !== 'FARGATE' &&
            providers.join() === `FARGATE:${want.min}:0,FARGATE_SPOT:0:1`
        : attr(service, 'launch_type') === 'FARGATE' && providers.length === 0,
      providers.join()
    );
    checks.ok(
      `${name}: a rollover never runs more tasks than max_instances allows for`,
      attr(service, 'deployment_maximum_percent') === 100 &&
        attr(service, 'deployment_minimum_healthy_percent') === 0
    );
    checks.ok(
      `${name}: a failed rollout rolls back`,
      attr(service, 'deployment_circuit_breaker', 0, 'rollback') === true
    );
    checks.ok(
      `${name}: no public address`,
      attr(service, 'network_configuration', 0, 'assign_public_ip') === false
    );
    checks.ok(`${name}: starts at min_instances`, attr(service, 'desired_count') === want.min);
    checks.ok(
      `${name}: a changed secret rolls the service`,
      attr(service, 'force_new_deployment') === true
    );
    const target = ofType(plan, 'aws_appautoscaling_target').find(
      (c) => c.address === `module.workers["${name}"].aws_appautoscaling_target.this`
    );
    checks.ok(
      `${name}: scales between min and max_instances`,
      attr(target, 'min_capacity') === want.min && attr(target, 'max_capacity') === want.max,
      `${attr(target, 'min_capacity')}..${attr(target, 'max_capacity')}`
    );
    const policies = ofType(plan, 'aws_appautoscaling_policy').filter((c) =>
      c.address.startsWith(`module.workers["${name}"]`)
    );
    checks.ok(
      `${name}: ${want.scaled ? 'scales on its queue' : 'does not scale on a queue'}`,
      policies.length === (want.scaled ? 2 : 0),
      String(policies.length)
    );
    checks.ok(
      `${name}: runs as the workers' roles`,
      callReferences(plan, 'workers', 'task_role_arn').includes('module.iam.workers_task_role_arn') &&
        callReferences(plan, 'workers', 'execution_role_arn').includes(
          'module.iam.workers_execution_role_arn'
        )
    );
  }
}

export function checkProcesses(
  plan: Plan,
  checks: Checks,
  want: ProcessExpectation,
  services: Readonly<Record<string, ServiceExpectation>>,
  tickEntry: readonly string[]
): void {
  const out = get(plan.output_changes.processes, 'after') as {
    tick: Record<string, unknown>;
    workers: Record<string, Record<string, unknown>>;
  };
  const common = {
    QCLOUD_NAMESPACE: want.namespace,
    QCLOUD_TRANSPORT: 'aws-sqs',
    QCLOUD_AWS_REGION: want.region,
    QCLOUD_DATABASE_POOLER: want.pooled ? 'transaction' : 'none',
    ...(want.caFile === undefined ? {} : { QCLOUD_DATABASE_TLS_CA_FILE: want.caFile }),
    ...(want.caPem === undefined ? {} : { QCLOUD_DATABASE_TLS_CA: want.caPem }),
    ...(want.tlsMode === undefined ? {} : { QCLOUD_DATABASE_TLS: want.tlsMode }),
  };
  const processes: Array<[string, Record<string, unknown>, readonly string[]]> = [
    ['tick', out.tick, ['QCLOUD_DATABASE_URL']],
    ...Object.entries(out.workers).map(
      ([name, worker]) =>
        [
          name,
          worker,
          want.pooled
            ? ['QCLOUD_DATABASE_LISTEN_URL', 'QCLOUD_DATABASE_URL']
            : ['QCLOUD_DATABASE_URL'],
        ] as [string, Record<string, unknown>, readonly string[]]
    ),
  ];
  checks.ok('the tick and every worker service is described', processes.length === Object.keys(services).length + 1);
  for (const [name, process, secrets] of processes) {
    const env = (process.environment ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(common)) {
      checks.ok(`${name}: ${key}`, env[key] === value, `${env[key]} vs ${value}`);
    }
    checks.ok(
      `${name}: exactly one way of checking the database certificate`,
      Object.keys(env).filter((key) => /^QCLOUD_DATABASE_TLS/.test(key)).length === 1,
      Object.keys(env).filter((key) => /^QCLOUD_DATABASE_TLS/.test(key)).join(', ')
    );
    checks.ok(
      `${name}: a connection string is only ever a secret`,
      !Object.keys(env).some((key) => /DATABASE_(LISTEN_)?URL/.test(key)) &&
        !Object.values(env).some((value) => /postgres(ql)?:\/\//.test(value))
    );
    checks.ok(
      `${name}: its database URLs come from Secrets Manager`,
      same(process.secret_env as string[], secrets),
      String(process.secret_env)
    );
    const pool = name === 'tick' ? want.controlPool : services[name]?.pool;
    checks.ok(
      `${name}: its pool is the one the budget counts`,
      env.QCLOUD_DATABASE_POOL_SIZE === String(pool),
      `${env.QCLOUD_DATABASE_POOL_SIZE} vs ${pool}`
    );
  }
  checks.ok(
    'the tick runs one invocation, not the server (the server verifies Google tokens)',
    same(out.tick.command as string[], ['run']) && same(out.tick.entry_point as string[], tickEntry),
    JSON.stringify([out.tick.entry_point, out.tick.command])
  );
  checks.ok(
    'the tick is bounded in time',
    (out.tick.environment as Record<string, string>).QCLOUD_TICK_MAX_RUN_MS === '20000'
  );
  checks.ok(
    'the tick runs as its own roles',
    callReferences(plan, 'tick', 'task_role_arn').includes('module.iam.tick_task_role_arn') &&
      callReferences(plan, 'tick', 'execution_role_arn').includes('module.iam.tick_execution_role_arn')
  );
}

export function checkScheduler(plan: Plan, checks: Checks): void {
  const [schedule, ...more] = ofType(plan, 'aws_scheduler_schedule');
  checks.ok('one schedule', schedule !== undefined && more.length === 0);
  checks.ok('every minute', attr(schedule, 'schedule_expression') === 'rate(1 minute)');
  checks.ok('on the minute, not spread over a window', attr(schedule, 'flexible_time_window', 0, 'mode') === 'OFF');
  const target = (...path: Array<string | number>) => attr(schedule, 'target', 0, ...path);
  checks.ok(
    'a missed tick is not replayed: the next one is a minute away',
    target('retry_policy', 0, 'maximum_retry_attempts') === 0 &&
      Number(target('retry_policy', 0, 'maximum_event_age_in_seconds')) <= 60,
    JSON.stringify(target('retry_policy'))
  );
  checks.ok(
    'a Fargate task with no public address',
    target('ecs_parameters', 0, 'launch_type') === 'FARGATE' &&
      target('ecs_parameters', 0, 'network_configuration', 0, 'assign_public_ip') === false &&
      target('ecs_parameters', 0, 'task_count') === 1
  );
  checks.ok(
    'it starts the tick family with the scheduler role',
    callReferences(plan, 'scheduler', 'role_arn').includes('module.iam.scheduler_role_arn') &&
      callReferences(plan, 'scheduler', 'task_definition_arn').includes(
        'module.tick.task_definition_arn_without_revision'
      )
  );
}
