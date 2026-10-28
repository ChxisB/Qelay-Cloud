import { describe, expect, test } from 'bun:test';
import { signWebhook, WEBHOOK_HEADERS } from '@qelay-cloud/core';
import type { NewJob } from '@qelay-cloud/core';
import type { Enqueue } from '../src/webhookEnqueue';
import { encodeRequest } from '../src/webhookHttp';
import { sendDelivery } from '../src/webhookSend';
import { delivery, NOW, script, SECRET } from './webhookSupport';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** A request delivery as the claim hands it to the sender: no shaped body, the request's own bytes. */
const fromRequest = (body: Uint8Array | null, contentType: string | null, overrides = {}) =>
  delivery({
    event: 'request.received',
    requestId: '77',
    requestBody: body,
    requestContentType: contentType,
    ...overrides,
  });

describe('webhook attempt: a request is delivered as it came in (D14)', () => {
  test('with no shape the destination gets the same bytes, the same content type, and a signature over them', async () => {
    const s = script();
    const sent = bytes('{ "id": 500,   "name": "chris" }');
    const result = await sendDelivery(fromRequest(sent, 'application/json'), s.deps());
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    const [call] = s.calls;
    expect(call!.bytes).toEqual(sent);
    expect(call!.contentType).toBe('application/json');
    expect(call!.headers[WEBHOOK_HEADERS.event]).toBe('request.received');
    expect(call!.headers[WEBHOOK_HEADERS.schema]).toBeUndefined();
    expect(call!.headers[WEBHOOK_HEADERS.signature]).toBe(await signWebhook(SECRET, NOW, sent));
    // On the wire: the body is the bytes, byte for byte, and Content-Length counts them.
    const wire = text(encodeRequest(call!, false));
    expect(wire).toContain('Content-Type: application/json\r\n');
    expect(wire).toContain(`Content-Length: ${sent.byteLength}\r\n`);
    expect(wire.endsWith(`\r\n\r\n${text(sent)}`)).toBe(true);
  });

  test('bytes that are not text are sent untouched, and the signature covers them', async () => {
    const s = script();
    const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0x0a]);
    await sendDelivery(fromRequest(binary, 'application/x-custom'), s.deps());
    const [call] = s.calls;
    expect(call!.bytes).toEqual(binary);
    expect(call!.contentType).toBe('application/x-custom');
    expect(call!.headers[WEBHOOK_HEADERS.signature]).toBe(await signWebhook(SECRET, NOW, binary));
  });

  test('a content type that could end the header line is not copied', async () => {
    const s = script();
    await sendDelivery(fromRequest(bytes('x'), 'text/plain\r\nX-Evil: 1'), s.deps());
    expect(s.calls[0]!.contentType).toBe('application/octet-stream');
    expect(text(encodeRequest(s.calls[0]!, false))).not.toContain('X-Evil');
    // A request that had no content type is not called JSON.
    await sendDelivery(fromRequest(bytes('x'), null), s.deps());
    expect(s.calls[1]!.contentType).toBe('application/octet-stream');
  });

  test('a shaped body is sent as JSON, as stored', async () => {
    const s = script();
    const shaped = '{"customer":"chris"}';
    await sendDelivery(fromRequest(null, 'text/plain', { body: shaped }), s.deps());
    const [call] = s.calls;
    expect(call!.body).toBe(shaped);
    expect(call!.bytes).toBeUndefined();
    expect(call!.contentType).toBeUndefined();
    expect(text(encodeRequest(call!, false))).toContain('Content-Type: application/json\r\n');
    expect(call!.headers[WEBHOOK_HEADERS.signature]).toBe(await signWebhook(SECRET, NOW, shaped));
  });

  test('a request the retention removed is refused in words, and nothing is sent', async () => {
    const s = script();
    const result = await sendDelivery(fromRequest(null, null), s.deps());
    expect(result).toMatchObject({ ok: false, error: 'the request is no longer stored' });
    expect(s.calls).toEqual([]);
  });

  test('a URL in the body cannot move the delivery', async () => {
    const s = script();
    const sneaky = bytes(
      JSON.stringify({ url: 'http://169.254.169.254/latest', target: 'x', host: 'evil.test' })
    );
    await sendDelivery(fromRequest(sneaky, 'application/json'), s.deps());
    expect(s.lookups).toEqual(['hooks.example.com']);
    expect(s.calls[0]).toMatchObject({
      address: '93.184.216.34',
      hostHeader: 'hooks.example.com',
      path: '/in?x=1',
    });
  });
});

describe('webhook attempt: a request on a queue route (D14)', () => {
  const queued = (body: Uint8Array | null, contentType: string | null, overrides = {}) =>
    fromRequest(body, contentType, {
      destination: 'queue',
      target: 'refunds',
      url: '',
      secret: null,
      ...overrides,
    });
  const enqueueing = () => {
    const calls: Array<readonly NewJob[]> = [];
    const enqueue: Enqueue = async (jobs) => {
      calls.push(jobs);
      return [{ id: 'job-9' }];
    };
    return { calls, enqueue };
  };

  test('the job data is the request body: parsed for JSON, the text for anything else', async () => {
    const e = enqueueing();
    const s = script();
    await sendDelivery(
      queued(bytes('{"id":500,"name":"chris"}'), 'application/json'),
      s.deps({ enqueue: e.enqueue })
    );
    await sendDelivery(queued(bytes('plain words'), 'text/plain'), s.deps({ enqueue: e.enqueue }));
    await sendDelivery(
      queued(bytes('{broken'), 'application/json'),
      s.deps({ enqueue: e.enqueue })
    );
    expect(e.calls.map(([job]) => job!.data)).toEqual([
      { id: 500, name: 'chris' },
      'plain words',
      '{broken',
    ]);
    expect(e.calls[0]![0]).toMatchObject({ queue: 'refunds', name: 'request.received' });
    expect(s.calls).toEqual([]);
  });

  test('a shaped body is the job data', async () => {
    const e = enqueueing();
    await sendDelivery(
      queued(null, null, { body: '{"customer":"chris"}' }),
      script().deps({ enqueue: e.enqueue })
    );
    expect(e.calls[0]![0]!.data).toEqual({ customer: 'chris' });
  });

  test('bytes that are not text, and a removed request, fail the attempt in words', async () => {
    const e = enqueueing();
    const deps = script().deps({ enqueue: e.enqueue });
    expect(
      await sendDelivery(queued(Uint8Array.from([0xff, 0xfe]), 'image/png'), deps)
    ).toMatchObject({
      ok: false,
      error: 'the request body is not text, so it cannot be job data',
    });
    expect(await sendDelivery(queued(null, null), deps)).toMatchObject({
      ok: false,
      error: 'the request is no longer stored',
    });
    expect(e.calls).toEqual([]);
  });
});
