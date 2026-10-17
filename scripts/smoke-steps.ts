/**
 * The steps of the smoke test, shared by `smoke-gcp.ts` and `smoke-aws.ts` (tasks 36 and 43): the same
 * run against either cloud, so a difference between them is a difference in the answers, not in the
 * questions. A broker's own checks come in through `Target.broker`, and what only a deployed
 * environment can show (a load balancer in front of the API) through `Target.edge`.
 */
import { EventWatch, Report, call, expect, until } from './smoke-lib';
import { LOCAL_QUEUE, LocalStack } from './smoke-local';

/** What `/capabilities` and `/transport` must say about the broker under test. */
export interface BrokerExpectation {
  readonly name: string;
  readonly maxDeliverDelayMs: number | null;
  /** The broker documents its counts as approximate: the page labels them, and they are read, not null. */
  readonly approximateCounts: boolean;
  /** The `freshness.source` of a reading begins with this. */
  readonly source: string;
}

export interface Target {
  readonly apiUrl: string;
  readonly panelUrl: string | null;
  readonly token: string;
  readonly queue: string;
  readonly production: boolean;
  readonly tickWaitMs: number;
  readonly broker?: BrokerExpectation;
  /** Steps only a deployed environment can take. Runs after the panel's, before the job. */
  readonly edge?: (report: Report, target: Target) => Promise<void>;
  triggerTick(): Promise<string>;
}

const JOB_TIMEOUT_MS = 60_000;

export function parse(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const boolean = name === 'local';
    const value = boolean ? 'true' : (inline ?? argv[(index += 1)]);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, value);
  }
  return flags;
}

export async function common(report: Report, target: Target): Promise<void> {
  const { apiUrl, token } = target;
  await report.step('health is public', async () => {
    const reply = await call(apiUrl, '/health');
    expect(reply.status === 200 && reply.json?.status === 'healthy', `answered ${reply.status}`);
  });
  await report.step('no route but /health answers without a token', async () => {
    for (const path of ['/deployment', '/overview', '/queues', '/health/ready', '/capabilities', '/transport']) {
      const reply = await call(apiUrl, path);
      expect(reply.status === 401, `${path} answered ${reply.status} without a token`);
    }
    const bad = await call(apiUrl, '/deployment', { token: 'not-a-token' });
    expect(bad.status === 401, `a malformed token was answered ${bad.status}`);
  });
  await report.step('ready: database ok, schema current', async () => {
    const reply = await call(apiUrl, '/health/ready', { token });
    expect(reply.status === 200 && reply.json?.ready === true, `ready answered ${reply.status}`);
    expect(reply.json.checks.schema.state === 'current', `schema is ${reply.json.checks.schema.state}`);
    return reply.json.checks.schema;
  }, (schema) => `schema ${schema.current}/${schema.expected}`);
  if (target.panelUrl !== null) await panel(report, target, target.panelUrl);
  await target.edge?.(report, target);

  const watch = await report.step('open the event stream', () =>
    EventWatch.open(apiUrl, `/events/queues/${encodeURIComponent(target.queue)}`, token)
  );
  try {
    const runId = crypto.randomUUID();
    const jobId = await report.step('add a job', async () => {
      const reply = await call(apiUrl, `/queues/${encodeURIComponent(target.queue)}/jobs`, {
        method: 'POST',
        token,
        body: { name: 'smoke', data: { runId } },
      });
      expect(reply.status === 200 && reply.json?.ok === true, `add answered ${reply.status}`);
      return String(reply.json.id);
    }, (id) => `job ${id}`);
    await report.step('the event stream reports it completed', async () => {
      const frame = await watch.waitFor(
        (candidate) => candidate.event === 'job:completed' && candidate.data?.jobId === jobId,
        JOB_TIMEOUT_MS
      );
      return frame.id;
    }, (id) => `at ${id}`);
    await report.step('the job reads back completed', async () => {
      const reply = await call(apiUrl, `/jobs/${encodeURIComponent(jobId)}`, { token });
      expect(reply.status === 200, `read answered ${reply.status}`);
      expect(reply.json.job?.state === 'completed', `the job is ${reply.json.job?.state}`);
    });
    if (target.broker !== undefined) await broker(report, target, target.broker);
  } finally {
    watch.close();
  }
  await tickAndDeployment(report, target);
}

