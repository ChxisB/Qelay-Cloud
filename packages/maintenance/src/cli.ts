import { UnsupportedOptionError } from '@qelay-cloud/core';
import type { DeliveryTransport } from '@qelay-cloud/core';
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import { openTransport } from '@qelay-cloud/transports';
import type { Authenticator } from './auth';
import { oidcAuthenticator, sharedSecretAuthenticator } from './auth';
import { resolveTickConfig, transportWindowMs } from './config';
import type { Settings } from './env';
import { settingsFromEnv } from './env';
import { createTickHandler } from './http';
import { redactor } from './redact';
import type { Telemetry } from './telemetry';
import { runTicks } from './tick';
import { resolveWebhookConfig } from './webhookConfig';
import { resolveWorkflowConfig } from './workflowSweep';

export const USAGE = `usage: qcloud-tick [run | serve]

  run     one invocation of the tick, then exit (Cloud Run Jobs, ECS scheduled tasks).
          Prints the report as one JSON line. Exit 0 when every pass ran and every bell was rung and
          recorded, 1 when the tick or a ring failed, 2 for a configuration error.
  serve   POST /internal/tick on $PORT (default 8080), authenticated, for Cloud Scheduler.

Settings come from the environment: QCLOUD_DATABASE_URL (required), QCLOUD_NAMESPACE,
QCLOUD_TRANSPORT (gcp-pubsub | aws-sqs | postgres), QCLOUD_GCP_PROJECT, QCLOUD_AWS_REGION (aws-sqs),
QCLOUD_AWS_SQS_ENDPOINT (an emulator), QCLOUD_DATABASE_POOLER,
QCLOUD_DATABASE_POOL_SIZE (default 2), QCLOUD_DATABASE_TLS, QCLOUD_DATABASE_TLS_CA_FILE, QCLOUD_DATABASE_TLS_CA, QCLOUD_TICK_* (see docs/limits.md),
QCLOUD_WEBHOOK_KEY (the key webhook secrets are sealed with), QCLOUD_WEBHOOK_DEV_MODE (deliver to http and
private addresses), QCLOUD_WEBHOOK_* (the sender, see docs/webhooks.md; QCLOUD_WEBHOOK_BATCH=0 sends nothing),
QCLOUD_WORKFLOW_* (the workflow step: QUEUE, BATCH, IDLE_MS, WAIT_LEASE_MS, see docs/limits.md; QCLOUD_WORKFLOW_BATCH=0 turns it off), and for serve
QCLOUD_TICK_AUDIENCE with QCLOUD_TICK_ALLOWED_EMAILS, or QCLOUD_TICK_SHARED_SECRET (development).`;

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

export type OpenRuntime = (settings: Settings) => CliRuntime;

export function openRuntime(settings: Settings): CliRuntime {
  const db = openDatabase(settings.database);
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
  options: { readonly open?: OpenRuntime; readonly stopSignal?: AbortSignal } = {}
): Promise<number> {
  const command = argv[0] ?? 'run';
  if (argv.length > 1 || (command !== 'run' && command !== 'serve')) {
    io.err(USAGE);
    return 2;
  }
  const redact = redactor(env);
  let runtime: CliRuntime | null = null;
  try {
    const settings = settingsFromEnv(env);
    const auth = command === 'serve' ? authenticator(env) : null;
    runtime = (options.open ?? openRuntime)(settings);
    const config = resolveTickConfig(runtime.transport, settings.tick, runtime.store);
    const telemetry = telemetryTo(io, redact);
    const webhooks = resolveWebhookConfig(settings.webhooks.sender, settings.webhooks.urlPolicy);
    const workflows = resolveWorkflowConfig(settings.workflows);
    const deps = {
      store: runtime.store,
      transport: runtime.transport,
      telemetry,
      ...(webhooks === null ? {} : { webhooks: { config: webhooks } }),
      ...(workflows === null ? {} : { workflows }),
    };
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
    await runtime?.transport.close?.().catch(() => {});
    await runtime?.store.close({ timeout: 5_000 }).catch(() => {});
  }
}
