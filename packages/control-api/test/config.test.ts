import { describe, expect, test } from 'bun:test';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import {
  ControlApiConfigError,
  controlApiOptionsFromEnv,
  createControlApi,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  listenFromEnv,
  resolveConfig,
  silentLogger,
} from '../src';
import { DEV_TOKEN, fakeReadiness } from './support';

const OIDC = {
  issuer: 'https://issuer.test/',
  audience: 'api',
  jwksUrl: 'https://issuer.test/jwks',
};
const resolve = (options: Parameters<typeof resolveConfig>[0], env = {}) =>
  resolveConfig({ ...options, logger: silentLogger }, env);
const refused = (options: Parameters<typeof resolveConfig>[0], env = {}) => {
  try {
    resolve(options, env);
  } catch (error) {
    expect(error).toBeInstanceOf(ControlApiConfigError);
    return (error as Error).message;
  }
  throw new Error('the configuration was accepted');
};

describe('the development token in production', () => {
  test('startup fails with a clear error when NODE_ENV is production', () => {
    const deps = {
      transport: { name: 'memory', capabilities: new MemoryTransport().capabilities },
      readiness: fakeReadiness(),
    };
    const options = { version: '1', devToken: { token: DEV_TOKEN }, logger: silentLogger };
    expect(() => createControlApi(options, deps, { NODE_ENV: 'production' })).toThrow(
      /development token cannot be enabled in production/
    );
    expect(() => createControlApi({ ...options, production: true }, deps, {})).toThrow(
      ControlApiConfigError
    );
    expect(() => createControlApi(options, deps, { NODE_ENV: 'development' })).not.toThrow();
  });

  test('an explicit production: false does not override NODE_ENV=production', () => {
    expect(
      refused(
        { version: '1', devToken: { token: DEV_TOKEN }, production: false },
        { NODE_ENV: 'production' }
      )
    ).toContain('production');
  });

  test('the error does not repeat the token', () => {
    const message = refused({ version: '1', devToken: { token: DEV_TOKEN }, production: true });
    expect(message).not.toContain(DEV_TOKEN);
  });

  test('through the environment: the same variables that enable it are refused in production', () => {
    const env = { NODE_ENV: 'production', QCLOUD_API_DEV_TOKEN: DEV_TOKEN };
    const options = controlApiOptionsFromEnv(env, '1');
    expect(options.production).toBe(true);
    expect(() => resolve(options, env)).toThrow(/production/);
  });

  test('OIDC alone starts in production', () => {
    expect(resolve({ version: '1', oidc: OIDC, production: true }).production).toBe(true);
  });

  test('a token under 24 characters is refused, without being repeated', () => {
    const message = refused({ version: '1', devToken: { token: 'short-token' } });
    expect(message).toContain('24');
    expect(message).not.toContain('short-token');
  });
});

describe('what must be configured', () => {
  test('no way to authenticate is refused', () => {
    expect(refused({ version: '1' })).toContain('no authentication');
  });

  test('defaults', () => {
    const config = resolve({ version: '1', oidc: OIDC });
    expect(config).toMatchObject({
      production: false,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      rateLimit: { burst: 100, perSecond: 20 },
      devToken: null,
    });
    expect(config.oidc).toMatchObject({
      algorithms: ['RS256', 'ES256'],
      clockToleranceSec: 30,
      roleClaim: 'roles',
      operatorRoles: ['operator'],
      viewerRoles: ['viewer'],
      audience: ['api'],
    });
    expect(config.corsOrigins.size).toBe(0);
  });

  test.each([
    ['an empty audience', { ...OIDC, audience: [] }],
    ['an empty issuer', { ...OIDC, issuer: '' }],
    ['alg none', { ...OIDC, algorithms: ['none'] }],
    ['an HMAC algorithm', { ...OIDC, algorithms: ['RS256', 'HS256'] }],
    ['no algorithm', { ...OIDC, algorithms: [] }],
    ['no operator role value', { ...OIDC, operatorRoles: [] }],
  ])('OIDC settings with %s are refused', (_name, oidc) => {
    refused({ version: '1', oidc });
  });

  test.each([
    ['maxBodyBytes', { maxBodyBytes: 0 }],
    ['requestTimeoutMs', { requestTimeoutMs: -1 }],
    ['a rate limit burst of 0', { rateLimit: { burst: 0, perSecond: 1 } }],
    ['a fractional refill rate', { rateLimit: { burst: 1, perSecond: 0.5 } }],
  ])('%s that is not a positive integer is refused', (_name, extra) => {
    refused({ version: '1', oidc: OIDC, ...extra });
  });
});

