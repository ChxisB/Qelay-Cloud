import { beforeAll, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { ManualClock } from '../../../test/support/clock';
import type { Jwk } from '../src/auth';
import { MIN_SECRET_LENGTH, oidcAuthenticator, sharedSecretAuthenticator } from '../src/auth';

const request = (authorization?: string): Request =>
  new Request('http://tick.test/internal/tick', {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
  });

describe('sharedSecretAuthenticator', () => {
  const secret = 'a-development-secret-of-24+';
  const check = sharedSecretAuthenticator(secret);

  test('accepts the secret as a bearer token', async () => {
    expect(await check(request(`Bearer ${secret}`))).toBe(true);
    expect(await check(request(`bearer ${secret}`))).toBe(true);
  });

  test.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer a-development-secret-of-24-'],
    ['a prefix of the secret', 'Bearer a-development-secret'],
    ['the secret with more after it', 'Bearer a-development-secret-of-24+x'],
    ['another scheme', 'Basic a-development-secret-of-24+'],
    ['the secret without a scheme', 'a-development-secret-of-24+'],
    ['an empty token', 'Bearer '],
  ])('refuses %s', async (_name, header) => {
    expect(await check(request(header))).toBe(false);
  });

  test(`refuses to be built with a secret under ${MIN_SECRET_LENGTH} characters`, () => {
    expect(() => sharedSecretAuthenticator('short')).toThrow(UnsupportedOptionError);
    expect(() => sharedSecretAuthenticator('x'.repeat(MIN_SECRET_LENGTH - 1))).toThrow(/at least/);
    expect(() => sharedSecretAuthenticator('x'.repeat(MIN_SECRET_LENGTH))).not.toThrow();
  });

  test('the refusal does not repeat the secret', () => {
    const attempt = 'too-short-but-secret';
    expect(() => sharedSecretAuthenticator(attempt)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(attempt) })
    );
  });
});

const AUDIENCE = 'https://tick.example.test/internal/tick';
const EMAIL = 'scheduler@project.iam.gserviceaccount.com';
const ISSUER = 'https://accounts.google.com';
const NOW_S = 1_800_000_000;

