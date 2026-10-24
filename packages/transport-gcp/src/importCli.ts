import { parseArgs } from 'node:util';
import { PubSub } from '@google-cloud/pubsub';
import { Queue } from 'qelay-cloud';
import type { QueueOptions } from 'qelay-cloud';
import { GRPC_ONLY } from './grpcOnly';
import type { AckingStub, ImportSink } from './importer';
import { importSource, importSubscription } from './importer';
import { projectOf } from './options';
import { PubSubTransport } from './transport';

export const USAGE = `usage: qcloud-import-pubsub --subscription S --queue Q [--job-name N] [--dry-run] [--max N]
                           [--wait SECONDS] [--project P] [--emulator-host HOST:PORT]

Moves the messages of a Pub/Sub subscription into a Qelay queue: each message becomes a job whose id is the message id, so a
second run, or a message delivered twice, adds nothing. A page is stored in one transaction and acked after it commits. The job's
data is the message attributes and, as "body", the message body (JSON when it parses, text otherwise). It stops when the
subscription is empty, after --max messages, or on SIGINT. --dry-run counts and changes nothing.

  --subscription  an id, or projects/<project>/subscriptions/<id>. Use a subscription of its own: this one is drained.
  --queue         the Qelay queue the jobs join. --job-name is their name (default "message").
  --wait          how long one pull waits for a message, default 5. Two pulls in a row that find none end the import.
  --project       default $QCLOUD_GCP_PROJECT. The Qelay doorbell topic is in the same project.
  --emulator-host a Pub/Sub emulator (default $QCLOUD_PUBSUB_EMULATOR_HOST). Without one the tool reaches Google Cloud and
                  refuses to run unless QCLOUD_REAL_CLOUD=1, the owner's go-ahead for anything paid or shared.

Settings come from the environment: QCLOUD_DATABASE_URL (not needed for --dry-run), QCLOUD_NAMESPACE (default "default").
Exit 0 when it finished (one JSON line: pulled, created, acked), 1 when it failed, 2 for a usage or configuration error.`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** What a test replaces: an open store in place of $QCLOUD_DATABASE_URL. */
export interface CliDeps {
  readonly store?: QueueOptions['store'];
}

const SUBSCRIPTION_PATH = /^projects\/([^/]+)\/subscriptions\/[^/]+$/;

/** The sink over a queue: the jobs in one `addBulk`, counting the ones that were not already there. */
export function queueSink(queue: Pick<Queue, 'addBulk'>): ImportSink {
  return async (jobs) => {
    const added = await queue.addBulk(jobs.map((job) => ({ ...job, opts: { ...job.opts } })));
    return { created: added.filter((job) => !job.duplicated).length };
  };
}

class UsageError extends Error {}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps = {},
  signal?: AbortSignal
): Promise<number> {
  try {
    return await run(argv, env, io, deps, signal);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(USAGE);
      return 2;
    }
    io.err(`import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  deps: CliDeps,
  signal: AbortSignal | undefined
): Promise<number> {
  const args = parse(argv);
  const emulatorHost = args['emulator-host'] ?? env.QCLOUD_PUBSUB_EMULATOR_HOST;
  if (emulatorHost === undefined) {
    if (env.QCLOUD_REAL_CLOUD !== '1') {
      throw new UsageError(
        'No --emulator-host: this would reach Google Cloud, which is shared and paid. ' +
          "Set QCLOUD_REAL_CLOUD=1 only with the owner's go-ahead (decision D9)."
      );
    }
    if (env.PUBSUB_EMULATOR_HOST) {
      throw new UsageError(
        'PUBSUB_EMULATOR_HOST is set, which would send the pull to an emulator and not to Google Cloud: unset it, or pass --emulator-host'
      );
    }
  }
  const dryRun = args['dry-run'] === true;
  const databaseUrl = env.QCLOUD_DATABASE_URL;
  if (!dryRun && deps.store === undefined && !databaseUrl) {
    throw new UsageError('QCLOUD_DATABASE_URL is required (or use --dry-run).');
  }
  const namespace = env.QCLOUD_NAMESPACE ?? 'default';
  const given = args.subscription.match(SUBSCRIPTION_PATH);
  const configured = given?.[1] ?? args.project ?? env.QCLOUD_GCP_PROJECT;
  if (configured === undefined && emulatorHost !== undefined) {
    throw new UsageError('Give --project (or QCLOUD_GCP_PROJECT).');
  }

  const pubsub = new PubSub({
    ...GRPC_ONLY,
    ...(configured === undefined ? {} : { projectId: configured }),
    ...(emulatorHost === undefined ? {} : { apiEndpoint: emulatorHost, emulatorMode: true }),
  });
  let transport: PubSubTransport | undefined;
  let queue: Queue | undefined;
  try {
    const project = configured ?? (await projectOf(pubsub));
    const subscription = given
      ? args.subscription
      : `projects/${project}/subscriptions/${args.subscription}`;
    const client = await pubsub.getClientAsync_({ client: 'SubscriberClient' });
    const source = importSource(client as unknown as AckingStub, subscription, args.wait * 1_000);
    let sink: ImportSink = async () => {
      throw new Error('a dry run stores nothing');
    };
    if (!dryRun) {
      transport = new PubSubTransport({
        namespace,
        projectId: project,
        ...(emulatorHost === undefined ? {} : { emulatorHost }),
      });
      queue = new Queue(args.queue, {
        transport,
        // An open store has its namespace already, and the queue refuses to be told one as well.
        ...(deps.store === undefined
          ? { databaseUrl: databaseUrl!, namespace }
          : { store: deps.store }),
      });
      sink = queueSink(queue);
    }
    const report = await importSubscription(source, sink, {
      jobName: args['job-name'],
      dryRun,
      ...(args.max === undefined ? {} : { max: args.max }),
      ...(signal === undefined ? {} : { signal }),
    });
    io.out(JSON.stringify({ subscription, queue: args.queue, dryRun, ...report }));
    return 0;
  } finally {
    await queue?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await pubsub.close().catch(() => undefined);
  }
}

interface Args {
  readonly subscription: string;
  readonly queue: string;
  readonly 'job-name': string;
  readonly 'dry-run': boolean;
  readonly max: number | undefined;
  readonly wait: number;
  readonly project: string | undefined;
  readonly 'emulator-host': string | undefined;
}

function parse(argv: readonly string[]): Args {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        subscription: { type: 'string' },
        queue: { type: 'string' },
        'job-name': { type: 'string', default: 'message' },
        'dry-run': { type: 'boolean', default: false },
        max: { type: 'string' },
        wait: { type: 'string', default: '5' },
        project: { type: 'string' },
        'emulator-host': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (!values.subscription || !values.queue) {
    throw new UsageError('--subscription and --queue are required.');
  }
  const max = values.max === undefined ? undefined : Number(values.max);
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) {
    throw new UsageError('--max must be a whole number, 1 or more.');
  }
  const wait = Number(values.wait);
  if (!Number.isSafeInteger(wait) || wait < 1 || wait > 60) {
    throw new UsageError('--wait must be a whole number of seconds, 1 to 60.');
  }
  return {
    subscription: values.subscription,
    queue: values.queue,
    'job-name': values['job-name'],
    'dry-run': values['dry-run'],
    max,
    wait,
    project: values.project,
    'emulator-host': values['emulator-host'],
  };
}
