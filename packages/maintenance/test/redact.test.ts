import { describe, expect, test } from 'bun:test';
import { redactor } from '../src/redact';

describe('redactor', () => {
  const env = {
    QCLOUD_DATABASE_URL: 'postgres://qcloud:p%40ss-w0rd@db.internal:5432/qcloud',
    QCLOUD_DATABASE_LISTEN_URL: 'postgres://listener:other-secret@direct.internal/qcloud',
    QCLOUD_TICK_SHARED_SECRET: 'a-development-secret-of-24+',
  };
  const redact = redactor(env);

  test('removes the whole database URL, wherever it appears', () => {
    expect(redact(`connect failed for ${env.QCLOUD_DATABASE_URL}: refused`)).toBe(
      'connect failed for ***: refused'
    );
  });

  test('removes the password alone, raw or decoded, when a driver prints it apart from the URL', () => {
    expect(redact('password authentication failed for "p%40ss-w0rd"')).not.toContain('p%40ss');
    expect(redact('password p@ss-w0rd rejected')).toBe('password *** rejected');
  });

  test("removes a shard's URL, whatever the shard is called", () => {
    const url = 'postgres://u:shard-b-pass@db-b.internal/qcloud';
    expect(redactor({ QCLOUD_SHARD_B2_DATABASE_URL: url })(`down: ${url}`)).toBe('down: ***');
  });

  test('removes the listen URL and the shared secret', () => {
    expect(redact(env.QCLOUD_DATABASE_LISTEN_URL)).toBe('***');
    expect(redact(`got ${env.QCLOUD_TICK_SHARED_SECRET}`)).toBe('got ***');
  });

  test('removes the user and password of a URL it was not told about', () => {
    expect(redact('dial postgres://someone:else@other.internal:5432/db failed')).toBe(
      'dial postgres://***@other.internal:5432/db failed'
    );
    expect(redact('https://token@example.test/path')).toBe('https://***@example.test/path');
  });

  test('leaves a message with no credential alone, and an unset environment redacts nothing by value', () => {
    expect(redact('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      'connect ECONNREFUSED 127.0.0.1:5432'
    );
    expect(redactor({})('plain text')).toBe('plain text');
  });

  test('a variable that is not a URL is redacted as a whole value', () => {
    const odd = redactor({ QCLOUD_DATABASE_URL: 'host=db user=u password=s3cret' });
    expect(odd('failed: host=db user=u password=s3cret')).toBe('failed: ***');
  });
});
