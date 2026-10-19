import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DeliveryTransport } from '@qelay-cloud/core';
import type { Database } from '@qelay-cloud/store-postgres';
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { openTransport } from '@qelay-cloud/transports';
import type { Authenticator } from './auth';
import { oidcAuthenticator, sharedSecretAuthenticator } from './auth';
import type { TickOptions } from './config';
import { resolveTickConfig, transportWindowMs } from './config';
import type { Settings } from './env';
import { settingsFromEnv } from './env';
import { createTickHandler } from './http';
import { TickLoop } from './loop';
import { redactor } from './redact';
import { runShardLoop, tickDeps } from './shardLoop';
import type { Telemetry } from './telemetry';
import { runTicks } from './tick';
import { resolveWebhookConfig } from './webhookConfig';
import { pooledSending, runWebhookLoop } from './webhookLoop';

export const USAGE = `usage: qcloud-tick [run | serve | loop | send | webhook-writer on|off|status]

  run     one invocation of the tick, then exit (Cloud Run Jobs, ECS scheduled tasks).
          Prints the report as one JSON line. Exit 0 when every pass ran and every bell was rung and
          recorded, 1 when the tick or a ring failed, 2 for a configuration error.
  serve   POST /internal/tick on $PORT (default 8080), authenticated, for Cloud Scheduler.
  loop    the tick as a long-running process: a beat every second (QCLOUD_TICK_INTERVAL_MS), led by one
          process at a time through the tick lease, so run it as one always-on instance or a few for
          failover. The retention steps run every 30 s (QCLOUD_TICK_UPKEEP_EVERY_MS). Keep the
          scheduler-called tick as the safety net and the cron source. Runs until SIGTERM and gives
          the lease up on the way out (docs/limits.md).
  send    the webhook sender alone, as a long-running process: it keeps connections to receivers open,
          caches names and backs off from a receiver that is down (docs/webhooks.md). It does not
          tick, and runs until SIGTERM. Run it next to the tick, which keeps sending a few at a time.
  webhook-writer on|off|status
          switches who makes webhook deliveries: the job's own transaction (off, the default) or
          the sender, from the event journal (on; needed for a webhook's filter and shape). Safe to
          repeat, loses no event either way, and prints the state as one JSON line (docs/webhooks.md).

Settings come from the environment: QCLOUD_DATABASE_URL (required), QCLOUD_NAMESPACE, or for
many databases QCLOUD_SHARDS (namespace=shard pairs) with QCLOUD_SHARD_<NAME>_DATABASE_URL, and for loop
QCLOUD_SHARD in place of QCLOUD_NAMESPACE (one loop for each namespace of a shard, docs/limits.md),
QCLOUD_TRANSPORT (gcp-pubsub | aws-sqs | postgres), QCLOUD_GCP_PROJECT, QCLOUD_AWS_REGION (aws-sqs),
QCLOUD_AWS_SQS_ENDPOINT (an emulator), QCLOUD_DATABASE_POOLER,
QCLOUD_DATABASE_POOL_SIZE (default 2), QCLOUD_DATABASE_TLS, QCLOUD_DATABASE_TLS_CA_FILE, QCLOUD_DATABASE_TLS_CA, QCLOUD_TICK_* (see docs/limits.md),
QCLOUD_WEBHOOK_KEY (the key webhook secrets are sealed with), QCLOUD_WEBHOOK_DEV_MODE (deliver to http and
private addresses), QCLOUD_WEBHOOK_* (the sender, see docs/webhooks.md; QCLOUD_WEBHOOK_BATCH=0 sends nothing),
QCLOUD_WORKFLOW_* (the workflow step: QUEUE, BATCH, IDLE_MS, WAIT_LEASE_MS, see docs/limits.md; QCLOUD_WORKFLOW_BATCH=0 turns it off), and for serve
QCLOUD_TICK_AUDIENCE with QCLOUD_TICK_ALLOWED_EMAILS, or QCLOUD_TICK_SHARED_SECRET (development).`;

