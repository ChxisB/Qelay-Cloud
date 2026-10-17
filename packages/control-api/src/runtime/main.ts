import { UnsupportedOptionError } from '@qelay-cloud/core';
import { createControlApi } from '../app';
import { ControlApiConfigError } from '../config';
import type { RunningServer } from '../server';
import { startControlApi } from '../server';
import type { CliIo } from './io';
import { migrateCommand } from './migrate';
import type { OpenRuntime, Runtime } from './open';
import { openRuntime } from './open';
import { redactor } from './redact';
import { runtimeSettingsFromEnv } from './settings';

export type { CliIo };

export const USAGE = `usage: qcloud-api [serve | migrate]

serve (the default) serves the Control API on QCLOUD_API_HOST:QCLOUD_API_PORT (default 127.0.0.1:8080).
migrate brings the database to this build's schema and exits (the release step; needs only
QCLOUD_DATABASE_URL and the other QCLOUD_DATABASE_* settings). Settings come from the environment,
never from a flag: see docs/runbooks/deploy-gcp.md for the full table.

  QCLOUD_DATABASE_URL (required), QCLOUD_NAMESPACE, QCLOUD_TRANSPORT (gcp-pubsub | aws-sqs | postgres),
  QCLOUD_GCP_PROJECT, QCLOUD_AWS_REGION (aws-sqs), QCLOUD_AWS_SQS_ENDPOINT (an emulator), QCLOUD_DATABASE_POOLER, QCLOUD_DATABASE_POOL_SIZE, QCLOUD_DATABASE_TLS,
  QCLOUD_DATABASE_TLS_CA_FILE | QCLOUD_DATABASE_TLS_CA, QCLOUD_API_OIDC_ISSUER / _AUDIENCE / _JWKS_URL, QCLOUD_API_CORS_ORIGINS,
  QCLOUD_API_ROLE_CLAIM, QCLOUD_API_OPERATOR_ROLES, QCLOUD_API_VIEWER_ROLES, QCLOUD_COMMIT.
  Workflows: QCLOUD_WORKFLOW_QUEUE and QCLOUD_WORKFLOW_IDLE_MS (as the tick), QCLOUD_API_WORKFLOW_SERVED_MS,
  QCLOUD_API_WORKFLOWS=false (hides the page).

Exit 0 after a drained shutdown (or a migration that left the database current), 1 for a failure
while running, 2 for a configuration error.`;

export interface MainOptions {
  /** Replaceable for tests, to run without a broker. */
  readonly open?: OpenRuntime;
  /** Aborts when the process is asked to stop (SIGTERM, SIGINT). */
  readonly stopSignal?: AbortSignal;
  /** Called once the socket is listening, with the port: for tests that bind to 0. */
  readonly onListening?: (server: RunningServer) => void;
}

/**
 * Stops accepting connections and gives requests in flight `graceMs` to finish. An event stream is
 * a request in flight that never finishes on its own, so what is left at the deadline is closed:
 * its client reconnects, to another instance, with the last event id it saw.
 */
export async function drain(server: RunningServer, graceMs: number): Promise<void> {
  const graceful = server.stop(false);
  const timer = setTimeout(() => void server.stop(true), graceMs);
  try {
    await graceful;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the service until `stopSignal` aborts, and returns the process exit code. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo,
  options: MainOptions = {}
): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (argv.length > 1 || (command !== 'serve' && command !== 'migrate')) {
    io.err(USAGE);
    return 2;
  }
  if (command === 'migrate') return migrateCommand(env, io);
  const redact = redactor(env);
  let runtime: Runtime | null = null;
  try {
    const settings = runtimeSettingsFromEnv(env);
    runtime = (options.open ?? openRuntime)(settings);
    const app = createControlApi(settings.api, runtime.deps, env);
    const server = startControlApi(app, settings.listen);
    io.err(
      JSON.stringify({
        level: 'info',
        msg: 'listening',
        port: server.port,
        namespace: settings.namespace,
        transport: settings.transport,
      })
    );
    options.onListening?.(server);
    await new Promise<void>((resolve) => {
      if (options.stopSignal?.aborted) resolve();
      options.stopSignal?.addEventListener('abort', () => resolve(), { once: true });
    });
    io.err(JSON.stringify({ level: 'info', msg: 'draining', graceMs: settings.shutdownGraceMs }));
    await drain(server, settings.shutdownGraceMs);
    return 0;
  } catch (error) {
    if (error instanceof ControlApiConfigError || error instanceof UnsupportedOptionError) {
      io.err(redact(`${error.name}: ${error.message}`));
      io.err(USAGE);
      return 2;
    }
    io.err(
      JSON.stringify({
        level: 'error',
        msg: 'failed',
        error: redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      })
    );
    return 1;
  } finally {
    await runtime?.close();
  }
}
