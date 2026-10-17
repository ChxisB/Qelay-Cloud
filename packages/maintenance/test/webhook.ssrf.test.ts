import { describe, expect, test } from 'bun:test';
import { sendDelivery } from '../src/webhookSend';
import { delivery, PUBLIC_ADDRESS, script } from './webhookSupport';

/** Every attempt in this file must end without a single request leaving. */
async function blocked(url: string, resolveTo: string[] = [PUBLIC_ADDRESS]) {
  const s = script({ resolve: () => resolveTo });
  const result = await sendDelivery(delivery({ url }), s.deps());
  expect(s.calls).toEqual([]);
  expect(result.ok).toBe(false);
  expect(result.statusCode).toBeNull();
  return { result, s };
}

describe('webhook SSRF: the URL', () => {
  test.each([
    'http://hooks.example.com/in',
    'ftp://hooks.example.com/in',
    'file:///etc/passwd',
    'gopher://hooks.example.com:70/',
    'https://user:pass@hooks.example.com/in',
    'https://hooks.example.com@169.254.169.254/latest',
    'not a url',
    '',
  ])('%p is refused before any lookup', async (url) => {
    const { s } = await blocked(url);
    expect(s.lookups).toEqual([]);
  });

  test.each([
    'https://127.0.0.1/',
    'https://127.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://0.0.0.0/',
    'https://10.0.0.5/',
    'https://172.16.0.1/',
    'https://172.31.255.255/',
    'https://192.168.1.1/',
    'https://100.64.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://169.254.170.2/v2/credentials',
    'https://[::1]/',
    'https://[::]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[fd00:ec2::254]/',
    'https://[64:ff9b::a9fe:a9fe]/',
    'https://[2002:a9fe:a9fe::1]/',
    'https://[0:0:0:0:0:0:0:1]/',
  ])('the address %p is refused without a lookup', async (url) => {
    const { s } = await blocked(url);
    expect(s.lookups).toEqual([]);
  });

  test.each([
    'https://localhost/',
    'https://LOCALHOST./',
    'https://app.localhost/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata.goog/',
    'https://db.internal/',
    'https://printer.local/',
    'https://intranet/',
    'https://router.lan/',
    'https://host.corp/',
    'https://nas.home.arpa/',
  ])('the name %p is refused without a lookup', async (url) => {
    const { s } = await blocked(url);
    expect(s.lookups).toEqual([]);
  });
});

describe('webhook SSRF: what a name resolves to', () => {
  test.each([
    ['loopback', ['127.0.0.1']],
    ['private', ['10.1.2.3']],
    ['link-local metadata', ['169.254.169.254']],
    ['IPv6 loopback', ['::1']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['unique-local IPv6', ['fd00::1']],
    ['an unparsable answer', ['not-an-address']],
  ])('a public-looking name that resolves to %s is refused', async (_label, answers) => {
    const { result, s } = await blocked('https://totally-public.example.com/', answers);
    expect(s.lookups).toEqual(['totally-public.example.com']);
    expect(result.error).toBe('destination not allowed: the name resolves to a non-public address');
  });

  test('one private address among public ones refuses the whole name (the resolver may pick it)', async () => {
    const { result } = await blocked('https://mixed.example.com/', [
      PUBLIC_ADDRESS,
      '93.184.216.35',
      '10.0.0.7',
    ]);
    expect(result.error).toContain('non-public');
  });

  test('the error names neither the address the name pointed at nor the name', async () => {
    const { result } = await blocked('https://rebind.example.com/', ['169.254.169.254']);
    expect(result.error).not.toContain('169.254');
    expect(result.error).not.toContain('rebind.example.com');
  });
});

describe('webhook SSRF: rebinding', () => {
  test('the name is resolved once and the connection goes to that answer, never to the name', async () => {
    let answers = 0;
    const s = script({
      // The first lookup is public; any later one would be the metadata service.
      resolve: () => (answers++ === 0 ? [PUBLIC_ADDRESS] : ['169.254.169.254']),
    });
    const result = await sendDelivery(delivery({ url: 'https://rebind.example.com/in' }), s.deps());
    expect(result.ok).toBe(true);
    expect(s.lookups).toEqual(['rebind.example.com']);
    expect(s.calls.map((call) => call.address)).toEqual([PUBLIC_ADDRESS]);
    // The name only travels as the TLS name and the Host header, never as where to connect.
    expect(s.calls[0]).toMatchObject({ serverName: 'rebind.example.com' });
  });

  test('a name that flips to a private address on its next resolution is refused on that attempt', async () => {
    let flipped = false;
    const s = script({ resolve: () => (flipped ? ['10.0.0.9'] : [PUBLIC_ADDRESS]) });
    const deps = s.deps();
    expect((await sendDelivery(delivery(), deps)).ok).toBe(true);
    flipped = true;
    const second = await sendDelivery(delivery({ attempt: 2 }), deps);
    expect(second.ok).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  test('every address tried is one that was checked', async () => {
    const answers = ['93.184.216.1', '93.184.216.2'];
    const s = script({
      resolve: () => answers,
      post: () => ({ kind: 'failed', failure: 'refused' }),
    });
    await sendDelivery(delivery(), s.deps());
    expect(new Set(s.calls.map((call) => call.address))).toEqual(new Set(answers));
  });
});

describe('webhook SSRF: redirects', () => {
  // The answer carries no Location: it is not read, so there is nothing to follow. The real-socket
  // test (webhook.http.test.ts) has a receiver redirect to a second listener that must see nothing.
  test.each([301, 302, 303, 307, 308])(
    'a %i is a failed attempt and exactly one request is made',
    async (status) => {
      const s = script({ post: () => ({ kind: 'status', status }) });
      const result = await sendDelivery(delivery(), s.deps());
      expect(result).toMatchObject({ ok: false, statusCode: status });
      expect(s.calls).toHaveLength(1);
      expect(s.lookups).toHaveLength(1);
    }
  );
});

describe('webhook SSRF: development mode', () => {
  const dev = { allowHttp: true, allowPrivate: true };

  test('loopback over http is allowed, and goes straight to the literal', async () => {
    const s = script();
    const result = await sendDelivery(
      delivery({ url: 'http://127.0.0.1:9999/hook' }),
      s.deps({ urlPolicy: dev })
    );
    expect(result.ok).toBe(true);
    expect(s.lookups).toEqual([]);
    expect(s.calls[0]).toMatchObject({
      address: '127.0.0.1',
      port: 9999,
      secure: false,
      hostHeader: '127.0.0.1:9999',
    });
    expect(s.calls[0]!.serverName).toBeUndefined();
  });

  test('a private name may resolve to a private address', async () => {
    const s = script({ resolve: () => ['10.1.1.1'] });
    const result = await sendDelivery(
      delivery({ url: 'http://receiver.local/x' }),
      s.deps({ urlPolicy: dev })
    );
    expect(result.ok).toBe(true);
    expect(s.calls[0]!.address).toBe('10.1.1.1');
  });

  test('the strict policy is the default: the same URLs are refused without the flag', async () => {
    await blocked('http://127.0.0.1:9999/hook');
    await blocked('http://receiver.local/x', ['10.1.1.1']);
  });
});
