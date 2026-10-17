/**
 * What `scripts/check-terraform-plan-aws.ts` asserts about the identities of `infra/aws/example`: task 42's "every IAM
 * statement scoped, no `*` resource where an ARN exists". The policies are JSON strings in the plan, and are read
 * whole where Terraform can know them (every one, but the grants on a KMS key that the plan itself creates).
 */
import type { Plan, ResourceChange } from './terraform-plan-model';
import type { Checks } from './terraform-plan-model';
import { after, get, ofType, referencesOf } from './terraform-plan-model';
import type { Statement } from './terraform-plan-aws-model';
import { list, policyOf, same } from './terraform-plan-aws-model';
import { checkKeyGrants, checkQueuePolicies } from './terraform-plan-aws-queue-policies';

export interface IamExpectation {
  readonly account: string;
  readonly region: string;
  readonly name: string;
  readonly logGroups: { readonly workers: readonly string[]; readonly tick: string };
  readonly secrets: { readonly workers: readonly string[]; readonly tick: readonly string[] };
  readonly queueArns: readonly string[];
  readonly deadLetterArns: readonly string[];
  readonly additionalPrincipals: readonly string[];
  readonly repositories: readonly string[];
  /** The key the queues use, when the plan is given one: its grants are then readable. */
  readonly queueKey?: string;
}

/** The only actions with no resource to name: both are documented as taking `*`. */
const RESOURCE_LESS = new Set(['ecr:GetAuthorizationToken', 'cloudwatch:GetMetricData']);


