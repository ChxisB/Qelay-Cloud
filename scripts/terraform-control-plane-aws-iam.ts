/**
 * What `scripts/check-terraform-control-plane-aws.ts` asserts about the identities of `infra/aws/control-plane`:
 * four roles, every statement scoped, the API's reach into the queues exactly what the code calls (ring, read depth,
 * peek at the dead letters, never delete), no credential for the panel or the migration beyond starting up.
 */
import type { Fixture } from './terraform-control-plane-aws-services';
import { find } from './terraform-control-plane-aws-services';
import type { Statement } from './terraform-plan-aws-model';
import { list, policyOf, same } from './terraform-plan-aws-model';
import type { Checks, Plan } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';

export interface IamVariation {
  readonly queueKey?: string;
  readonly secretsKey?: string;
  readonly monitoring: boolean;
  /** The images come from ECR repositories the execution roles may pull from. */
  readonly ecr: boolean;
  readonly migrateSecret: string;
}

/** The only actions with no resource to name: both are documented as taking `*`. */
const RESOURCE_LESS = new Set(['ecr:GetAuthorizationToken', 'cloudwatch:GetMetricData']);
const START_UP = ['RegistryLogin', 'WriteLogs', 'ReadSecrets', 'PullImage', 'DecryptSecrets'];

