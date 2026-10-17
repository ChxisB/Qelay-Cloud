/**
 * The queues' own protection, asserted on the plan of `infra/aws/example`: who may use the queue key, and the policy on
 * every queue and dead-letter queue.
 */
import type { Plan, ResourceChange } from './terraform-plan-model';
import type { Checks } from './terraform-plan-model';
import { after, get, ofType } from './terraform-plan-model';
import type { IamExpectation } from './terraform-plan-aws-iam';
import { list, policyOf, same } from './terraform-plan-aws-model';

/** The grants on the queue key: unknown while the plan creates the key, readable once it is given one. */
export function checkKeyGrants(
  plan: Plan,
  checks: Checks,
  want: IamExpectation,
  policies: readonly ResourceChange[]
): void {
  const grants = policies.filter((c) => /_queue_key$/.test(c.name));
  checks.ok('a key grant for the workers and one for the tick', grants.length === 2);
  for (const grant of grants) {
    const policy = policyOf(grant);
    if (want.queueKey === undefined) {
      checks.ok(`${grant.name}: unknown until the key exists`, !policy.known);
      continue;
    }
    const [statement] = policy.known ? policy.statements : [];
    checks.ok(
      `${grant.name}: this key only, for SQS only, to generate and decrypt`,
      policy.known &&
        policy.statements.length === 1 &&
        same(list(statement?.Resource), [want.queueKey]) &&
        same(list(statement?.Action), ['kms:GenerateDataKey', 'kms:Decrypt']) &&
        get(statement, 'Condition', 'StringEquals', 'kms:ViaService') ===
          `sqs.${want.region}.amazonaws.com`,
      JSON.stringify(statement)
    );
  }
  const keyPolicy = ofType(plan, 'aws_kms_key')[0];
  if (keyPolicy !== undefined) {
    const policy = policyOf(keyPolicy);
    checks.ok(
      "the created key's policy delegates to the account's IAM policies and no one else",
      policy.known &&
        policy.statements.length === 1 &&
        get(policy.statements[0], 'Principal', 'AWS') === `arn:aws:iam::${want.account}:root`
    );
    checks.ok('the created key rotates', get(after(keyPolicy), 'enable_key_rotation') === true);
  }
}

/** The queues' own policies: the two task roles let in, everyone else refused the message actions, TLS only. */
export function checkQueuePolicies(plan: Plan, checks: Checks, want: IamExpectation): void {
  const arn = (role: string) => `arn:aws:iam::${want.account}:role/${want.name}-${role}`;
  const main = ofType(plan, 'aws_sqs_queue_policy').filter((c) => c.name === 'main');
  const dead = ofType(plan, 'aws_sqs_queue_policy').filter((c) => c.name === 'dead_letter');
  checks.ok('a policy on every queue', main.length === want.queueArns.length);
  checks.ok('a policy on every dead-letter queue', dead.length === want.deadLetterArns.length);
  for (const queue of main) {
    const policy = policyOf(queue);
    const statements = policy.known ? policy.statements : [];
    const allowed = statements.filter((s) => s.Effect === 'Allow');
    const principals = allowed.flatMap((s) => list((s.Principal as { AWS?: string[] }).AWS));
    checks.ok(
      `${queue.address}: only the two task roles are allowed`,
      same(principals, [arn('workers-task'), arn('tick-task')]),
      principals.join(',')
    );
    const deny = statements.find((s) => s.Sid === 'NobodyElseTouchesMessages');
    checks.ok(
      `${queue.address}: everyone else is refused the four message actions`,
      deny?.Effect === 'Deny' &&
        deny.Principal === '*' &&
        same(list(deny.Action), [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:ChangeMessageVisibility',
          'sqs:SendMessage',
        ]) &&
        same(list(get(deny, 'Condition', 'StringNotEquals', 'aws:PrincipalArn') as string[]), [
          arn('workers-task'),
          arn('tick-task'),
          ...want.additionalPrincipals,
        ]),
      JSON.stringify(deny)
    );
    const tls = statements.find((s) => s.Sid === 'EncryptedTransportOnly');
    checks.ok(
      `${queue.address}: plaintext is refused`,
      tls?.Effect === 'Deny' && get(tls, 'Condition', 'Bool', 'aws:SecureTransport') === 'false'
    );
    checks.ok(
      `${queue.address}: no statement names a resource but its own queue`,
      statements.every((s) => list(s.Resource).length === 1 && want.queueArns.includes(list(s.Resource)[0] ?? ''))
    );
  }
  for (const queue of dead) {
    const policy = policyOf(queue);
    checks.ok(
      `${queue.address}: plaintext is refused, nothing else is said`,
      policy.known &&
        policy.statements.length === 1 &&
        get(policy.statements[0], 'Condition', 'Bool', 'aws:SecureTransport') === 'false'
    );
  }
}