export function checkIdentities(plan: Plan, checks: Checks, want: IamExpectation): void {
  const arn = (role: string) => `arn:aws:iam::${want.account}:role/${want.name}-${role}`;
  const wide = plan.resource_changes.filter((c) =>
    /^aws_iam_(user|group|access_key|policy_attachment|role_policy_attachment|user_policy|group_policy|policy)/.test(
      c.type
    )
  );
  checks.ok(
    'no IAM user, group, access key, managed policy or attachment',
    wide.length === 0,
    wide.map((c) => c.address).join(', ')
  );

  const roles = ofType(plan, 'aws_iam_role').filter((c) => c.address.startsWith('module.iam.'));
  checks.ok('five task and scheduler roles', roles.length === 5, String(roles.length));
  for (const role of roles) {
    const trust = JSON.parse(String(get(after(role), 'assume_role_policy'))) as {
      Statement: Statement[];
    };
    const [one, ...rest] = trust.Statement;
    const service = (one?.Principal as { Service?: string } | undefined)?.Service;
    checks.ok(`${role.name}: one trust statement`, one !== undefined && rest.length === 0);
    checks.ok(
      `${role.name}: only ECS tasks or the scheduler may assume it`,
      service === 'ecs-tasks.amazonaws.com' || service === 'scheduler.amazonaws.com',
      String(service)
    );
    checks.ok(
      `${role.name}: the trust names the account (confused deputy)`,
      get(one, 'Condition', 'StringEquals', 'aws:SourceAccount') === want.account
    );
    checks.ok(
      `${role.name}: no inline or managed policy outside the module's own resources`,
      get(after(role), 'managed_policy_arns') === undefined ||
        list(get(after(role), 'managed_policy_arns') as string[]).length === 0
    );
  }
  const scheduler = roles.find((r) => r.name === 'scheduler');
  checks.ok(
    'the scheduler role trusts this one schedule',
    get(
      JSON.parse(String(get(after(scheduler as ResourceChange), 'assume_role_policy'))),
      'Statement',
      0,
      'Condition',
      'StringEquals',
      'aws:SourceArn'
    ) === `arn:aws:scheduler:${want.region}:${want.account}:schedule/default/${want.name}-tick`
  );

  const policies = ofType(plan, 'aws_iam_role_policy').filter((c) =>
    c.address.startsWith('module.iam.')
  );
  const statementsOf = (name: string) => {
    const found = policies.find((c) => c.name === name);
    const policy = found === undefined ? undefined : policyOf(found);
    return policy?.known === true ? policy.statements : undefined;
  };

  for (const change of policies) {
    const policy = policyOf(change);
    if (!policy.known) continue; // the grants on a key created in this plan: checked in the plan that is given one
    for (const statement of policy.statements) {
      const where = `${change.name}/${statement.Sid ?? '?'}`;
      const actions = list(statement.Action);
      checks.ok(`${where}: Allow`, statement.Effect === 'Allow');
      checks.ok(
        `${where}: no wildcard action`,
        actions.every((a) => !a.includes('*')),
        actions.join(',')
      );
      checks.ok(`${where}: no NotAction`, statement.NotAction === undefined);
      const resources = list(statement.Resource);
      checks.ok(
        `${where}: a resource ARN, not *, unless the action takes none`,
        resources.length > 0 &&
          (!resources.includes('*') || actions.every((a) => RESOURCE_LESS.has(a))),
        resources.join(',')
      );
    }
  }

  const only = (name: string, want_: ReadonlyArray<readonly [readonly string[], readonly string[]]>) => {
    const got = statementsOf(name);
    checks.ok(`${name}: ${want_.length} statements`, got?.length === want_.length, String(got?.length));
    want_.forEach(([actions, resources], at) => {
      checks.ok(
        `${name}[${at}]: actions`,
        same(list(got?.[at]?.Action), actions),
        list(got?.[at]?.Action).join(',')
      );
      checks.ok(
        `${name}[${at}]: resources`,
        same(list(got?.[at]?.Resource), resources),
        list(got?.[at]?.Resource).join(',')
      );
    });
  };

  only('workers_queues', [
    [
      [
        'sqs:GetQueueUrl',
        'sqs:GetQueueAttributes',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:ChangeMessageVisibility',
        'sqs:SendMessage',
      ],
      want.queueArns,
    ],
    [['sqs:GetQueueUrl', 'sqs:GetQueueAttributes'], want.deadLetterArns],
    [['cloudwatch:GetMetricData'], ['*']],
  ]);
  only('tick_queues', [[['sqs:GetQueueUrl', 'sqs:SendMessage'], want.queueArns]]);

  const secretArn = (name: string) =>
    `arn:aws:secretsmanager:${want.region}:${want.account}:secret:${name}-??????`;
  const logArn = (group: string) =>
    `arn:aws:logs:${want.region}:${want.account}:log-group:${group}:*`;
  const execution = (name: string, groups: readonly string[], secrets: readonly string[]) => {
    const got = statementsOf(name);
    const by = (sid: string) => got?.find((s) => s.Sid === sid);
    checks.ok(
      `${name}: the log groups it writes are its own`,
      same(list(by('WriteLogs')?.Resource), groups.map(logArn)),
      list(by('WriteLogs')?.Resource).join(',')
    );
    checks.ok(
      `${name}: the secrets it reads are its own`,
      same(list(by('ReadSecrets')?.Resource), secrets.map(secretArn)),
      list(by('ReadSecrets')?.Resource).join(',')
    );
    checks.ok(
      `${name}: it pulls from the named repositories only`,
      want.repositories.length === 0
        ? by('PullImage') === undefined
        : same(list(by('PullImage')?.Resource), want.repositories)
    );
    checks.ok(
      `${name}: nothing but start-up`,
      (got ?? []).every((s) =>
        ['RegistryLogin', 'WriteLogs', 'ReadSecrets', 'PullImage', 'DecryptSecrets'].includes(
          s.Sid ?? ''
        )
      )
    );
  };
  execution('workers_execution', want.logGroups.workers, want.secrets.workers);
  execution('tick_execution', [want.logGroups.tick], want.secrets.tick);

  const run = statementsOf('scheduler');
  checks.ok('the scheduler may run tasks and pass roles, nothing else', run?.length === 2);
  checks.ok(
    'ecs:RunTask: the tick family only, in the one cluster',
    same(list(run?.[0]?.Action), ['ecs:RunTask']) &&
      same(list(run?.[0]?.Resource), [
        `arn:aws:ecs:${want.region}:${want.account}:task-definition/${want.name}-tick:*`,
      ]) &&
      get(run?.[0], 'Condition', 'ArnEquals', 'ecs:cluster') ===
        `arn:aws:ecs:${want.region}:${want.account}:cluster/${want.name}`,
    JSON.stringify(run?.[0])
  );
  checks.ok(
    "iam:PassRole: the tick's two roles, to ECS tasks only",
    same(list(run?.[1]?.Action), ['iam:PassRole']) &&
      same(list(run?.[1]?.Resource), [arn('tick-task'), arn('tick-execution')]) &&
      get(run?.[1], 'Condition', 'StringEquals', 'iam:PassedToService') ===
        'ecs-tasks.amazonaws.com',
    JSON.stringify(run?.[1])
  );

  // Which role each policy is attached to is in the configuration: the plan does not know a role's id yet.
  for (const [policy, role] of [
    ['workers_queues', 'workers_task'],
    ['tick_queues', 'tick_task'],
    ['workers_execution', 'workers_execution'],
    ['tick_execution', 'tick_execution'],
    ['scheduler', 'scheduler'],
  ] as const) {
    checks.ok(
      `${policy} is attached to ${role}`,
      referencesOf(plan, 'iam', `aws_iam_role_policy.${policy}`, 'role').includes(
        `aws_iam_role.${role}.id`
      )
    );
  }

  checkKeyGrants(plan, checks, want, policies);
  checkQueuePolicies(plan, checks, want);
}