/** What `loop` uses where the environment is silent: a one-second beat, a few re-rings, upkeep twice a minute. */
const LOOP_DEFAULTS: TickOptions = {
  intervalMs: 1_000,
  maxStaleRingsPerQueue: 10,
  upkeepEveryMs: 30_000,
};

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** What `main` builds the tick from. Tests replace it to run without a broker. */
export interface CliRuntime {
  readonly store: PostgresStore;
  readonly transport: Pick<DeliveryTransport, 'ring' | 'capabilities'> & {
    close?(): Promise<void>;
  };
}

/** `db` is given when several namespaces tick over one pool (`QCLOUD_SHARD`), and its owner closes it. */
export type OpenRuntime = (settings: Settings, db?: Database) => CliRuntime;

/** What `send` needs: the store, no broker. */
export type OpenSenderStore = (settings: Settings) => PostgresStore;

export function openSenderStore(settings: Settings): PostgresStore {
  return new PostgresStore({
    db: openDatabase(settings.database),
    namespace: settings.namespace,
    ...(settings.webhooks.key === undefined ? {} : { webhookKey: settings.webhooks.key }),
  });
}

export function openRuntime(
  settings: Settings,
  db: Database = openDatabase(settings.database)
): CliRuntime {
  // The store's window is the transport's, and a transport needs the store's doorbell for its
  // polling, so the store is built twice over one database: first to read from, then to tick with.
  const reader = new PostgresStore({ db, namespace: settings.namespace });
  // The tick only rings: it never asks for queue statistics, so it needs no CloudWatch.
  const transport = openTransport(settings, {
    namespace: settings.namespace,
    local: { db, source: reader.doorbell },
    ringOnly: true,
  });
  return {
    store: new PostgresStore({
      db,
      namespace: settings.namespace,
      ringWindowMs: transportWindowMs(transport),
      ...(settings.webhooks.key === undefined ? {} : { webhookKey: settings.webhooks.key }),
      ...(settings.webhooks.keepMs === undefined
        ? {}
        : { webhookKeepMs: settings.webhooks.keepMs }),
    }),
    transport,
  };
}

function authenticator(env: Readonly<Record<string, string | undefined>>): Authenticator {
  const secret = env.QCLOUD_TICK_SHARED_SECRET;
  const audience = env.QCLOUD_TICK_AUDIENCE;
  if (audience !== undefined && audience !== '') {
    const emails = (env.QCLOUD_TICK_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim())
      .filter((email) => email !== '');
    return oidcAuthenticator({ audience, allowedEmails: emails });
  }
  if (secret !== undefined && secret !== '') return sharedSecretAuthenticator(secret);
  throw new UnsupportedOptionError(
    'QCLOUD_TICK_AUDIENCE',
    'is required to serve: set it with QCLOUD_TICK_ALLOWED_EMAILS, or QCLOUD_TICK_SHARED_SECRET for development'
  );
}

/**
 * Errors go to stderr as one JSON line each, with the step and the message and nothing else, and
 * with every credential of the environment removed (`redact`).
 */
function telemetryTo(io: CliIo, redact: (text: string) => string): Telemetry {
  return {
    duration() {},
    gauge() {},
    error(step, error) {
      io.err(
        JSON.stringify({
          level: 'error',
          step,
          error: redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        })
      );
    },
  };
}

