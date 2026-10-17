import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PANEL_CONFIG,
  findSecretLikeKey,
  loadPanelConfig,
  PanelConfigError,
  parsePanelConfig,
} from '../src/lib/panelConfig';

const respond = (body: string, init: ResponseInit = {}) =>
  (() =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
      })
    )) as unknown as typeof fetch;

describe('parsePanelConfig', () => {
  test('an empty file is the development default: token mode, no API URL', () => {
    expect(parsePanelConfig({})).toEqual({ apiBaseUrl: null, auth: { mode: 'token' } });
  });

  test('OIDC settings are read, with the scope defaulted', () => {
    expect(
      parsePanelConfig({
        apiBaseUrl: 'https://api.example.com/',
        auth: { mode: 'oidc', authority: 'https://idp.example.com/realm', clientId: 'panel' },
      })
    ).toEqual({
      apiBaseUrl: 'https://api.example.com',
      auth: {
        mode: 'oidc',
        authority: 'https://idp.example.com/realm',
        clientId: 'panel',
        scope: 'openid profile',
      },
    });
  });

  test('a relative API path is accepted', () => {
    expect(parsePanelConfig({ apiBaseUrl: '/api' }).apiBaseUrl).toBe('/api');
  });

  test.each([
    [
      'a client secret',
      { auth: { mode: 'oidc', authority: 'https://i', clientId: 'c', clientSecret: 'x' } },
    ],
    ['a token', { auth: { mode: 'token', token: 'abc' } }],
    ['a password', { password: 'x' }],
    ['an API key', { apiKey: 'x' }],
  ])('%s is refused by name, before anything else is checked', (_name, value) => {
    expect(() => parsePanelConfig(value)).toThrow(PanelConfigError);
    expect(() => parsePanelConfig(value)).toThrow('must not hold secrets');
  });

  test('the secret scan reports the path of the key', () => {
    expect(findSecretLikeKey({ auth: { client_secret: 'x' } })).toBe('auth.client_secret');
    expect(findSecretLikeKey({ apiBaseUrl: '/api', auth: { mode: 'token' } })).toBeNull();
  });

  test.each([
    [
      'an insecure authority',
      { auth: { mode: 'oidc', authority: 'http://idp.example.com', clientId: 'c' } },
    ],
    ['no client id', { auth: { mode: 'oidc', authority: 'https://idp.example.com' } }],
    ['an unknown mode', { auth: { mode: 'basic' } }],
    ['an unknown key', { theme: 'dark' }],
    ['a base URL with credentials', { apiBaseUrl: 'https://u:p@api.example.com' }],
  ])('%s is a configuration error', (_name, value) => {
    expect(() => parsePanelConfig(value)).toThrow(PanelConfigError);
  });

  test('a loopback http authority is allowed for local development', () => {
    expect(
      parsePanelConfig({
        auth: { mode: 'oidc', authority: 'http://localhost:8081/r', clientId: 'c' },
      }).auth.mode
    ).toBe('oidc');
  });
});

describe('loadPanelConfig', () => {
  const base = 'https://panel.example.com/ops/';

  test('requests config.json next to the page, without credentials or cache', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(
        new Response('{}', { headers: { 'content-type': 'application/json' } })
      );
    }) as unknown as typeof fetch;
    await loadPanelConfig(fetchImpl, base);
    expect(seen?.url).toBe('https://panel.example.com/ops/config.json');
    expect(seen?.init?.credentials).toBe('omit');
    expect(seen?.init?.cache).toBe('no-store');
  });

  test('404 is the development default', async () => {
    const fetchImpl = respond('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    });
    expect(await loadPanelConfig(fetchImpl, base)).toBe(DEFAULT_PANEL_CONFIG);
  });

  test('a static host that answers with the SPA page is the same as no file', async () => {
    const fetchImpl = respond('<!doctype html>', { headers: { 'content-type': 'text/html' } });
    expect(await loadPanelConfig(fetchImpl, base)).toBe(DEFAULT_PANEL_CONFIG);
  });

  test('a file that is there and malformed is an error, not a default', async () => {
    await expect(loadPanelConfig(respond('{nope'), base)).rejects.toThrow('not valid JSON');
    await expect(loadPanelConfig(respond('{"theme":1}'), base)).rejects.toThrow(PanelConfigError);
    await expect(loadPanelConfig(respond('', { status: 500 }), base)).rejects.toThrow('HTTP 500');
  });

  test('a network failure is an error with advice', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    await expect(loadPanelConfig(fetchImpl, base)).rejects.toThrow('could not be fetched');
  });
});
