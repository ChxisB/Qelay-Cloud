import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { ManualClock } from '../../../test/support/clock';
import type { ControlApiOptions } from '../src';
import { AUDIENCE, DEV_TOKEN, errorOf, harness, ISSUER, read, TestIssuer, write } from './support';

const clock = new ManualClock();
let issuer: TestIssuer;

const oidcOptions = (overrides: Partial<ControlApiOptions['oidc'] & object> = {}) =>
  ({
    oidc: {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: issuer.jwksUrl,
      jwksCooldownMs: 0,
      ...overrides,
    },
    devToken: undefined,
  }) satisfies Partial<ControlApiOptions>;

beforeAll(async () => {
  issuer = await TestIssuer.start(clock, ['k1', 'k2']);
});
afterAll(() => issuer.stop());

describe('OIDC bearer tokens', () => {
  test('a valid operator token reads and writes; a viewer token reads and is refused a write', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const operator = await issuer.token({ roles: ['operator'] });
    const viewer = await issuer.token({ roles: ['viewer'], sub: 'user-2' });
    expect((await read(api, operator)).status).toBe(200);
    expect((await write(api, operator)).status).toBe(200);
    expect((await read(api, viewer)).status).toBe(200);
    const refused = await write(api, viewer);
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).error.code).toBe('forbidden');
  });

  test('an expired token is refused, and the tolerance covers a small skew', async () => {
    const api = harness(oidcOptions({ clockToleranceSec: 30 }), {}, clock);
    const token = await issuer.token({}, { expiresInSec: 60 });
    expect((await read(api, token)).status).toBe(200);
    clock.advance(60_000 + 10_000);
    expect((await read(api, token)).status).toBe(200);
    clock.advance(30_000);
    expect((await read(api, token)).status).toBe(401);
    clock.advance(-100_000);
  });

  test('a token that is not valid yet is refused', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const nbf = Math.floor(clock.now() / 1000) + 600;
    expect((await read(api, await issuer.token({ nbf }))).status).toBe(401);
  });

  test('the wrong audience is refused, and any one listed audience is accepted', async () => {
    const api = harness(oidcOptions(), {}, clock);
    expect((await read(api, await issuer.token({ aud: 'someone-else' }))).status).toBe(401);
    expect((await read(api, await issuer.token({ aud: ['x', AUDIENCE] }))).status).toBe(200);
    const two = harness(oidcOptions({ audience: [AUDIENCE, 'second'] }), {}, clock);
    expect((await read(two, await issuer.token({ aud: 'second' }))).status).toBe(200);
  });

  test('the wrong issuer is refused', async () => {
    const api = harness(oidcOptions(), {}, clock);
    expect((await read(api, await issuer.token({ iss: 'https://evil.test/' }))).status).toBe(401);
  });

  test('a token without exp, or without sub, is refused', async () => {
    const api = harness(oidcOptions(), {}, clock);
    expect((await read(api, await issuer.token({ exp: undefined }))).status).toBe(401);
    expect((await read(api, await issuer.token({ sub: undefined }))).status).toBe(401);
  });

  test('a signature that does not verify is refused', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const token = await issuer.token();
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const flipped = `${signature.slice(0, -4)}${signature.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    expect((await read(api, `${header}.${payload}.${flipped}`)).status).toBe(401);
    const forged = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'x',
        roles: ['operator'],
        exp: 9_999_999_999,
      })
    ).toString('base64url');
    expect((await read(api, `${header}.${forged}.${signature}`)).status).toBe(401);
  });

  test('alg none and symmetric algorithms are refused', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'x',
      roles: ['operator'],
      exp: 9_999_999_999,
    };
    const none = `${encode({ alg: 'none', kid: 'k1' })}.${encode(claims)}.`;
    expect((await read(api, none)).status).toBe(401);
    const secret = new TextEncoder().encode('a-shared-secret-that-is-long-enough-0123');
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(secret);
    expect((await read(api, hs256)).status).toBe(401);
  });

  test('a valid token with no role gets 403, not 401, and the answer does not list roles', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const response = await read(api, await issuer.token({ roles: ['somebody-else'] }));
    expect(response.status).toBe(403);
    const body = await errorOf(response);
    expect(body.error.code).toBe('forbidden');
    expect(JSON.stringify(body)).not.toContain('somebody-else');
  });

  test('the role comes from the configured claim: a dotted path, a string, custom values', async () => {
    const api = harness(
      oidcOptions({
        roleClaim: 'realm_access.roles',
        operatorRoles: ['qelay-admin'],
        viewerRoles: ['qelay-read'],
      }),
      {},
      clock
    );
    const nested = (roles: string[]) => issuer.token({ roles: undefined, realm_access: { roles } });
    expect((await write(api, await nested(['qelay-admin']))).status).toBe(200);
    const viewer = await nested(['qelay-read']);
    expect((await read(api, viewer)).status).toBe(200);
    expect((await write(api, viewer)).status).toBe(403);
    const flat = harness(oidcOptions({ roleClaim: 'scope' }), {}, clock);
    expect(
      (await write(flat, await issuer.token({ roles: undefined, scope: 'openid operator' }))).status
    ).toBe(200);
  });

  test('an operator claim wins over a viewer claim on the same token', async () => {
    const api = harness(oidcOptions(), {}, clock);
    expect((await write(api, await issuer.token({ roles: ['viewer', 'operator'] }))).status).toBe(
      200
    );
  });
});

describe('the signing keys', () => {
  test('a kid the cache has not seen triggers one refetch, and a new key is then accepted', async () => {
    await issuer.publish('k3', false);
    const api = harness(oidcOptions(), {}, clock);
    expect((await read(api, await issuer.token({}, { kid: 'k1' }))).status).toBe(200);
    expect((await read(api, await issuer.token({}, { kid: 'k3' }))).status).toBe(401);
    issuer.list('k3');
    expect((await read(api, await issuer.token({}, { kid: 'k3' }))).status).toBe(200);
  });

  test('a kid that is not in the key set is refused', async () => {
    await issuer.publish('never-listed', false);
    const api = harness(oidcOptions(), {}, clock);
    expect((await read(api, await issuer.token({}, { kid: 'never-listed' }))).status).toBe(401);
  });

  test('keys are cached, and a flood of unknown kids does not hammer the issuer', async () => {
    await issuer.publish('flood', false);
    const api = harness(oidcOptions({ jwksCooldownMs: 60_000 }), {}, clock);
    const before = issuer.fetches;
    for (let i = 0; i < 3; i++) expect((await read(api, await issuer.token())).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await read(api, await issuer.token({}, { kid: 'flood' }))).status).toBe(401);
    }
    expect(issuer.fetches - before).toBe(1);
  });

  test('an unreachable key set refuses the token (401) and the operator is told why', async () => {
    const lonely = await TestIssuer.start(clock);
    const token = await lonely.token();
    const url = lonely.jwksUrl;
    await lonely.stop();
    const api = harness(
      {
        oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUrl: url, jwksCooldownMs: 0 },
        devToken: undefined,
      },
      {},
      clock
    );
    expect((await read(api, token)).status).toBe(401);
    expect(api.recorded.warnings.some((w) => w.fields?.reason === 'keys-unavailable')).toBe(true);
  });
});

describe('what a refusal reveals', () => {
  test('every reason gives the same answer, and no token is logged', async () => {
    const api = harness(oidcOptions(), {}, clock);
    const tokens = [
      await issuer.token({ aud: 'x' }),
      await issuer.token({ iss: 'y' }),
      await issuer.token({ exp: undefined }),
      'not-a-token',
      'a.b.c',
    ];
    const bodies = new Set<string>();
    for (const token of tokens) {
      const response = await read(api, token);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      bodies.add(JSON.stringify(await errorOf(response)));
    }
    expect(bodies.size).toBe(1);
    expect(JSON.stringify(api.recorded)).not.toContain(tokens[0]);
  });
});

describe('the development token beside OIDC', () => {
  test('works beside OIDC: either credential is accepted', async () => {
    const api = harness({ ...oidcOptions(), devToken: { token: DEV_TOKEN } }, {}, clock);
    expect((await read(api, DEV_TOKEN)).status).toBe(200);
    expect((await read(api, await issuer.token())).status).toBe(200);
  });
});
