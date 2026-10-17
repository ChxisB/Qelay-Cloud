/**
 * The local stack `smoke-gcp.ts --local` and `smoke-aws.ts --local` run against: the same entrypoints
 * the images run (`qcloud-api serve|migrate`, `qcloud-tick run`, the panel's server), as processes on
 * this machine, over a throwaway schema of a local Postgres, with a loopback issuer in place of an
 * identity provider. The doorbell is the Postgres-backed one (`transport: 'postgres'`, in place of
 * Pub/Sub) or SQS on a loopback ElasticMQ (`'aws-sqs'`, in place of SQS). It is not the container:
 * the Dockerfiles are not built here, and an emulator is not the cloud.
 */
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { startLocalIssuer } from '../packages/control-api/test/localIssuer';
import type { LocalIssuer } from '../packages/control-api/test/localIssuer';
import { transportWindowMs } from '../packages/maintenance/src';
import { Worker } from '../packages/sdk/src';
import { openDatabase, PostgresStore } from '../packages/store-postgres/src';
import { ensureQueue, removeQueue, SqsTransport } from '../packages/transport-aws/src';
import { PostgresLocalTransport } from '../packages/transport-local/src';
import { until } from './smoke-lib';

const ROOT = resolve(import.meta.dir, '..');
export const LOCAL_QUEUE = 'smoke';
const DEFAULT_URL = 'postgres://qcloud:qcloud@127.0.0.1:55432/qcloud_test';
const SQS_ENDPOINT = process.env.QCLOUD_SQS_ENDPOINT ?? 'http://127.0.0.1:59324';
const SQS_REGION = 'us-east-1';
const SQS_CREDENTIALS = { accessKeyId: 'qcloud-smoke', secretAccessKey: 'qcloud-smoke' };

export interface LocalStackOptions {
  readonly transport: 'postgres' | 'aws-sqs';
}

export interface ProcessResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function requireLoopback(endpoint: string): void {
  const { hostname } = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error(`the local smoke test only talks to a loopback SQS emulator, not ${hostname}`);
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

export class LocalStack {
  readonly completed: string[] = [];
  apiUrl = '';
  panelUrl: string | null = null;
  schema = '';
  #databaseUrl = '';
  #admin!: SQL;
  #issuer!: LocalIssuer;
  #api: ReturnType<typeof Bun.spawn> | null = null;
  #panel: ReturnType<typeof Bun.spawn> | null = null;
  #port = 0;
  #transport: LocalStackOptions['transport'] = 'postgres';
  #namespace = 'smoke';
  #sqs: SQSClient | null = null;
  #worker: { worker: Worker<unknown, unknown>; close(): Promise<void> } | null = null;

  static async start(options: LocalStackOptions = { transport: 'postgres' }): Promise<LocalStack> {
    // Before anything is created: an endpoint that is not loopback must cost nothing.
    if (options.transport === 'aws-sqs') requireLoopback(SQS_ENDPOINT);
    const stack = new LocalStack();
    stack.#transport = options.transport;
    stack.#databaseUrl =
      process.env.QCLOUD_SMOKE_DATABASE_URL ?? process.env.QCLOUD_TEST_DATABASE_URL ?? DEFAULT_URL;
    stack.schema = `qcloud_smoke_${randomBytes(6).toString('hex')}`;
    stack.#admin = new SQL({ url: stack.#databaseUrl, max: 1, connectionTimeout: 5 });
    await stack.#admin.unsafe(`CREATE SCHEMA ${stack.schema}`);
    stack.#issuer = await startLocalIssuer();
    if (options.transport === 'aws-sqs') await stack.#provisionQueue();
    return stack;
  }