export interface ServeHandle {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Runs the command and returns the process exit code. `serve` returns only when `stopSignal`
 * aborts (the process gets SIGTERM). `open` is replaceable for tests.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  options: {
    readonly open?: OpenRuntime;
    readonly openStore?: OpenSenderStore;
    readonly stopSignal?: AbortSignal;
  } = {}
): Promise<number> {
  const command = argv[0] ?? 'run';
  const action = argv[1];
  const known =
    command === 'webhook-writer'
      ? argv.length === 2 && (action === 'on' || action === 'off' || action === 'status')
      : argv.length <= 1 &&
        (command === 'run' || command === 'serve' || command === 'loop' || command === 'send');
  if (!known) {
    io.err(USAGE);
    return 2;
  }
  const redact = redactor(env);
  let runtime: CliRuntime | null = null;
  let sender: PostgresStore | null = null;
  let closePool: (() => void) | null = null;
  try {
    const settings = settingsFromEnv(env, command === 'loop' ? LOOP_DEFAULTS : undefined);
    if (settings.shard !== undefined && command !== 'loop') {
      throw new UnsupportedOptionError(
        'QCLOUD_SHARD',
        'is for loop only: run, serve, send and webhook-writer work on one namespace (QCLOUD_NAMESPACE)'
      );
    }
    if (command === 'webhook-writer') {
      sender = (options.openStore ?? openSenderStore)(settings);
      const { webhooks } = sender;
      const state =
        action === 'on'
          ? await webhooks.startWriter()
          : action === 'off'
            ? await webhooks.stopWriter()
            : await webhooks.writerState();
      io.out(JSON.stringify(state));
      return 0;
    }
    if (command === 'send') {
      const webhooks = resolveWebhookConfig(settings.webhooks.sender, settings.webhooks.urlPolicy);
      if (webhooks === null) {
        throw new UnsupportedOptionError(
          'QCLOUD_WEBHOOK_BATCH',
          'is 0, so there is nothing for send to do'
        );
      }
      sender = (options.openStore ?? openSenderStore)(settings);
      const pooled = pooledSending(webhooks);
      closePool = pooled.close;
      io.err(JSON.stringify({ level: 'info', message: 'sending webhooks' }));
      await runWebhookLoop(
        sender,
        pooled.sending,
        telemetryTo(io, redact),
        options.stopSignal ?? new AbortController().signal
      );
      return 0;
    }
    const auth = command === 'serve' ? authenticator(env) : null;
    const telemetry = telemetryTo(io, redact);
    if (settings.shard !== undefined) {
      await runShardLoop(
        { ...settings, shard: settings.shard },
        options.open ?? openRuntime,
        telemetry,
        io,
        options.stopSignal
      );
      return 0;
    }
    runtime = (options.open ?? openRuntime)(settings);
    const config = resolveTickConfig(runtime.transport, settings.tick, runtime.store);
    const deps = tickDeps(runtime, settings, telemetry);
    if (command === 'loop') {
      const loop = new TickLoop(deps, settings.tick);
      loop.start();
      io.err(
        JSON.stringify({ level: 'info', message: 'ticking', intervalMs: loop.config.intervalMs })
      );
      await new Promise<void>((resolve) => {
        if (options.stopSignal?.aborted) resolve();
        options.stopSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await loop.stop();
      return 0;
    }
    if (auth === null) {
      const report = await runTicks(deps, config);
      io.out(JSON.stringify(report));
      return report.ok ? 0 : 1;
    }
    const handler = createTickHandler({
      authenticate: auth,
      run: () => runTicks(deps, config),
      telemetry,
    });
    const port = Number(env.PORT ?? 8080);
    const server = Bun.serve({ port, hostname: env.QCLOUD_TICK_HOST ?? '0.0.0.0', fetch: handler });
    io.err(JSON.stringify({ level: 'info', message: 'serving', port: server.port }));
    await new Promise<void>((resolve) => {
      if (options.stopSignal?.aborted) resolve();
      options.stopSignal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await server.stop();
    return 0;
  } catch (error) {
    if (error instanceof UnsupportedOptionError) {
      io.err(redact(`${error.name}: ${error.message}`));
      io.err(USAGE);
      return 2;
    }
    telemetryTo(io, redact).error('tick', error);
    return 1;
  } finally {
    closePool?.();
    await runtime?.transport.close?.().catch(() => {});
    await runtime?.store.close({ timeout: 5_000 }).catch(() => {});
    await sender?.close({ timeout: 5_000 }).catch(() => {});
  }
}
