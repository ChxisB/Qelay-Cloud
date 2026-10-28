import { describe, expect, test } from 'bun:test';
import {
  clipPairs,
  clipText,
  generateSourceSecret,
  generateSourceToken,
  hashSourceToken,
  isJsonContentType,
  MAX_REQUEST_PAIRS,
  MAX_REQUEST_VALUE_CHARS,
  REDACTED,
  requestDocument,
  validateVerification,
} from './inboundSource';
import { matchesFilter } from './webhookFilter';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('verification', () => {
  test('none is the default, and takes nothing', () => {
    expect(validateVerification(undefined)).toEqual({ kind: 'none', header: null, username: null });
    expect(validateVerification({ kind: 'none' })).toEqual({
      kind: 'none',
      header: null,
      username: null,
    });
    expect(() => validateVerification({ kind: 'none', header: 'x-sig' })).toThrow('no header');
  });

  test('hmac and api_key name the header, lower-cased', () => {
    expect(validateVerification({ kind: 'hmac', header: 'X-Hub-Signature-256' })).toEqual({
      kind: 'hmac',
      header: 'x-hub-signature-256',
      username: null,
    });
    expect(validateVerification({ kind: 'api_key', header: 'X-Api-Key' }).header).toBe('x-api-key');
    expect(() => validateVerification({ kind: 'hmac' })).toThrow('header');
    expect(() => validateVerification({ kind: 'hmac', header: 'bad header' })).toThrow('header');
    expect(() => validateVerification({ kind: 'hmac', header: 'x', username: 'u' })).toThrow(
      'username'
    );
  });

  test('basic names the user and refuses a colon', () => {
    expect(validateVerification({ kind: 'basic', username: 'stripe' })).toEqual({
      kind: 'basic',
      header: null,
      username: 'stripe',
    });
    expect(() => validateVerification({ kind: 'basic' })).toThrow('username');
    expect(() => validateVerification({ kind: 'basic', username: 'a:b' })).toThrow('username');
  });

  test.each([['text'], [5], [[]], [{ kind: 'oauth' }]])('refuses %p', (input) =>
    expect(() => validateVerification(input)).toThrow()
  );
});

describe('tokens', () => {
  test('a token is long, unique and URL-safe, and its hash is a stable digest', async () => {
    const a = generateSourceToken();
    expect(a).toMatch(/^qin_[A-Za-z0-9_-]{43}$/u);
    expect(generateSourceToken()).not.toBe(a);
    const hash = await hashSourceToken(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashSourceToken(a)).toBe(hash);
    expect(hash).not.toContain(a);
    expect(generateSourceSecret()).toMatch(/^qsec_[0-9a-f]{64}$/u);
  });
});

describe('stored pairs', () => {
  test('credential headers and the verification header are redacted, names lower-cased', () => {
    const headers = clipPairs(
      {
        Authorization: 'Bearer abc',
        Cookie: 'sid=1',
        'Set-Cookie': 'a=b',
        'Proxy-Authorization': 'x',
        'X-Hub-Signature-256': 'sha256=abc',
        'X-GitHub-Event': 'push',
      },
      'x-hub-signature-256'
    );
    expect(headers).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'proxy-authorization': REDACTED,
      'x-hub-signature-256': REDACTED,
      'x-github-event': 'push',
    });
  });

  test('at most the cap of pairs, each value cut', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`h${i}`, 'x']));
    expect(Object.keys(clipPairs(many))).toHaveLength(MAX_REQUEST_PAIRS);
    expect(clipPairs({ big: 'y'.repeat(5_000) }).big).toHaveLength(MAX_REQUEST_VALUE_CHARS);
  });

  test('NUL is dropped and a cut never leaves half a surrogate pair', () => {
    expect(clipPairs({ 'a\0b': 'x\0y' })).toEqual({ ab: 'xy' });
    // A pair that straddles the cap: the cut would leave a lone high surrogate, which jsonb refuses.
    const value = `${'a'.repeat(MAX_REQUEST_VALUE_CHARS - 1)}😀`;
    const clipped = clipPairs({ k: value }).k!;
    expect(clipped).toBe('a'.repeat(MAX_REQUEST_VALUE_CHARS - 1));
    expect(JSON.stringify(clipped)).not.toMatch(/\\ud[89ab]/iu);
    expect(clipText('😀')).toBe('😀');
  });

  test('a name such as __proto__ is an ordinary key and reaches no prototype', () => {
    const pairs = JSON.parse('{"__proto__":"x","a":"b"}') as Record<string, string>;
    const clipped = clipPairs(pairs);
    expect(Object.getPrototypeOf(clipped)).toBe(Object.prototype);
    expect(Object.hasOwn(clipped, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('the request document', () => {
  test('a JSON body is addressable, with the method, headers and query', () => {
    const document = requestDocument({
      method: 'post',
      headers: { 'x-event': 'user.created' },
      query: { page: '2' },
      contentType: 'application/json; charset=utf-8',
      body: bytes('{"id":500,"name":"chris"}'),
    });
    expect(document).toEqual({
      method: 'POST',
      headers: { 'x-event': 'user.created' },
      query: { page: '2' },
      body: { id: 500, name: 'chris' },
    });
    expect(matchesFilter({ 'body.id': { $gt: 100 } }, document)).toBe(true);
    expect(matchesFilter({ 'headers.x-event': 'user.created' }, document)).toBe(true);
  });

  test.each([
    ['not JSON by type', 'text/plain', '{"id":1}'],
    ['no type', null, '{"id":1}'],
    ['broken JSON', 'application/json', '{"id":'],
    ['empty', 'application/json', ''],
    ['not UTF-8', 'application/json', 'ÿ'],
  ])('%s: no body to address', (_name, contentType, text) => {
    const body = text === 'ÿ' ? new Uint8Array([0xff, 0xfe]) : bytes(text);
    const document = requestDocument({ method: 'POST', headers: {}, query: {}, contentType, body });
    expect(Object.hasOwn(document, 'body')).toBe(false);
  });

  test.each([
    ['application/json', true],
    ['Application/JSON; charset=utf-8', true],
    ['application/vnd.api+json', true],
    ['text/json', true],
    ['application/jsonp', false],
    ['text/plain', false],
    [null, false],
  ])('%p as a JSON type: %p', (type, expected) => expect(isJsonContentType(type)).toBe(expected));
});