  /** The queue's doorbell and dead-letter queue on the emulator, under a namespace of this run's own. */
  async #provisionQueue(): Promise<void> {
    this.#namespace = `smoke-${this.schema.slice(-6)}`;
    this.#sqs = new SQSClient({
      endpoint: SQS_ENDPOINT,
      region: SQS_REGION,
      credentials: SQS_CREDENTIALS,
      maxAttempts: 1,
    });
    try {
      await ensureQueue(this.#sqs, this.#namespace, LOCAL_QUEUE);
    } catch (error) {
      await this.stop();
      throw new Error(
        `the SQS emulator is not reachable at ${SQS_ENDPOINT} (${(error as Error).message}); start ElasticMQ with ` +
          '`docker compose -f docker-compose.test.yml --profile sqs up -d --wait sqs` or set QCLOUD_SQS_ENDPOINT'
      );
    }
  }

  token(claims: Record<string, unknown> = {}): Promise<string> {
    return this.#issuer.token(claims);
  }

  /** The environment of one of our processes: nothing is inherited but what is named here. */
  #env(extra: Record<string, string>): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      QCLOUD_DATABASE_URL: this.#databaseUrl,
      QCLOUD_DATABASE_SCHEMA: this.schema,
      QCLOUD_NAMESPACE: this.#namespace,
      QCLOUD_VERSION: 'smoke',
      ...this.#transportEnv(),
      ...extra,
    };
  }

  /** What a process needs to reach the broker. Fixed dummy credentials: nothing of the developer's reaches an emulator. */
  #transportEnv(): Record<string, string> {
    if (this.#transport === 'postgres') return { QCLOUD_TRANSPORT: 'postgres' };
    return {
      QCLOUD_TRANSPORT: 'aws-sqs',
      QCLOUD_AWS_REGION: SQS_REGION,
      QCLOUD_AWS_SQS_ENDPOINT: SQS_ENDPOINT,
      AWS_ACCESS_KEY_ID: SQS_CREDENTIALS.accessKeyId,
      AWS_SECRET_ACCESS_KEY: SQS_CREDENTIALS.secretAccessKey,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_CONFIG_FILE: '/dev/null',
    };
  }

  async #run(args: string[], env: Record<string, string>): Promise<ProcessResult> {
    const child = Bun.spawn(['bun', ...args], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out, err };
  }

  /** `qcloud-api migrate`: the release step. */
  migrate(): Promise<ProcessResult> {
    return this.#run(['packages/control-api/src/bin.ts', 'migrate'], this.#env({}));
  }

  /** `qcloud-tick run`: what the scheduler's request does, once. */
  tick(): Promise<ProcessResult> {
    return this.#run(['packages/maintenance/src/bin.ts', 'run'], this.#env({}));
  }

  /** `qcloud-api serve` on a loopback port, signing in against the loopback issuer. */
  async serveApi(): Promise<void> {
    this.#port = await freePort();
    this.apiUrl = `http://127.0.0.1:${this.#port}/`;
    this.#api = Bun.spawn(['bun', 'packages/control-api/src/bin.ts', 'serve'], {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
      env: this.#env({
        QCLOUD_API_HOST: '127.0.0.1',
        QCLOUD_API_PORT: String(this.#port),
        QCLOUD_API_OIDC_ISSUER: this.#issuer.issuer,
        QCLOUD_API_OIDC_AUDIENCE: this.#issuer.audience,
        QCLOUD_API_OIDC_JWKS_URL: this.#issuer.jwksUrl,
        QCLOUD_API_SHUTDOWN_GRACE_MS: '1000',
      }),
    });
    await until('the API to answer /health', 20_000, async () => {
      const reply = await fetch(new URL('/health', this.apiUrl));
      return reply.ok;
    }, 200);
  }

  /** The panel's server, when the static build exists. Null (and a note) when it was not built. */
  async servePanel(): Promise<string | null> {
    if (!existsSync(resolve(ROOT, 'packages/panel/dist/index.html'))) return null;
    const port = await freePort();
    this.#panel = Bun.spawn(['bun', 'packages/panel/serve/main.ts'], {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        QCLOUD_PANEL_HOST: '127.0.0.1',
        QCLOUD_PANEL_PORT: String(port),
        QCLOUD_PANEL_DIST: resolve(ROOT, 'packages/panel/dist'),
        QCLOUD_PANEL_API_BASE_URL: this.apiUrl.replace(/\/$/, ''),
        QCLOUD_PANEL_AUTH_MODE: 'oidc',
        QCLOUD_PANEL_OIDC_AUTHORITY: this.#issuer.issuer,
        QCLOUD_PANEL_OIDC_CLIENT_ID: 'smoke-panel',
      },
    });
    this.panelUrl = `http://127.0.0.1:${port}/`;
    await until('the panel to answer /health', 15_000, async () => {
      return (await fetch(new URL('/health', this.panelUrl!))).ok;
    }, 200);
    return this.panelUrl;
  }

  /** An in-process worker on the queue, over the same schema: stands in for the deployed workers. */
  startWorker(): void {
    const db = openDatabase({
      url: this.#databaseUrl,
      schema: this.schema,
      poolSize: 2,
      applicationName: 'qcloud-smoke-worker',
    });
    const namespace = this.#namespace;
    const reader = new PostgresStore({ db, namespace });
    const transport =
      this.#transport === 'aws-sqs'
        ? new SqsTransport({
            namespace,
            region: SQS_REGION,
            endpoint: SQS_ENDPOINT,
            credentials: SQS_CREDENTIALS,
            waitSeconds: 1,
          })
        : new PostgresLocalTransport({ db, source: reader.doorbell, namespace, pollIntervalMs: 200 });
    const store = new PostgresStore({ db, namespace, ringWindowMs: transportWindowMs(transport) });
    const worker = new Worker<unknown, unknown>(
      LOCAL_QUEUE,
      async (job) => {
        this.completed.push(job.id);
        return { handled: job.name };
      },
      { store, transport, concurrency: 2 }
    );
    this.#worker = {
      worker,
      async close() {
        await worker.close();
        await transport.close().catch(() => {});
        await db.close({ timeout: 2_000 }).catch(() => {});
      },
    };
  }

  /** What a newer release's migration would leave behind: a recorded version this build does not know. */
  async recordFutureMigration(version: number): Promise<void> {
    await this.#admin.unsafe(
      `INSERT INTO ${this.schema}.qcloud_schema_migrations (version, applied_at, checksum)
       VALUES (${version}, 0, 'smoke-future')`
    );
  }

  async stop(): Promise<void> {
    await this.#worker?.close().catch(() => {});
    for (const child of [this.#api, this.#panel]) {
      if (child === null) continue;
      child.kill('SIGTERM');
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      child.kill('SIGKILL');
    }
    await this.#issuer?.stop().catch(() => {});
    if (this.#sqs !== null) {
      await removeQueue(this.#sqs, this.#namespace, LOCAL_QUEUE).catch(() => {});
      this.#sqs.destroy();
    }
    await this.#admin?.unsafe(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`).catch(() => {});
    await this.#admin?.close().catch(() => {});
  }
}
