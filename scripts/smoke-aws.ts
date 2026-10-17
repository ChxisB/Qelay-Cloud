#!/usr/bin/env bun
/**
 * The smoke test of a control plane on AWS (task 43): the steps of `smoke-gcp.ts` (`smoke-steps.ts`),
 * with SQS as the broker. It signs in, adds a job, watches it complete over the event stream, checks
 * `/capabilities` (the 15-minute delay limit) and `/transport` (counts labelled approximate), triggers
 * the tick and reads `/deployment`.
 *
 *   bun run scripts/smoke-aws.ts --local
 *       The same entrypoints the images run, as processes on this machine: a throwaway schema of a
 *       local Postgres ($QCLOUD_SMOKE_DATABASE_URL, else $QCLOUD_TEST_DATABASE_URL), SQS on a loopback
 *       ElasticMQ ($QCLOUD_SQS_ENDPOINT, default http://127.0.0.1:59324), a loopback issuer. It also runs
 *       the migration and rollback drills. It does not build or run a container, it is not SQS, and it
 *       never talks to AWS (the endpoint must be a loopback address).
 *
 *   QCLOUD_SMOKE_TOKEN=<an OIDC access token of a test principal with the operator role> \
 *   bun run scripts/smoke-aws.ts --api-url https://<api_hostname> \
 *       [--panel-url https://<panel_hostname>] [--queue qcloud-smoke] [--tick-wait-sec 150] \
 *       [--idle-seconds 60] \
 *       [--tick-cluster <cluster arn> --tick-task <task family> --subnets <id,id> --security-groups <id> --region <r>]
 *       A deployed environment (needs the go-ahead for decision D9: this script is not run by a task).
 *       The queue needs a worker that completes jobs. It also checks that port 80 redirects to HTTPS and
 *       that an event stream stays open past the load balancer's idle timeout (--idle-seconds is that
 *       timeout: the check holds a stream for that long plus 15 s). With --tick-task the tick is started
 *       with `aws ecs run-task` (a write to your account: it runs one task); without it the script waits
 *       for the scheduler's next run. The token is read from the environment, sent only as an
 *       Authorization header, and never printed.
 *
 * Exit 0: every check passed. 1: a check failed. 2: usage.
 */
import type { BrokerExpectation, Target } from './smoke-steps';
import { common, parse, runLocal } from './smoke-steps';
import { EventWatch, Report, SmokeFailure, expect } from './smoke-lib';

/** SQS: 15 minutes at most before a bell is due, counts that are estimates, read from the queue's attributes. */
const SQS: BrokerExpectation = {
  name: 'aws-sqs',
  maxDeliverDelayMs: 900_000,
  approximateCounts: true,
  source: 'sqs-queue-attributes',
};

/** What a load balancer in front of the API can break: the redirect, and a stream cut by its idle timeout. */
function edgeSteps(idleSeconds: number) {
  return async (report: Report, target: Target): Promise<void> => {
    const api = new URL(target.apiUrl);
    if (api.protocol === 'https:') {
      await report.step('port 80 redirects to HTTPS', async () => {
        const reply = await fetch(`http://${api.host}/health`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
        const location = reply.headers.get('location') ?? '';
        expect(reply.status === 301 && location.startsWith('https://'), `answered ${reply.status} ${location}`);
      });
    }
    await report.step('an event stream outlives the load balancer idle timeout', async () => {
      const watch = await EventWatch.open(target.apiUrl, `/events/queues/${encodeURIComponent(target.queue)}`, target.token);
      try {
        await Bun.sleep((idleSeconds + 15) * 1_000);
        expect(watch.ended === null, `the stream ended: ${watch.ended?.message}`);
      } finally {
        watch.close();
      }
    }, () => `held ${idleSeconds + 15} s`);
  };
}

async function startTick(flags: Map<string, string>): Promise<string> {
  const need = (name: string) => {
    const value = flags.get(name);
    if (value === undefined) throw new Error(`--tick-task needs --${name}`);
    return value;
  };
  const network = `awsvpcConfiguration={subnets=[${need('subnets')}],securityGroups=[${need('security-groups')}],assignPublicIp=DISABLED}`;
  const child = Bun.spawn(
    [
      'aws', 'ecs', 'run-task', '--cluster', need('tick-cluster'), '--task-definition', need('tick-task'),
      '--launch-type', 'FARGATE', '--count', '1', '--network-configuration', network, '--region', need('region'),
      '--query', 'tasks[0].taskArn', '--output', 'text',
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const code = await child.exited;
  expect(code === 0, `aws ecs run-task exited ${code}`);
  return `aws ecs run-task ${need('tick-task')}`;
}

async function runDeployed(report: Report, flags: Map<string, string>): Promise<void> {
  const token = process.env.QCLOUD_SMOKE_TOKEN;
  if (token === undefined || token === '') throw new Error('QCLOUD_SMOKE_TOKEN is not set');
  const apiUrl = flags.get('api-url');
  if (apiUrl === undefined) throw new Error('--api-url is required (or --local)');
  const trigger = flags.has('tick-task');
  await common(report, {
    apiUrl,
    panelUrl: flags.get('panel-url') ?? null,
    token,
    queue: flags.get('queue') ?? 'qcloud-smoke',
    production: true,
    tickWaitMs: Number(flags.get('tick-wait-sec') ?? '150') * 1_000,
    broker: SQS,
    edge: edgeSteps(Number(flags.get('idle-seconds') ?? '60')),
    triggerTick: () => (trigger ? startTick(flags) : Promise.resolve("waiting for the scheduler's next run")),
  });
}

let flags: Map<string, string>;
try {
  flags = parse(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  console.error('usage: bun run scripts/smoke-aws.ts --local | --api-url <url> (see the file header)');
  process.exit(2);
}

const report = new Report();
try {
  if (flags.has('local')) await runLocal(report, { transport: 'aws-sqs', broker: SQS });
  else await runDeployed(report, flags);
} catch (error) {
  if (!(error instanceof SmokeFailure)) {
    console.error(error instanceof Error ? error.message : String(error));
    if (report.outcomes.length > 0) report.print((line) => console.log(line));
    process.exit(2);
  }
}
report.print((line) => console.log(line));
process.exit(report.failed ? 1 : 0);