interface Signer {
  readonly kid: string;
  readonly jwk: Jwk;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

async function newSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;
  return {
    kid,
    jwk: { ...exported, kid, alg: 'RS256', use: 'sig' },
    async sign(claims, header = {}) {
      const head = b64({ alg: 'RS256', typ: 'JWT', kid, ...header });
      const body = b64(claims);
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`)
      );
      return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE,
  email: EMAIL,
  email_verified: true,
  iat: NOW_S,
  exp: NOW_S + 3_600,
  ...over,
});

describe('oidcAuthenticator', () => {
  let key: Signer;
  let other: Signer;
  let clock: ManualClock;
  let fetches: number;
  let published: Jwk[];

  beforeAll(async () => {
    key = await newSigner('key-1');
    other = await newSigner('key-2');
  });

  const build = (extra: Partial<Parameters<typeof oidcAuthenticator>[0]> = {}) => {
    clock = new ManualClock(NOW_S * 1000);
    fetches = 0;
    published = [key.jwk];
    return oidcAuthenticator({
      audience: AUDIENCE,
      allowedEmails: [EMAIL],
      clock,
      fetchJwks: async () => {
        fetches += 1;
        return { keys: [...published] };
      },
      ...extra,
    });
  };
  const bearer = (token: string): Request => request(`Bearer ${token}`);

  test('accepts a token for the audience from an allowed, verified service account', async () => {
    const check = build();
    expect(await check(bearer(await key.sign(claims())))).toBe(true);
  });

  test('accepts the other issuer spelling, an audience list, and an email in another case', async () => {
    const check = build();
    const token = await key.sign(
      claims({ iss: 'accounts.google.com', aud: ['x', AUDIENCE], email: EMAIL.toUpperCase() })
    );
    expect(await check(bearer(token))).toBe(true);
  });

  test.each([
    ['another audience', { aud: 'https://elsewhere.test' }],
    ['an audience list without it', { aud: ['a', 'b'] }],
    ['no audience', { aud: undefined }],
    ['another issuer', { iss: 'https://evil.test' }],
    ['an email not on the list', { email: 'intruder@project.iam.gserviceaccount.com' }],
    ['an unverified email', { email_verified: false }],
    ['a verified flag that is a string', { email_verified: 'true' }],
    ['no email', { email: undefined }],
    ['an expired token', { exp: NOW_S - 31 }],
    ['an expiry that is not a number', { exp: 'tomorrow' }],
    ['no expiry', { exp: undefined }],
    ['a token not valid yet', { nbf: NOW_S + 31 }],
  ])('refuses %s', async (_name, over) => {
    const check = build();
    expect(await check(bearer(await key.sign(claims(over))))).toBe(false);
  });

  test('tolerates the clock skew on both sides and not beyond it', async () => {
    const check = build({ skewMs: 30_000 });
    expect(await check(bearer(await key.sign(claims({ exp: NOW_S - 29 }))))).toBe(true);
    expect(await check(bearer(await key.sign(claims({ exp: NOW_S - 30 }))))).toBe(false);
    expect(await check(bearer(await key.sign(claims({ nbf: NOW_S + 30 }))))).toBe(true);
  });

  test('judges expiry on the injected clock', async () => {
    const check = build();
    const token = await key.sign(claims({ exp: NOW_S + 60 }));
    expect(await check(bearer(token))).toBe(true);
    clock.advance(120_000);
    expect(await check(bearer(token))).toBe(false);
  });

  test('refuses a signature made with another key, and a tampered body', async () => {
    const check = build();
    const forged = await other.sign(claims(), { kid: key.kid });
    expect(await check(bearer(forged))).toBe(false);
    const [head, , signature] = (await key.sign(claims())).split('.') as [string, string, string];
    const swapped = `${head}.${b64(claims({ email: 'intruder@x.test' }))}.${signature}`;
    expect(await check(bearer(swapped))).toBe(false);
  });

  test('refuses an algorithm other than RS256, "none" included', async () => {
    const check = build();
    expect(await check(bearer(await key.sign(claims(), { alg: 'HS256' })))).toBe(false);
    const unsigned = `${b64({ alg: 'none', typ: 'JWT', kid: key.kid })}.${b64(claims())}.`;
    expect(await check(bearer(unsigned))).toBe(false);
  });

  test.each([
    ['no token', undefined],
    ['a token of two parts', 'Bearer a.b'],
    ['garbage', 'Bearer not-a-token'],
    ['parts that are not JSON', 'Bearer a.b.c'],
    ['another scheme', 'Basic abc'],
  ])('refuses %s without throwing', async (_name, header) => {
    const check = build();
    expect(await check(request(header))).toBe(false);
  });

  test('refuses a token with no key id, and one naming a key the issuer does not have', async () => {
    const check = build();
    const anonymous = await key.sign(claims(), { kid: undefined });
    expect(await check(bearer(anonymous))).toBe(false);
    expect(await check(bearer(await key.sign(claims(), { kid: 'nobody' })))).toBe(false);
  });

  test('keeps the keys: many tokens, one fetch', async () => {
    const check = build();
    for (let n = 0; n < 5; n++) expect(await check(bearer(await key.sign(claims())))).toBe(true);
    expect(fetches).toBe(1);
  });

  test('concurrent first requests share one fetch', async () => {
    const check = build();
    const token = await key.sign(claims());
    const results = await Promise.all(Array.from({ length: 10 }, () => check(bearer(token))));
    expect(results.every(Boolean)).toBe(true);
    expect(fetches).toBe(1);
  });

  test('a rotated key is found by one refetch, but not more than once a minute', async () => {
    const check = build();
    expect(await check(bearer(await key.sign(claims())))).toBe(true);
    published = [key.jwk, other.jwk];
    // Rotation, within the minute: the new key is not looked for yet, so a flood of unknown key ids is cheap.
    clock.advance(10_000);
    expect(await check(bearer(await other.sign(claims())))).toBe(false);
    expect(fetches).toBe(1);
    clock.advance(60_000);
    expect(await check(bearer(await other.sign(claims())))).toBe(true);
    expect(fetches).toBe(2);
    expect(await check(bearer(await key.sign(claims())))).toBe(true);
    expect(fetches).toBe(2);
  });

  test('a key removed from the issuer stops working once the cache expires', async () => {
    const check = build({ keyTtlMs: 600_000 });
    const token = await key.sign(claims({ exp: NOW_S + 7_200 }));
    expect(await check(bearer(token))).toBe(true);
    published = [other.jwk];
    clock.advance(599_000);
    expect(await check(bearer(token))).toBe(true);
    clock.advance(2_000);
    expect(await check(bearer(token))).toBe(false);
    expect(fetches).toBe(2);
  });

  test('an unreachable issuer is a refusal, and the next request tries again', async () => {
    let up = false;
    const check = build({
      fetchJwks: async () => {
        fetches += 1;
        if (!up) throw new Error('certs endpoint down');
        return { keys: [key.jwk] };
      },
    });
    const token = await key.sign(claims());
    expect(await check(bearer(token))).toBe(false);
    up = true;
    expect(await check(bearer(token))).toBe(true);
    expect(fetches).toBe(2);
  });

  test('is built only with an audience and at least one allowed email', () => {
    expect(() => oidcAuthenticator({ audience: '', allowedEmails: [EMAIL] })).toThrow(
      UnsupportedOptionError
    );
    expect(() => oidcAuthenticator({ audience: AUDIENCE, allowedEmails: [] })).toThrow(
      /allowedEmails/
    );
  });
});
