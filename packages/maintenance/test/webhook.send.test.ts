import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, WEBHOOK_HEADERS, WEBHOOK_SCHEMA_VERSION } from '@qelay-cloud/core';
import { sendDelivery } from '../src/webhookSend';
import { delivery, NOW, PUBLIC_ADDRESS, script, SECRET } from './webhookSupport';

describe('webhook attempt: the request', () => {
  test('goes to the checked address with the name for TLS, signed over timestamp and body', async () => {
    const s = script();
    const result = await sendDelivery(delivery(), s.deps());
    expect(result).toMatchObject({
      ok: true,
      statusCode: 200,
      error: null,
      attempt: 1,
      startedAt: NOW,
    });
    expect(s.lookups).toEqual(['hooks.example.com']);
    const [request] = s.calls;
    expect(request).toMatchObject({
      address: PUBLIC_ADDRESS,
      port: 443,
      secure: true,
      serverName: 'hooks.example.com',
      hostHeader: 'hooks.example.com',
      path: '/in?x=1',
    });
    const headers = request!.headers;
    expect(headers[WEBHOOK_HEADERS.id]).toBe('41');
    expect(headers[WEBHOOK_HEADERS.event]).toBe('webhook.test');
    expect(headers[WEBHOOK_HEADERS.attempt]).toBe('1');
    expect(headers[WEBHOOK_HEADERS.timestamp]).toBe(String(NOW));
    expect(JSON.parse(request!.body)).toEqual({
      id: '41',
      event: 'webhook.test',
      timestamp: NOW - 1_000,
    });
    // The documented scheme, computed here without the sender's code: HMAC-SHA256 over "<timestamp>.<body>".
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${request!.body}`).digest('hex');
    expect(headers[WEBHOOK_HEADERS.signature]).toBe(`v1=${expected}`);
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        timestamp: headers[WEBHOOK_HEADERS.timestamp]!,
        body: request!.body,
        signature: headers[WEBHOOK_HEADERS.signature]!,
        now: NOW,
      })
    ).toBe(true);
  });

  test('during a rotation both secrets sign, and a receiver holding either verifies', async () => {
    const s = script();
    const previous = 'whsec_previous0123456789abcdef012345';
    await sendDelivery(delivery({ previousSecret: previous }), s.deps());
    const { headers, body } = s.calls[0]!;
    const signature = headers[WEBHOOK_HEADERS.signature]!;
    expect(signature.split(',')).toHaveLength(2);
    for (const secret of [SECRET, previous]) {
      const input = { secret, timestamp: String(NOW), body, signature, now: NOW };
      expect(await verifyWebhookSignature(input)).toBe(true);
    }
    expect(
      await verifyWebhookSignature({
        secret: 'whsec_other',
        timestamp: String(NOW),
        body,
        signature,
        now: NOW,
      })
    ).toBe(false);
  });

  test('a test delivery carries only its id, event and timestamp', async () => {
    const s = script();
    await sendDelivery(delivery(), s.deps());
    expect(Object.keys(JSON.parse(s.calls[0]!.body)).sort()).toEqual(['event', 'id', 'timestamp']);
  });

  test('an unsigned webhook carries no signature header', async () => {
    const s = script();
    await sendDelivery(delivery({ secret: null }), s.deps());
    expect(WEBHOOK_HEADERS.signature in s.calls[0]!.headers).toBe(false);
  });

  test('a signed webhook whose secret cannot be opened is not sent, unsigned or otherwise', async () => {
    const s = script();
    const result = await sendDelivery(delivery({ secret: null, secretUnreadable: true }), s.deps());
    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      error: 'signing secret could not be opened',
    });
    expect(s.calls).toEqual([]);
  });

  test('a fresh timestamp is signed on every attempt, the delivery id stays', async () => {
    let now = NOW;
    const s = script();
    const deps = s.deps({ now: () => (now += 7_000) });
    await sendDelivery(delivery({ attempt: 1 }), deps);
    await sendDelivery(delivery({ attempt: 2 }), deps);
    const [first, second] = s.calls;
    expect(first!.headers[WEBHOOK_HEADERS.id]).toBe(second!.headers[WEBHOOK_HEADERS.id]);
    expect(first!.headers[WEBHOOK_HEADERS.timestamp]).not.toBe(
      second!.headers[WEBHOOK_HEADERS.timestamp]
    );
    expect(second!.headers[WEBHOOK_HEADERS.attempt]).toBe('2');
  });

  test('a port in the URL is used and shows in Host', async () => {
    const s = script();
    await sendDelivery(delivery({ url: 'https://hooks.example.com:8443/x' }), s.deps());
    expect(s.calls[0]).toMatchObject({ port: 8443, hostHeader: 'hooks.example.com:8443' });
  });
});

describe('webhook attempt: what the answer means', () => {
  const answering = (status: number) => script({ post: () => ({ kind: 'status', status }) });

  test.each([200, 201, 204, 299])('%i is delivered', async (status) => {
    const result = await sendDelivery(delivery(), answering(status).deps());
    expect(result).toMatchObject({ ok: true, statusCode: status, error: null });
  });

  test.each([400, 404, 410, 429, 500, 503])(
    '%i is a failed attempt, with the status and no body',
    async (status) => {
      const result = await sendDelivery(delivery(), answering(status).deps());
      expect(result).toMatchObject({
        ok: false,
        statusCode: status,
        error: `receiver answered ${status}`,
      });
    }
  );

  test.each([301, 302, 307, 308])('a %i redirect is not followed', async (status) => {
    const s = answering(status);
    const result = await sendDelivery(delivery(), s.deps());
    expect(result).toMatchObject({
      ok: false,
      statusCode: status,
      error: `redirect not followed (${status})`,
    });
    expect(s.calls).toHaveLength(1);
    expect(s.lookups).toHaveLength(1);
  });

  test.each([
    ['timeout', 'receiver did not answer in time'],
    ['tls', 'TLS handshake failed or the certificate was not accepted'],
    ['reset', 'connection closed before an answer'],
    ['protocol', 'receiver did not answer with HTTP'],
  ] as const)('a %s failure is recorded in fixed words', async (failure, text) => {
    const s = script({ post: () => ({ kind: 'failed', failure }) });
    const result = await sendDelivery(delivery(), s.deps());
    expect(result).toMatchObject({ ok: false, statusCode: null, error: text });
    expect(s.calls).toHaveLength(1);
  });

  test('a refused connection tries the next address, up to four, and no further', async () => {
    const addresses = [
      '93.184.216.1',
      '93.184.216.2',
      '93.184.216.3',
      '93.184.216.4',
      '93.184.216.5',
    ];
    const s = script({
      resolve: () => addresses,
      post: () => ({ kind: 'failed', failure: 'refused' }),
    });
    const result = await sendDelivery(delivery(), s.deps());
    expect(result.error).toBe('connection failed');
    expect(s.calls.map((call) => call.address)).toEqual(addresses.slice(0, 4));
  });

  test('a refused connection followed by an answer is that answer', async () => {
    const s = script({
      resolve: () => ['93.184.216.1', '93.184.216.2'],
      post: (_request, call) =>
        call === 1 ? { kind: 'failed', failure: 'refused' } : { kind: 'status', status: 204 },
    });
    expect(await sendDelivery(delivery(), s.deps())).toMatchObject({ ok: true, statusCode: 204 });
    expect(s.calls.map((call) => call.address)).toEqual(['93.184.216.1', '93.184.216.2']);
  });

  test('a reply that is not a refusal ends the tries: the host was reached', async () => {
    const s = script({
      resolve: () => ['93.184.216.1', '93.184.216.2'],
      post: () => ({ kind: 'failed', failure: 'timeout' }),
    });
    await sendDelivery(delivery(), s.deps());
    expect(s.calls).toHaveLength(1);
  });

  test('a post that throws costs the attempt, not the caller, and says nothing of why', async () => {
    const s = script({
      post: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-path');
      },
    });
    const result = await sendDelivery(delivery(), s.deps());
    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      error: 'the attempt could not be made',
    });
  });

  test('a name that does not resolve, or resolves to nothing, fails the attempt', async () => {
    const throwing = script({
      resolve: () => {
        throw new Error('getaddrinfo ENOTFOUND internal.corp.example');
      },
    });
    expect((await sendDelivery(delivery(), throwing.deps())).error).toBe('name did not resolve');
    const empty = script({ resolve: () => [] });
    expect((await sendDelivery(delivery(), empty.deps())).error).toBe('name did not resolve');
    expect(throwing.calls.length + empty.calls.length).toBe(0);
  });

  test('a lookup that never answers is cut off by the attempt timeout', async () => {
    const s = script({ resolve: () => new Promise<string[]>(() => {}) });
    const started = performance.now();
    const result = await sendDelivery(delivery(), s.deps({ timeoutMs: 80 }));
    expect(result.error).toBe('name did not resolve');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(s.calls).toEqual([]);
  });

  test('the post gets only what is left of the attempt timeout', async () => {
    const s = script({
      resolve: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [PUBLIC_ADDRESS];
      },
    });
    await sendDelivery(delivery(), s.deps({ timeoutMs: 500 }));
    expect(s.calls[0]!.timeoutMs).toBeLessThan(500);
    expect(s.calls[0]!.timeoutMs).toBeGreaterThan(300);
  });
});

describe('webhook attempt: a body the writer made', () => {
  test('sends and signs the stored bytes, and does not claim the default schema', async () => {
    const s = script();
    const body = '{"a":1,"id":"41"}';
    await sendDelivery(delivery({ body }), s.deps());
    const [request] = s.calls;
    expect(request!.body).toBe(body);
    expect(request!.headers[WEBHOOK_HEADERS.schema]).toBeUndefined();
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${body}`).digest('hex');
    expect(request!.headers[WEBHOOK_HEADERS.signature]).toBe(`v1=${expected}`);
  });

  test('the default body is marked with the schema version', async () => {
    const s = script();
    await sendDelivery(delivery({ body: null }), s.deps());
    expect(s.calls[0]!.headers[WEBHOOK_HEADERS.schema]).toBe(WEBHOOK_SCHEMA_VERSION);
  });

  test('a body that was too large to make is refused without a request', async () => {
    const s = script();
    const result = await sendDelivery(delivery({ body: '' }), s.deps());
    expect(result).toMatchObject({ ok: false, statusCode: null });
    expect(result.error).toContain('too large');
    expect(s.calls).toEqual([]);
  });

  test('an http delivery with no address is refused without a request or a lookup', async () => {
    // The store keeps '' as the url of a queue route; an http one never has it, and nothing is sent if it did.
    const s = script();
    const result = await sendDelivery(delivery({ url: '' }), s.deps());
    expect(result).toMatchObject({ ok: false, statusCode: null });
    expect(result.error).toContain('destination not allowed');
    expect(s.calls).toEqual([]);
    expect(s.lookups).toEqual([]);
  });
});
