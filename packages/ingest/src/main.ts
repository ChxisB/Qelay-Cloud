import { UnsupportedOptionError } from '@qelay-cloud/core';
import { openDatabase, PostgresStore } from '@qelay-cloud/store-postgres';
import type { Env, IngestSettings } from './config';
import { ingestSettingsFromEnv } from './config';
import { createIngestHandler } from './handler';
import { redactor } from './redact';
import type { RunningIngest } from './server';
import { startIngest } from './server';

export const USAGE = `usage: qcloud-ingest

Serves the public ingest of the event gateway: POST /s/<token> stores a request and offers it to its source's routes.
Settings come from the environment, never from a flag:

  QCLOUD_DATABASE_URL (required), QCLOUD_NAMESPACE, QCLOUD_WEBHOOK_KEY (a source that verifies needs it),
  QCLOUD_DATABASE_POOLER, QCLOUD_DATABASE_POOL_SIZE, QCLOUD_DATABASE_TLS, QCLOUD_DATABASE_TLS_CA_FILE | QCLOUD_DATABASE_TLS_CA,
  QCLOUD_INGEST_HOST (default 127.0.0.1), QCLOUD_INGEST_PORT (default 8081), QCLOUD_INGEST_MAX_BODY_BYTES,
  QCLOUD_INGEST_READ_TIMEOUT_MS, QCLOUD_INGEST_RATE_PER_SOURCE, QCLOUD_INGEST_RATE_GLOBAL, QCLOUD_INGEST_SHUTDOWN_GRACE_MS.

Exit 0 after a drained shutdown, 1 for a failure while running, 2 for a configuration error.`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface MainOptions {
  /** Aborts when the process is asked to stop (SIGTERM, SIGINT). */
  readonly stopSignal?: AbortSignal;
  /** Called once the socket is listening: for tests that bind to port 0. */
  readonly onListening?: (server: RunningIngest) => void;
}

/** Stops accepting connections and gives requests in flight `graceMs` to finish; what is left is closed. */
export async function drain(server: RunningIngest, graceMs: number): Promise<void> {
  const graceful = server.stop(false);
  const timer = setTimeout(() => void server.stop(true), graceMs);
  try {
    await graceful;
  } finally {
    clearTimeout(timer);
  }
}

function openStore(settings: IngestSettings): PostgresStore {
  return new PostgresStore({
    db: openDatabase(settings.database),
    namespace: settings.namespace,
    ...(settings.webhookKey === undefined ? {} : { webhookKey: settings.webhookKey }),
  });
}

/** Runs the service until `stopSignal` aborts, and returns the process exit code. */
export async function main(
  argv: readonly string[],
  env: Env,
  io: CliIo,
  options: MainOptions = {}
): Promise<number> {
  if (argv.length > 0) {
    io.err(USAGE);
    return 2;
  }
  const redact = redactor(env);
  let store: PostgresStore | null = null;
  try {
    const settings = ingestSettingsFromEnv(env);
    store = openStore(settings);
    const handler = createIngestHandler({
      store: store.sources,
      limits: settings.limits,
      log: (entry) => io.err(JSON.stringify(entry)),
    });
    const server = startIngest(handler, { ...settings, ...settings.limits });
    io.err(
      JSON.stringify({
        level: 'info',
        msg: 'listening',
        port: server.port,
        namespace: settings.namespace,
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
    if (error instanceof UnsupportedOptionError) {
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
    await store?.close({ timeout: 5_000 }).catch(() => {});
  }
}