describe('the deployment page settings', () => {
  const base = { version: '1', oidc: OIDC };

  test('default to a minute for amber, five for red and two seconds of cache', () => {
    expect(resolve(base).deployment).toEqual({
      commit: null,
      tickLateAfterMs: 60_000,
      tickStaleAfterMs: 300_000,
      tickIntervalMs: null,
      fleet: null,
      cacheMs: 2_000,
      maxQueues: 50,
    });
  });

  test('are taken as given', () => {
    const deployment = {
      commit: 'a1b2c3d',
      tickLateAfterMs: 5_000,
      tickStaleAfterMs: 15_000,
      tickIntervalMs: 60_000,
      fleet: { workers: 3, poolSize: 2 },
      cacheMs: 0,
      maxQueues: 10,
    };
    expect(resolve({ ...base, deployment }).deployment).toEqual(deployment);
  });

  test.each([
    ['a commit with a slash', { commit: 'a/b' }],
    ['a commit with a space', { commit: 'a b' }],
    ['an empty commit', { commit: '' }],
    ['a commit longer than 64 characters', { commit: 'a'.repeat(65) }],
    ['a stale threshold not above the late one', { tickLateAfterMs: 9, tickStaleAfterMs: 9 }],
    ['a late threshold of 0', { tickLateAfterMs: 0 }],
    ['a tick interval of 0', { tickIntervalMs: 0 }],
    ['a negative worker count', { fleet: { workers: -1 } }],
    ['a fractional worker count', { fleet: { workers: 1.5 } }],
    ['a negative cache time', { cacheMs: -1 }],
    ['a queue cap of 0', { maxQueues: 0 }],
  ])('%s is refused', (_name, deployment) => {
    refused({ ...base, deployment });
  });
});

describe('the JWKS URL', () => {
  const url = (jwksUrl: string, production = false) => ({
    version: '1',
    oidc: { ...OIDC, jwksUrl },
    production,
  });

  test('https is accepted everywhere', () => {
    expect(() => resolve(url('https://login.example.com/keys', true))).not.toThrow();
  });

  test.each(['http://login.example.com/keys', 'ftp://x/keys', 'not a url'])(
    '%s is refused',
    (jwksUrl) => {
      refused(url(jwksUrl));
    }
  );

  test('plain http to loopback is accepted outside production only', () => {
    expect(() => resolve(url('http://127.0.0.1:9000/keys'))).not.toThrow();
    expect(() => resolve(url('http://localhost:9000/keys'))).not.toThrow();
    refused(url('http://127.0.0.1:9000/keys', true));
  });
});

describe('the CORS allow-list', () => {
  const origins = (...list: string[]) => ({ version: '1', oidc: OIDC, corsOrigins: list });

  test('exact origins are accepted', () => {
    const config = resolve(origins('https://panel.example.com', 'http://localhost:5173'));
    expect([...config.corsOrigins]).toEqual(['https://panel.example.com', 'http://localhost:5173']);
  });

  test.each([
    '*',
    'null',
    'https://panel.example.com/',
    'https://panel.example.com/app',
    'panel.example.com',
    'https://*.example.com',
    '',
  ])('%j is refused', (origin) => {
    refused(origins(origin));
  });
});

