import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SourceAuth } from '@qelay-cloud/store-postgres';
import { verifies } from '../src/verify';
import { NONE } from './support';

const SECRET = 'qsec_0123456789abcdef0123456789abcdef';
const BEFORE = 'qsec_fedcba9876543210fedcba9876543210';
const BODY = new TextEncoder().encode('{"id":500,"name":"chris"}');

const source = (
  kind: 'hmac' | 'basic' | 'api_key',
  over: Partial<SourceAuth> = {}
): SourceAuth => ({
  ...NONE,
  verification: {
    kind,
    header: kind === 'basic' ? null : 'x-signature',
    username: kind === 'basic' ? 'sender' : null,
  },
  secret: SECRET,
  ...over,
});
const sign = (secret: string, body = BODY) => createHmac('sha256', secret).update(body).digest();
const basic = (user: string, password: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
});
const headers = (init: Record<string, string>) => new Headers(init);

describe('a source with no verification', () => {
  test('takes anyone', async () => {
    expect(await verifies(NONE, headers({}), BODY)).toBe(true);
  });
});

describe('hmac', () => {
  const hmac = source('hmac');

  test('takes the signature of the raw body as hex, sha256= hex, base64 or url-safe base64', async () => {
    const mac = sign(SECRET);
    for (const given of [
      mac.toString('hex'),
      `sha256=${mac.toString('hex')}`,
      `SHA256=${mac.toString('hex').toUpperCase()}`,
      mac.toString('base64'),
      mac.toString('base64url'),
    ]) {
      expect(await verifies(hmac, headers({ 'x-signature': given }), BODY), given).toBe(true);
    }
  });

  test('refuses a wrong secret, another body, no header, and a value that is not a signature', async () => {
    const mac = sign(SECRET).toString('hex');
    expect(
      await verifies(hmac, headers({ 'x-signature': sign('other').toString('hex') }), BODY)
    ).toBe(false);
    expect(
      await verifies(hmac, headers({ 'x-signature': mac }), new TextEncoder().encode('{}'))
    ).toBe(false);
    expect(await verifies(hmac, headers({}), BODY)).toBe(false);
    for (const junk of [
      '',
      'sha256=',
      'abc',
      mac.slice(1),
      `${mac}0`,
      'z'.repeat(64),
      '!'.repeat(44),
    ]) {
      expect(await verifies(hmac, headers({ 'x-signature': junk }), BODY), junk).toBe(false);
    }
  });

  test('takes the secret before the last rotation too, and an empty body', async () => {
    const rotated = source('hmac', { secret: SECRET, previousSecret: BEFORE });
    expect(
      await verifies(rotated, headers({ 'x-signature': sign(BEFORE).toString('hex') }), BODY)
    ).toBe(true);
    expect(
      await verifies(rotated, headers({ 'x-signature': sign(SECRET).toString('hex') }), BODY)
    ).toBe(true);
    const empty = new Uint8Array(0);
    expect(
      await verifies(hmac, headers({ 'x-signature': sign(SECRET, empty).toString('hex') }), empty)
    ).toBe(true);
  });
});

describe('api_key', () => {
  const key = source('api_key');

  test('takes the key in the source header, and only that', async () => {
    expect(await verifies(key, headers({ 'x-signature': SECRET }), BODY)).toBe(true);
    expect(await verifies(key, headers({ 'x-signature': `${SECRET}x` }), BODY)).toBe(false);
    expect(await verifies(key, headers({ 'x-signature': SECRET.slice(1) }), BODY)).toBe(false);
    expect(await verifies(key, headers({ 'x-signature': '' }), BODY)).toBe(false);
    expect(await verifies(key, headers({}), BODY)).toBe(false);
    expect(await verifies(key, headers({ authorization: SECRET }), BODY)).toBe(false);
  });

  test('takes the key before the last rotation too', async () => {
    const rotated = source('api_key', { previousSecret: BEFORE });
    expect(await verifies(rotated, headers({ 'x-signature': BEFORE }), BODY)).toBe(true);
  });
});

describe('basic', () => {
  const basicSource = source('basic');

  test('takes the user name and the secret as the password', async () => {
    expect(await verifies(basicSource, headers(basic('sender', SECRET)), BODY)).toBe(true);
    expect(
      await verifies(
        basicSource,
        headers({ authorization: `basic ${Buffer.from(`sender:${SECRET}`).toString('base64')}` }),
        BODY
      )
    ).toBe(true);
  });

  test('refuses a wrong user, a wrong password, a missing or malformed header', async () => {
    expect(await verifies(basicSource, headers(basic('other', SECRET)), BODY)).toBe(false);
    expect(await verifies(basicSource, headers(basic('sender', 'nope')), BODY)).toBe(false);
    expect(await verifies(basicSource, headers(basic('sender', '')), BODY)).toBe(false);
    expect(await verifies(basicSource, headers({}), BODY)).toBe(false);
    for (const authorization of [
      'Basic',
      'Basic !!!',
      `Bearer ${SECRET}`,
      `Basic ${Buffer.from('nocolon').toString('base64')}`,
    ]) {
      expect(await verifies(basicSource, headers({ authorization }), BODY), authorization).toBe(
        false
      );
    }
  });

  test('a password with a colon is the whole of what follows the first one', async () => {
    const odd = source('basic', { secret: 'a:b:c' });
    expect(await verifies(odd, headers(basic('sender', 'a:b:c')), BODY)).toBe(true);
    expect(await verifies(odd, headers(basic('sender', 'b:c')), BODY)).toBe(false);
  });
});

describe('a source whose secret cannot be used', () => {
  test('takes nothing, with the right credential or without one', async () => {
    for (const kind of ['hmac', 'basic', 'api_key'] as const) {
      for (const lost of [{ secret: null }, { secretUnreadable: true }]) {
        const dead = source(kind, lost);
        const given =
          kind === 'hmac'
            ? { 'x-signature': sign(SECRET).toString('hex') }
            : kind === 'api_key'
              ? { 'x-signature': SECRET }
              : basic('sender', SECRET);
        expect(await verifies(dead, headers(given), BODY), `${kind} ${JSON.stringify(lost)}`).toBe(
          false
        );
      }
    }
  });
});