export function checkIdentities(plan: Plan, checks: Checks, fx: Fixture, v: IamVariation): void {
  const wide = plan.resource_changes.filter((c) =>
    /^aws_iam_(user|group|access_key|policy|policy_attachment|role_policy_attachment|user_policy|group_policy|instance_profile)/.test(c.type)
  );
  checks.ok('no IAM user, group, access key, managed policy or attachment', wide.length === 0, wide.map((c) => c.address).join(', '));

  const roles = ofType(plan, 'aws_iam_role');
  const names = roles.map((r) => String(get(after(r), 'name'))).sort();
  const expected = ['api-execution', 'api-task', 'migrate-execution', 'panel-execution'].map((r) => `${fx.name}-${r}`);
  checks.ok('four roles: the API task and three start-up roles', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
  for (const role of roles) {
    const trust = JSON.parse(String(get(after(role), 'assume_role_policy'))) as { Statement: Statement[] };
    const [one, ...rest] = trust.Statement;
    checks.ok(`${role.address}: one trust statement, AssumeRole by ECS tasks only`, one !== undefined && rest.length === 0 && list(one.Action).join() === 'sts:AssumeRole' && get(one.Principal, 'Service') === 'ecs-tasks.amazonaws.com');
    checks.ok(`${role.address}: the trust names the account (confused deputy)`, get(one, 'Condition', 'StringEquals', 'aws:SourceAccount') === fx.account);
    checks.ok(`${role.address}: no managed policy, no boundary surprises`, list(get(after(role), 'managed_policy_arns') as string[] | undefined).length === 0);
  }
  const api = roles.find((r) => r.name === 'api_task');
  checks.ok('the API task role has the path and name the data plane admits', get(after(api as never), 'name') === `${fx.name}-api-task` && get(after(api as never), 'path') === '/');

  // --- every statement is scoped -------------------------------------------------------------------------------
  const policies = ofType(plan, 'aws_iam_role_policy');
  for (const change of policies) {
    const policy = policyOf(change);
    checks.ok(`${change.address}: the plan can read it whole`, policy.known);
    if (!policy.known) continue;
    for (const s of policy.statements) {
      const where = `${change.address}/${s.Sid ?? '?'}`;
      const actions = list(s.Action);
      const resources = list(s.Resource);
      checks.ok(`${where}: Allow, no wildcard action, no NotAction`, s.Effect === 'Allow' && actions.every((x) => !x.includes('*')) && s.NotAction === undefined, actions.join());
      checks.ok(`${where}: a resource ARN, not *, unless the action takes none`, resources.length > 0 && (!resources.includes('*') || actions.every((x) => RESOURCE_LESS.has(x))), resources.join());
      checks.ok(`${where}: no way to pass or create a role`, actions.every((x) => !x.startsWith('iam:') && !x.startsWith('sts:')));
    }
  }

  // --- the API task: what the code calls and nothing more -------------------------------------------------------
  const statements = (address: string) => {
    const found = policies.find((c) => c.address === address);
    const policy = found === undefined ? undefined : policyOf(found);
    return policy?.known === true ? policy.statements : undefined;
  };
  const queues = statements('aws_iam_role_policy.api_queues');
  const sid = (list_: readonly Statement[] | undefined, id: string) => list_?.find((s) => s.Sid === id);
  const ring = sid(queues, 'RingAndReadDepth');
  const peek = sid(queues, 'PeekDeadLetters');
  const metrics = sid(queues, 'ReadQueueMetrics');
  checks.ok('the API rings and reads depth on the doorbell queues only', same(list(ring?.Action), ['sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:SendMessage']) && same(list(ring?.Resource), fx.queueArns), list(ring?.Resource).join());
  checks.ok('the API peeks at the dead letters and can never delete from them', same(list(peek?.Action), ['sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage']) && same(list(peek?.Resource), fx.deadLetterArns));
  checks.ok('the API never receives, deletes or hides a message on a doorbell queue', !list(ring?.Action).some((a) => /Receive|Delete|ChangeMessageVisibility|Purge/.test(a)));
  checks.ok(v.monitoring ? 'the API reads one CloudWatch metric call, with no resource to name' : 'monitoring_read = false removes the CloudWatch statement', v.monitoring ? same(list(metrics?.Action), ['cloudwatch:GetMetricData']) && same(list(metrics?.Resource), ['*']) : metrics === undefined);
  checks.ok('nothing else in the API policy', (queues ?? []).every((s) => ['RingAndReadDepth', 'PeekDeadLetters', 'ReadQueueMetrics'].includes(s.Sid ?? '')));
  const key = statements('aws_iam_role_policy.api_queue_key[0]');
  if (v.queueKey === undefined) {
    checks.ok('no key grant when the queues use the SQS key', key === undefined && find(plan, 'aws_iam_role_policy', 'api_queue_key') === undefined);
  } else {
    checks.ok('the API may use the queue key through SQS only', key?.length === 1 && same(list(key[0]?.Action), ['kms:GenerateDataKey', 'kms:Decrypt']) && same(list(key[0]?.Resource), [v.queueKey]) && get(key[0], 'Condition', 'StringEquals', 'kms:ViaService') === `sqs.${fx.region}.amazonaws.com`);
  }

  // --- the three start-up roles -----------------------------------------------------------------------------------------
  const logArn = (group: string) => `arn:aws:logs:${fx.region}:${fx.account}:log-group:/qcloud/${fx.name}/${group}:*`;
  for (const [who, secrets] of [['api', [fx.databaseSecret, fx.webhookKeySecret]], ['panel', []], ['migrate', [v.migrateSecret]]] as const) {
    const got = statements(`aws_iam_role_policy.execution["${who}"]`);
    const by = (id: string) => sid(got, id);
    checks.ok(`${who}: writes its own log group and no other`, same(list(by('WriteLogs')?.Resource), [logArn(who)]) && same(list(by('WriteLogs')?.Action), ['logs:CreateLogStream', 'logs:PutLogEvents']), list(by('WriteLogs')?.Resource).join());
    checks.ok(`${who}: reads ${secrets.length === 0 ? 'no secret' : 'only the secrets it uses'}`, secrets.length === 0 ? by('ReadSecrets') === undefined : same(list(by('ReadSecrets')?.Resource), secrets) && same(list(by('ReadSecrets')?.Action), ['secretsmanager:GetSecretValue']), list(by('ReadSecrets')?.Resource).join());
    checks.ok(`${who}: pulls from the named repositories only`, v.ecr ? same(list(by('PullImage')?.Resource), fx.repositories) : by('PullImage') === undefined);
    checks.ok(`${who}: decrypts through Secrets Manager only, and only when there is a key and a secret`, v.secretsKey === undefined || secrets.length === 0 ? by('DecryptSecrets') === undefined : same(list(by('DecryptSecrets')?.Resource), [v.secretsKey]) && get(by('DecryptSecrets'), 'Condition', 'StringEquals', 'kms:ViaService') === `secretsmanager.${fx.region}.amazonaws.com`);
    checks.ok(`${who}: nothing but start-up`, (got ?? []).length > 0 && (got ?? []).every((s) => START_UP.includes(s.Sid ?? '')));
  }
}
