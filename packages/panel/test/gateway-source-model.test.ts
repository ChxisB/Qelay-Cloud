import { describe, expect, test } from 'bun:test';
import {
  blankSource,
  bytesLine,
  ingestPath,
  issuedOf,
  type SourceFields,
  sourceBodyOf,
  verificationLine,
} from '../src/pages/control/gateway/sourceModel';

const fields = (over: Partial<SourceFields>): SourceFields => ({ ...blankSource(), ...over });

describe('sourceBodyOf', () => {
  test('a name alone is a source with no check', () => {
    expect(sourceBodyOf(fields({ name: ' Shop ' }))).toEqual({ ok: true, body: { name: 'Shop' } });
  });

  test('a blank name is refused on the name', () => {
    expect(sourceBodyOf(fields({ name: ' ' }))).toMatchObject({ ok: false, field: 'name' });
  });

  test('a signature or a key needs a header made of letters, digits and dashes', () => {
    const base = { name: 'a', kind: 'hmac' as const };
    expect(sourceBodyOf(fields({ ...base, header: 'x sig' }))).toMatchObject({
      ok: false,
      field: 'header',
    });
    expect(sourceBodyOf(fields({ ...base, header: 'x-sig' }))).toEqual({
      ok: true,
      body: { name: 'a', verification: { kind: 'hmac', header: 'x-sig' } },
    });
  });

  test('a basic login needs a user name without a colon', () => {
    const base = { name: 'a', kind: 'basic' as const };
    expect(sourceBodyOf(fields({ ...base, username: 'a:b' }))).toMatchObject({
      ok: false,
      field: 'username',
    });
    expect(sourceBodyOf(fields({ ...base, username: 'bot', secret: 'x'.repeat(16) }))).toEqual({
      ok: true,
      body: { name: 'a', verification: { kind: 'basic', username: 'bot' }, secret: 'x'.repeat(16) },
    });
  });

  test('a secret is 16 to 256 characters, or blank for the server to make', () => {
    const base = { name: 'a', kind: 'api_key' as const, header: 'x-api-key' };
    expect(sourceBodyOf(fields({ ...base, secret: 'short' }))).toMatchObject({
      ok: false,
      field: 'secret',
    });
    expect(sourceBodyOf(fields(base))).toMatchObject({ ok: true });
  });
});

describe('words for a source', () => {
  test('the path is the token under /s/, and a rotation of the secret alone has none', () => {
    expect(ingestPath('qin_x')).toBe('/s/qin_x');
    const made = { id: 'src_1', name: 'Shop' } as never;
    expect(issuedOf({ source: made, token: 'qin_x', secret: 's' })).toEqual({
      name: 'Shop',
      path: '/s/qin_x',
      secret: 's',
    });
    expect(issuedOf({ source: made, token: null, secret: 's' }).path).toBeNull();
  });

  test('a source with no check says anyone with the address can send', () => {
    const none = { verification: { kind: 'none', header: null, username: null } } as never;
    expect(verificationLine(none)).toContain('Anyone who has the address can send');
  });

  test('sizes read in bytes, then kilobytes, and none is "no body"', () => {
    expect([bytesLine(null), bytesLine(25), bytesLine(2_400), bytesLine(20_480)]).toEqual([
      'no body',
      '25 B',
      '2.3 KB',
      '20 KB',
    ]);
  });
});
