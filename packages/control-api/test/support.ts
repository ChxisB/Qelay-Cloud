import { MemoryTransport } from '@qelay-cloud/transport-local';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK, JWTPayload } from 'jose';
import { z } from 'zod';
import { ManualClock } from '../../../test/support/clock';
import type {
  ControlApiDeps,
  ControlApiOptions,
  ControlApp,
  Logger,
  OverviewResponse,
  RequestLog,
  Route,
  StatsResponse,
} from '../src';
import { createControlApi } from '../src';

export const DEV_TOKEN = 'dev-token-0123456789-abcdefghij';
export const ISSUER = 'https://issuer.test/';
export const AUDIENCE = 'qelay-control-api';

export interface Recorded {
  readonly requests: RequestLog[];
  readonly errors: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[];
  readonly warnings: { message: string; fields: Readonly<Record<string, unknown>> | undefined }[];
}

export function recordingLogger(): { logger: Logger; recorded: Recorded } {
  const recorded: Recorded = { requests: [], errors: [], warnings: [] };
  const logger: Logger = {
    request: (record) => recorded.requests.push(record),
    error: (message, fields) => recorded.errors.push({ message, fields }),
    warn: (message, fields) => recorded.warnings.push({ message, fields }),
  };
  return { logger, recorded };
}

/** An OIDC issuer on a loopback port: a JWKS endpoint whose keys a test can add, and a way to sign tokens. */
export class TestIssuer {
  readonly #keys = new Map<string, { publicJwk: JWK; privateKey: CryptoKey; listed: boolean }>();
  readonly #server: ReturnType<typeof Bun.serve>;
  fetches = 0;

  private constructor(readonly clock: ManualClock) {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        this.fetches += 1;
        const listed = [...this.#keys.values()].filter((key) => key.listed);
        return Response.json({ keys: listed.map((key) => key.publicJwk) });
      },
    });
  }

  static async start(clock: ManualClock, kids: readonly string[] = ['k1']): Promise<TestIssuer> {
    const issuer = new TestIssuer(clock);
    for (const kid of kids) await issuer.publish(kid);
    return issuer;
  }

  get jwksUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/jwks.json`;
  }

  /** Generates a signing key. Listed in the JWKS unless `listed` is false (a key the issuer never published). */
  async publish(kid: string, listed = true): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
    this.#keys.set(kid, { publicJwk, privateKey, listed });
  }

  /** Lists a key that was generated unlisted, as the issuer does when it rotates in a new key. */
  list(kid: string): void {
    const key = this.#keys.get(kid);
    if (key === undefined) throw new Error(`test issuer has no key ${kid}`);
    this.#keys.set(kid, { ...key, listed: true });
  }

  /** A signed token. Every claim has a valid default; pass `claims` to change or remove (undefined) one. */
  async token(
    claims: Record<string, unknown> = {},
    options: { kid?: string; alg?: string; expiresInSec?: number; issuedAtSec?: number } = {}
  ): Promise<string> {
    const kid = options.kid ?? 'k1';
    const key = this.#keys.get(kid);
    if (key === undefined) throw new Error(`test issuer has no key ${kid}`);
    const nowSec = Math.floor(this.clock.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'user-1',
      roles: ['operator'],
      ...claims,
    };
    for (const [name, value] of Object.entries(payload))
      if (value === undefined) delete payload[name];
    const jwt = new SignJWT(payload as JWTPayload)
      .setProtectedHeader({ alg: options.alg ?? 'ES256', kid })
      .setIssuedAt(options.issuedAtSec ?? nowSec);
    if (!('exp' in claims)) jwt.setExpirationTime(nowSec + (options.expiresInSec ?? 300));
    return jwt.sign(key.privateKey);
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }
}

/** A readiness probe set whose answers a test sets. */
export function fakeReadiness(
  overrides: Partial<ControlApiDeps['readiness']> = {}
): ControlApiDeps['readiness'] {
  return {
    database: async () => {},
    transport: () => 'ok',
    tick: async () => null,
    ...overrides,
  };
}

const echo = z.object({ name: z.string().min(1) });

/** Routes the tests register, one of each kind the real groups will: read, write, slow, failing. */
export function testRoutes(extra: readonly Route[] = []): Route[] {
  return [
    { method: 'GET', path: '/test/read', access: 'read', handle: () => ({ ok: true }) },
    {
      method: 'POST',
      path: '/test/write',
      access: 'write',
      handle: async (context) => ({ name: (await context.json(echo)).name }),
    },
    {
      method: 'GET',
      path: '/test/slow',
      access: 'read',
      timeoutMs: 20,
      handle: () => new Promise(() => {}),
    },
    {
      method: 'POST',
      path: '/test/slow-write',
      access: 'write',
      timeoutMs: 20,
      handle: () => new Promise(() => {}),
    },
    ...extra,
  ];
}

export interface Harness {
  readonly app: ControlApp;
  readonly clock: ManualClock;
  readonly recorded: Recorded;
  call(
    method: string,
    path: string,
    init?: { token?: string | null; body?: unknown; headers?: Record<string, string>; raw?: string }
  ): Promise<Response>;
}

export function harness(
  options: Partial<ControlApiOptions> = {},
  deps: Partial<ControlApiDeps> = {},
  clock = new ManualClock()
): Harness {
  const { logger, recorded } = recordingLogger();
  const app = createControlApi(
    {
      version: '0.0.0-test',
      production: false,
      devToken: { token: DEV_TOKEN },
      clock,
      logger,
      ...options,
    },
    {
      transport: { name: 'memory', capabilities: new MemoryTransport().capabilities },
      readiness: fakeReadiness(),
      routes: testRoutes(),
      ...deps,
    },
    {}
  );
  return {
    app,
    clock,
    recorded,
    call(method, path, init = {}) {
      const headers = new Headers(init.headers);
      const token = init.token === undefined ? DEV_TOKEN : init.token;
      if (token !== null) headers.set('authorization', `Bearer ${token}`);
      let body: string | undefined;
      if (init.raw !== undefined) body = init.raw;
      else if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
      // A server sets Content-Length from the wire; a Request built in process does not, so set it.
      if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
      const request: RequestInit =
        body === undefined ? { method, headers } : { method, headers, body };
      return app.handle(new Request(`http://api.test${path}`, request));
    },
  };
}