describe('the environment', () => {
  const full = {
    NODE_ENV: 'production',
    QCLOUD_API_OIDC_ISSUER: 'https://issuer.test/',
    QCLOUD_API_OIDC_AUDIENCE: 'one, two',
    QCLOUD_API_OIDC_JWKS_URL: 'https://issuer.test/jwks',
    QCLOUD_API_OIDC_ALGORITHMS: 'ES256',
    QCLOUD_API_OIDC_CLOCK_TOLERANCE_SEC: '5',
    QCLOUD_API_ROLE_CLAIM: 'groups',
    QCLOUD_API_OPERATOR_ROLES: 'ops,admin',
    QCLOUD_API_VIEWER_ROLES: 'readers',
    QCLOUD_API_CORS_ORIGINS: 'https://a.example.com, https://b.example.com',
    QCLOUD_API_MAX_BODY_BYTES: '4096',
    QCLOUD_API_REQUEST_TIMEOUT_MS: '9000',
    QCLOUD_API_RATE_LIMIT_BURST: '10',
    QCLOUD_API_RATE_LIMIT_PER_SECOND: '2',
  };

  test('every setting is read', () => {
    const config = resolve(controlApiOptionsFromEnv(full, '1.2.3'), full);
    expect(config).toMatchObject({
      version: '1.2.3',
      production: true,
      maxBodyBytes: 4096,
      requestTimeoutMs: 9000,
      rateLimit: { burst: 10, perSecond: 2 },
    });
    expect(config.oidc).toMatchObject({
      audience: ['one', 'two'],
      algorithms: ['ES256'],
      clockToleranceSec: 5,
      roleClaim: 'groups',
      operatorRoles: ['ops', 'admin'],
      viewerRoles: ['readers'],
    });
    expect([...config.corsOrigins]).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  test('a partial OIDC setting is refused and names the missing variable', () => {
    expect(() => controlApiOptionsFromEnv({ QCLOUD_API_OIDC_ISSUER: 'https://i/' }, '1')).toThrow(
      /QCLOUD_API_OIDC_AUDIENCE is required/
    );
  });

  test('a number that is not a number is refused and names the variable, not the value', () => {
    const run = () => controlApiOptionsFromEnv({ QCLOUD_API_MAX_BODY_BYTES: '12abc' }, '1');
    expect(run).toThrow(/QCLOUD_API_MAX_BODY_BYTES must be a non-negative integer/);
    expect(run).not.toThrow(/12abc/);
  });

  test('a rate limit of 0 turns the limiter off', () => {
    const env = { QCLOUD_API_DEV_TOKEN: DEV_TOKEN, QCLOUD_API_RATE_LIMIT_BURST: '0' };
    expect(resolve(controlApiOptionsFromEnv(env, '1'), env).rateLimit).toBeNull();
  });

  test('the development token role is checked', () => {
    const env = { QCLOUD_API_DEV_TOKEN: DEV_TOKEN, QCLOUD_API_DEV_TOKEN_ROLE: 'root' };
    expect(() => controlApiOptionsFromEnv(env, '1')).toThrow(/QCLOUD_API_DEV_TOKEN_ROLE/);
    const viewer = controlApiOptionsFromEnv({ ...env, QCLOUD_API_DEV_TOKEN_ROLE: 'viewer' }, '1');
    expect(viewer.devToken).toEqual({ token: DEV_TOKEN, role: 'viewer' });
  });

  test('empty variables count as unset', () => {
    const env = {
      QCLOUD_API_DEV_TOKEN: DEV_TOKEN,
      QCLOUD_API_CORS_ORIGINS: '',
      QCLOUD_API_OIDC_ISSUER: '',
    };
    expect(resolve(controlApiOptionsFromEnv(env, '1'), env).corsOrigins.size).toBe(0);
  });

  test('listen settings default to loopback on 8080 and reject a bad port', () => {
    expect(listenFromEnv({})).toEqual({ hostname: '127.0.0.1', port: 8080 });
    expect(listenFromEnv({ QCLOUD_API_HOST: '0.0.0.0', QCLOUD_API_PORT: '9000' })).toEqual({
      hostname: '0.0.0.0',
      port: 9000,
    });
    expect(() => listenFromEnv({ QCLOUD_API_PORT: '70000' })).toThrow(/port/);
    expect(() => listenFromEnv({ QCLOUD_API_PORT: 'x' })).toThrow(/QCLOUD_API_PORT/);
  });
});
