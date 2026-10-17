import { describe, expect, test } from 'bun:test';
import {
  openSecret,
  parseSealKey,
  sealSecret,
  signWebhook,
  verifyWebhookSignature,
} from './webhookCrypto';

const SECRET = 'whsec_test_secret';
const BODY = '{"id":"1","event":"job.completed"}';
const NOW = 1_700_000_000_000;
// HMAC-SHA256 of `${NOW}.${BODY}`, computed with `openssl dgst -sha256 -hmac` and with Python's hmac.
const VECTOR = 'v1=2ba3986e6f81c35cdb0d1be0da3712c2ee7b0a36c993383e0c4ee5bbfa79fa47';

describe('webhook signature', () => {
  test('matches the published test vector', async () => {
    expect(await signWebhook(SECRET, NOW, BODY)).toBe(VECTOR);
    expect(await signWebhook(SECRET, String(NOW), BODY)).toBe(VECTOR);
  });

  test('a receiver accepts it inside the window and refuses it outside', async () => {
    const input = { secret: SECRET, timestamp: String(NOW), body: BODY, signature: VECTOR };
    expect(await verifyWebhookSignature({ ...input, now: NOW })).toBe(true);
    expect(await verifyWebhookSignature({ ...input, now: NOW + 300_000 })).toBe(true);
    expect(await verifyWebhookSignature({ ...input, now: NOW + 300_001 })).toBe(false);
    expect(await verifyWebhookSignature({ ...input, now: NOW - 300_001 })).toBe(false);
    expect(await verifyWebhookSignature({ ...input, now: NOW + 1_000, toleranceMs: 500 })).toBe(
      false
    );
  });

  test('a changed body, secret or timestamp does not verify', async () => {
    const input = {
      secret: SECRET,
      timestamp: String(NOW),
      body: BODY,
      signature: VECTOR,
      now: NOW,
    };
    expect(await verifyWebhookSignature({ ...input, body: `${BODY} ` })).toBe(false);
    expect(await verifyWebhookSignature({ ...input, secret: 'other' })).toBe(false);
    // The timestamp is signed: a fresh one on a captured body does not verify.
    expect(
      await verifyWebhookSignature({ ...input, timestamp: String(NOW + 1), now: NOW + 1 })
    ).toBe(false);
  });

  test('malformed headers are refused, not thrown on', async () => {
    const input = { secret: SECRET, timestamp: String(NOW), body: BODY, now: NOW };
    for (const signature of [
      '',
      'v1=',
      'v1=zz',
      `v2=${VECTOR.slice(3)}`,
      VECTOR.slice(3),
      'v1=abc',
    ]) {
      expect(await verifyWebhookSignature({ ...input, signature })).toBe(false);
    }
    for (const timestamp of ['', 'abc', '-1', '1.5', '1e12', '1'.repeat(17)]) {
      expect(await verifyWebhookSignature({ ...input, timestamp, signature: VECTOR })).toBe(false);
    }
  });

  test('a rotation header with the old and new signatures verifies on either', async () => {
    const next = await signWebhook('new-secret', NOW, BODY);
    const header = `${next}, ${VECTOR}`;
    const input = { timestamp: String(NOW), body: BODY, signature: header, now: NOW };
    expect(await verifyWebhookSignature({ ...input, secret: SECRET })).toBe(true);
    expect(await verifyWebhookSignature({ ...input, secret: 'new-secret' })).toBe(true);
    expect(await verifyWebhookSignature({ ...input, secret: 'third' })).toBe(false);
  });
});

describe('sealed secrets', () => {
  const key = new Uint8Array(32).fill(7);

  test('open with the key and the context they were sealed with', async () => {
    const sealed = await sealSecret(SECRET, key, 'ns/wh-1');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(await openSecret(sealed, key, 'ns/wh-1')).toBe(SECRET);
  });

  test('each sealing is different, and none opens for another key, context or a damaged text', async () => {
    const a = await sealSecret(SECRET, key, 'c');
    const b = await sealSecret(SECRET, key, 'c');
    expect(a).not.toBe(b);
    expect(await openSecret(a, new Uint8Array(32).fill(8), 'c')).toBeNull();
    expect(await openSecret(a, key, 'other')).toBeNull();
    const parts = a.split(':');
    expect(
      await openSecret(`${parts[0]}:${parts[1]}:${parts[2]!.replace(/.$/u, 'A=')}`, key, 'c')
    ).toBeNull();
    for (const text of ['', 'v1', 'v1:a', 'v2:a:b', `${a}:x`, 'v1:!!:!!']) {
      expect(await openSecret(text, key, 'c')).toBeNull();
    }
  });

  test('an empty and a non-ASCII secret round-trip', async () => {
    expect(await openSecret(await sealSecret('', key, 'c'), key, 'c')).toBe('');
    expect(await openSecret(await sealSecret('sécret-ключ-🔑', key, 'c'), key, 'c')).toBe(
      'sécret-ключ-🔑'
    );
  });

  test('a key must be 32 bytes, as hex or base64', () => {
    const hex = '0f'.repeat(32);
    expect(parseSealKey(hex)).toEqual(new Uint8Array(32).fill(0x0f));
    expect(parseSealKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(1))))).toEqual(
      new Uint8Array(32).fill(1)
    );
    for (const bad of ['', 'short', '0f'.repeat(31), '0f'.repeat(33), '!'.repeat(44)]) {
      expect(() => parseSealKey(bad, 'QCLOUD_WEBHOOK_KEY')).toThrow('QCLOUD_WEBHOOK_KEY');
    }
  });

  test('sealing refuses a key of the wrong length', async () => {
    const refusal = await sealSecret('x', new Uint8Array(16), 'c').then(
      () => null,
      (error: unknown) => error
    );
    expect(String(refusal)).toContain('32 bytes');
  });
});