export interface ErrorShape {
  readonly error: { code: string; message: string; details?: Record<string, unknown> };
}

export const bodyOf = async <T = Record<string, unknown>>(response: Response): Promise<T> =>
  (await response.json()) as T;

export const errorOf = (response: Response): Promise<ErrorShape> => bodyOf<ErrorShape>(response);

export const sampleOverview = (): OverviewResponse => ({
  ok: true,
  stats: {
    waiting: 3,
    active: 1,
    delayed: 0,
    completed: 10,
    dlq: 0,
    totalPushed: 14,
    totalPulled: 11,
    totalCompleted: 10,
    totalFailed: 1,
    uptime: 1000,
  },
  throughput: { pushPerSec: 1, pullPerSec: 1, completePerSec: 1, failPerSec: 0 },
  latency: { averages: { push: 2 }, percentiles: { push: { p50: 1, p95: 2, p99: 3 } } },
  memory: { heapUsed: 1, heapTotal: 2, rss: 3 },
  collections: { jobs: 14 },
  workers: { total: 0, active: 0, list: [], truncated: false },
  crons: { total: 0, list: [], truncated: false },
  storage: {},
  timestamp: 1_700_000_000_000,
});

export const sampleStats = (): StatsResponse => ({
  ok: true,
  stats: {
    ...sampleOverview().stats,
    ...sampleOverview().throughput,
    prioritized: 0,
    'waiting-children': 0,
  },
  memory: { heapUsed: 1, heapTotal: 2, rss: 3, external: 0, arrayBuffers: 0 },
  collections: { jobs: 14 },
});

export const read = (api: Harness, token: string | null): Promise<Response> =>
  api.call('GET', '/test/read', { token });

export const write = (api: Harness, token: string): Promise<Response> =>
  api.call('POST', '/test/write', { token, body: { name: 'x' } });