async function broker(report: Report, target: Target, expected: BrokerExpectation): Promise<void> {
  const { apiUrl, token } = target;
  await report.step('/capabilities names the broker and its delay limit', async () => {
    const reply = await call(apiUrl, '/capabilities', { token });
    expect(reply.status === 200, `/capabilities answered ${reply.status}`);
    const { name, maxDeliverDelayMs } = reply.json.transport;
    expect(name === expected.name, `the broker is ${name}`);
    expect(maxDeliverDelayMs === expected.maxDeliverDelayMs, `the delay limit is ${maxDeliverDelayMs} ms`);
    return `${name}, delay limit ${maxDeliverDelayMs} ms`;
  }, (text) => text);
  await report.step('/transport reads the queue from the broker, counts labelled', async () => {
    const reply = await call(apiUrl, '/transport', { token, headers: { 'x-qelay-cache': 'bypass' } });
    expect(reply.status === 200, `/transport answered ${reply.status}`);
    expect(reply.json.transport.name === expected.name, `the page says ${reply.json.transport.name}`);
    expect(
      reply.json.transport.approximateCounts === expected.approximateCounts,
      `approximateCounts is ${reply.json.transport.approximateCounts}`
    );
    const row = reply.json.queues.find((queue: { queue: string }) => queue.queue === target.queue);
    expect(row !== undefined, `${target.queue} is not listed`);
    if (expected.approximateCounts) {
      for (const key of ['doorbellDepth', 'inFlight', 'delayed', 'deadLetterDepth']) {
        expect(typeof row[key] === 'number', `${key} is ${row[key]}, not a number`);
      }
    }
    expect(reply.json.deadLetter.supported === true, 'the broker has no dead-letter queue');
    expect(
      String(row.freshness.source).startsWith(expected.source) && typeof row.freshness.ageMs === 'number',
      `the reading's source is ${row.freshness.source}, its age ${row.freshness.ageMs}`
    );
    return `depth ${row.doorbellDepth}, in flight ${row.inFlight}, delayed ${row.delayed}, dead letters ${row.deadLetterDepth}`;
  }, (text) => text);
}

async function panel(report: Report, target: Target, panelUrl: string): Promise<void> {
  await report.step('panel: /health, /config.json, CSP', async () => {
    expect((await call(panelUrl, '/health')).status === 200, 'panel /health is not 200');
    const config = await call(panelUrl, '/config.json');
    expect(config.status === 200, `/config.json answered ${config.status}`);
    expect(
      new URL(config.json.apiBaseUrl).origin === new URL(target.apiUrl).origin,
      'the panel is configured with another API'
    );
    expect(!JSON.stringify(config.json).includes(target.token), '/config.json carries the token');
    const page = await fetch(new URL('/', panelUrl));
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp.includes(new URL(target.apiUrl).origin), 'the CSP does not allow the API origin');
    expect(!csp.includes("'unsafe-eval'"), "the CSP allows 'unsafe-eval'");
  });
}

