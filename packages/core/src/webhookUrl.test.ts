import { describe, expect, test } from 'bun:test';
import {
  addressBlockReason,
  firstBlockedAddress,
  STRICT_URL_POLICY,
  validateWebhookUrl,
} from './webhookUrl';

const DEV = { allowHttp: true, allowPrivate: true } as const;

/** Every one of these reaches a machine the operator did not mean to expose. */
const HOSTILE = [
  // loopback in every spelling the URL parser accepts
  'https://127.0.0.1/',
  'https://127.1/',
  'https://0x7f000001/',
  'https://0x7f.1/',
  'https://2130706433/',
  'https://017700000001/',
  'https://0177.0.0.1/',
  'https://１２７.０.０.１/',
  'https://127。0。0。1/',
  'https://[::1]/',
  'https://[0:0:0:0:0:0:0:1]/',
  'https://[0000:0000:0000:0000:0000:0000:0000:0001]/',
  'https://[::ffff:127.0.0.1]/',
  'https://[::ffff:7f00:1]/',
  'https://[64:ff9b::7f00:1]/',
  'https://[2002:7f00:1::]/',
  'https://0.0.0.0/',
  'https://[::]/',
  // the cloud metadata services
  'https://169.254.169.254/latest/meta-data/',
  'https://[::ffff:169.254.169.254]/',
  'https://[fd00:ec2::254]/',
  'https://metadata.google.internal/computeMetadata/v1/',
  'https://metadata.goog/',
  'https://100.100.100.200/',
  // private, shared and special-use ranges
  'https://10.0.0.1/',
  'https://172.16.0.1/',
  'https://172.31.255.255/',
  'https://192.168.1.1/',
  'https://100.64.0.1/',
  'https://192.0.0.8/',
  'https://198.18.0.1/',
  'https://192.0.2.1/',
  'https://198.51.100.7/',
  'https://203.0.113.9/',
  'https://224.0.0.1/',
  'https://240.0.0.1/',
  'https://255.255.255.255/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[fd12:3456::1]/',
  'https://[fec0::1]/',
  'https://[ff02::1]/',
  'https://[2001:db8::1]/',
  'https://[2001::1]/',
  'https://[3fff::1]/',
  'https://[100::1]/',
  // names that are the local network
  'https://localhost/',
  'https://localhost./',
  'https://LOCALHOST/',
  'https://foo.localhost/',
  'https://a.b.LocalHost./',
  'https://printer.local/',
  'https://db.internal/',
  'https://nas.home.arpa/',
  'https://router.lan/',
  'https://wiki.corp/',
  'https://hr.intranet/',
  'https://fileserver/',
  'https://machine.localdomain/',
];

describe('webhook URL validation: the SSRF matrix', () => {
  for (const url of HOSTILE) {
    test(`refuses ${url}`, () => {
      const verdict = validateWebhookUrl(url, STRICT_URL_POLICY);
      expect(verdict).toMatchObject({ ok: false, code: 'host_not_allowed' });
    });
  }

  test('the dev policy lets every one of them through (and only the policy does)', () => {
    for (const url of HOSTILE) expect(validateWebhookUrl(url, DEV).ok).toBe(true);
  });

  test('the same URL with the scheme the strict policy forbids is refused for the scheme first', () => {
    expect(validateWebhookUrl('http://127.0.0.1/', STRICT_URL_POLICY)).toMatchObject({
      code: 'scheme_not_allowed',
    });
  });
});

describe('webhook URL validation: what is allowed', () => {
  test('a public https URL, with the host the sender connects to', () => {
    const verdict = validateWebhookUrl('https://Hooks.Example.COM./in?x=1#f', STRICT_URL_POLICY);
    expect(verdict).toMatchObject({
      ok: true,
      host: 'hooks.example.com',
      port: 443,
      literal: false,
    });
  });

  test('public addresses are literals and may be used', () => {
    expect(validateWebhookUrl('https://8.8.8.8:8443/x', STRICT_URL_POLICY)).toMatchObject({
      ok: true,
      host: '8.8.8.8',
      port: 8443,
      literal: true,
    });
    expect(validateWebhookUrl('https://[2606:4700:4700::1111]/', STRICT_URL_POLICY)).toMatchObject({
      ok: true,
      host: '2606:4700:4700::1111',
      literal: true,
    });
    expect(validateWebhookUrl('https://[::ffff:8.8.8.8]/', STRICT_URL_POLICY).ok).toBe(true);
  });

  test('http is allowed only when the policy says so', () => {
    expect(validateWebhookUrl('http://hooks.example.com/', STRICT_URL_POLICY).ok).toBe(false);
    expect(
      validateWebhookUrl('http://hooks.example.com/', { allowHttp: true, allowPrivate: false })
    ).toMatchObject({ ok: true, port: 80 });
  });

  test('other schemes, credentials and malformed input are refused with a code', () => {
    const refused = (url: unknown, code: string) =>
      expect(validateWebhookUrl(url, DEV)).toMatchObject({ ok: false, code });
    refused('ftp://example.com/', 'scheme_not_allowed');
    refused('file:///etc/passwd', 'scheme_not_allowed');
    refused('gopher://example.com/', 'scheme_not_allowed');
    refused('javascript:alert(1)', 'scheme_not_allowed');
    refused('https://user:pw@example.com/', 'credentials_not_allowed');
    refused('https://user@example.com/', 'credentials_not_allowed');
    refused('example.com/hook', 'invalid_url');
    refused('', 'invalid_url');
    refused(' https://example.com/', 'invalid_url');
    refused('https://example.com:99999/', 'invalid_url');
    refused('https://ex ample.com/', 'invalid_url');
    refused('https://1.2.3.4.5/', 'invalid_url');
    refused(`https://example.com/${'a'.repeat(2_048)}`, 'invalid_url');
    refused(undefined, 'invalid_url');
    refused(42, 'invalid_url');
  });

  test('a public name that merely contains a private word is fine', () => {
    for (const host of ['localhost.example.com', 'internal.example.com', 'my-local.dev']) {
      expect(validateWebhookUrl(`https://${host}/`, STRICT_URL_POLICY).ok).toBe(true);
    }
  });
});

describe('address checks (what a name resolved to)', () => {
  test('blocks every range, in every notation a resolver can return', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '::1',
      '::',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      'fe80::1%eth0',
      '[::1]',
      'not-an-ip',
      '1.2.3',
      '01.2.3.4',
      '1.2.3.256',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      '',
    ];
    for (const address of blocked) {
      expect(addressBlockReason(address), address).not.toBeNull();
    }
  });

  test('allows global unicast addresses', () => {
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '172.15.255.255',
      '172.32.0.1',
      '100.63.255.255',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '2a00:1450:4009:81f::200e',
      '[2606:4700::1]',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '2002:808:808::',
    ]) {
      expect(addressBlockReason(address), address).toBeNull();
    }
  });

  test('a name that resolves to any blocked address is refused, even among public ones', () => {
    expect(firstBlockedAddress(['93.184.216.34', '2606:4700::1'])).toBeNull();
    expect(firstBlockedAddress(['93.184.216.34', '127.0.0.1'])).toMatchObject({
      address: '127.0.0.1',
    });
    expect(firstBlockedAddress(['169.254.169.254'])?.reason).toContain('metadata');
    expect(firstBlockedAddress([])).toMatchObject({ reason: 'the name did not resolve' });
  });
});