async function tickAndDeployment(report: Report, target: Target): Promise<void> {
  const { apiUrl, token } = target;
  const read = async () => {
    const reply = await call(apiUrl, '/deployment', { token, headers: { 'x-qelay-cache': 'bypass' } });
    expect(reply.status === 200, `/deployment answered ${reply.status}`);
    return reply.json;
  };
  const before = await read();
  const how = await report.step('trigger the tick', () => target.triggerTick(), (text) => text);
  void how;
  const after = await report.step('the tick is recorded', () =>
    until('the tick to be recorded', target.tickWaitMs, async () => {
      const now = await read();
      const at = now.tick.lastSuccessAt as number | null;
      return at !== null && at !== before.tick.lastSuccessAt ? now : null;
    }, 1_000),
  (deployment) => `tick ${deployment.tick.state}`);
  await report.step('/deployment: build, schema, database, tick, no secret', async () => {
    expect(after.schema.state === 'current', `schema is ${after.schema.state}`);
    expect(after.database.state === 'ok', `database is ${after.database.state}`);
    expect(after.tick.state === 'ok', `tick is ${after.tick.state}`);
    expect(after.devToken === false, 'the development token is enabled');
    expect(after.production === target.production, `production is ${after.production}`);
    const text = JSON.stringify(after);
    expect(!text.includes('postgres://') && !text.includes(token), '/deployment carries a secret');
    return `${after.version} (${after.commit ?? 'no commit'})`;
  }, (build) => build);
}

export async function localDrills(report: Report, stack: LocalStack, token: string): Promise<void> {
  // A rollback is the previous revision against the migrated database. It must keep serving, and
  // its own migrate step must refuse to touch a schema that is newer than it knows.
  await stack.recordFutureMigration(99);
  await report.drill('rollback: an older build is ready against a newer schema', async () => {
    const reply = await call(stack.apiUrl, '/health/ready', { token });
    expect(reply.status === 200 && reply.json.ready === true, `answered ${reply.status}`);
    expect(reply.json.checks.schema.state === 'ahead', `schema is ${reply.json.checks.schema.state}`);
  });
  await report.drill('rollback: ...and still takes work', async () => {
    const reply = await call(stack.apiUrl, `/queues/${LOCAL_QUEUE}/jobs`, {
      method: 'POST',
      token,
      body: { name: 'after-rollback', data: {} },
    });
    expect(reply.status === 200 && reply.json.ok === true, `add answered ${reply.status}`);
  });
  await report.drill('rollback: migrate refuses a newer schema (exit 1, nothing changed)', async () => {
    const result = await stack.migrate();
    expect(result.code === 1, `exit ${result.code}`);
    expect(result.err.includes('schema_ahead'), 'the refusal is not named schema_ahead');
  });
}

export interface LocalOptions {
  readonly transport: 'postgres' | 'aws-sqs';
  readonly broker?: BrokerExpectation;
}

/** The images' entrypoints as processes over a throwaway schema: what `--local` means for either cloud. */
export async function runLocal(report: Report, options: LocalOptions): Promise<void> {
  const stack = await LocalStack.start({ transport: options.transport });
  try {
    await report.step('start the API on an unmigrated database', () => stack.serveApi());
    const token = await stack.token();
    await report.step('unmigrated: /health 200, /health/ready 503 and says migrate', async () => {
      expect((await call(stack.apiUrl, '/health')).status === 200, '/health is not 200');
      const reply = await call(stack.apiUrl, '/health/ready', { token });
      expect(reply.status === 503, `ready answered ${reply.status}`);
      expect(reply.json.checks.schema.state === 'behind', 'schema is not reported behind');
    });
    await report.step('migrate (the release step)', async () => {
      const result = await stack.migrate();
      expect(result.code === 0, `exit ${result.code}: ${result.err.slice(0, 200)}`);
      const again = await stack.migrate();
      expect(again.code === 0, 'a second migrate is not a no-op');
    });
    stack.startWorker();
    const panelUrl = await stack.servePanel();
    if (panelUrl === null) {
      report.outcomes.push({ name: 'panel', ok: true, detail: 'skipped: packages/panel/dist is not built', ms: 0 });
    }
    await common(report, {
      apiUrl: stack.apiUrl,
      panelUrl,
      token,
      queue: LOCAL_QUEUE,
      production: false,
      ...(options.broker === undefined ? {} : { broker: options.broker }),
      tickWaitMs: 15_000,
      async triggerTick() {
        const result = await stack.tick();
        expect(result.code === 0, `tick exit ${result.code}: ${result.err.slice(0, 200)}`);
        return 'qcloud-tick run';
      },
    });
    await localDrills(report, stack, token);
  } finally {
    await stack.stop();
  }
}
