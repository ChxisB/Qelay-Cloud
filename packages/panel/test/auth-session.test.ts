import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  beginSession,
  endSession,
  hasSession,
  installSessionFetch,
  renewSession,
  resetSessionForTests,
  sessionHandle,
  setSessionTarget,
} from '../src/lib/auth/session';

const PAGE = 'https://panel.example.com/ops/';
const seen: Array<{ url: string; authorization: string | null }> = [];
const realFetch = globalThis.fetch;
let uninstall: () => void;

beforeEach(() => {
  seen.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  uninstall = installSessionFetch();
  setSessionTarget('https://api.example.com/v1', PAGE);
});

afterEach(() => {
  uninstall();
  globalThis.fetch = realFetch;
  resetSessionForTests();
});

const call = (url: string, authorization?: string) =>
  fetch(url, { headers: authorization ? { Authorization: authorization } : {} });

describe('the session fetch wrapper', () => {
  test('the handle is replaced by the live token on a request to the API', async () => {
    const handle = beginSession('tok-1');
    await call('https://api.example.com/v1/queues', `Bearer ${handle}`);
    expect(seen[0].authorization).toBe('Bearer tok-1');
  });

  test('a renewal changes the token on the wire and not the handle', async () => {
    const handle = beginSession('tok-1');
    renewSession('tok-2');
    expect(sessionHandle()).toBe(handle);
    await call('https://api.example.com/v1/queues', `Bearer ${handle}`);
    expect(seen[0].authorization).toBe('Bearer tok-2');
  });

  test('a request to another host keeps the handle: the token never leaves the API', async () => {
    const handle = beginSession('tok-1');
    await call('https://evil.example.net/v1/queues', `Bearer ${handle}`);
    await call('https://api.example.com.evil.net/v1/queues', `Bearer ${handle}`);
    expect(seen.map((request) => request.authorization)).toEqual([
      `Bearer ${handle}`,
      `Bearer ${handle}`,
    ]);
  });

  test('a relative API path resolves against the page', async () => {
    setSessionTarget('/api', PAGE);
    const handle = beginSession('tok-1');
    await call('/api/queues', `Bearer ${handle}`);
    expect(seen[0].authorization).toBe('Bearer tok-1');
  });

  test('another Authorization value is left alone', async () => {
    beginSession('tok-1');
    await call('https://api.example.com/v1/queues', 'Bearer something-else');
    await call('https://api.example.com/v1/queues');
    expect(seen.map((request) => request.authorization)).toEqual(['Bearer something-else', null]);
  });

  test('after sign-out the handle is no longer swapped', async () => {
    const handle = beginSession('tok-1');
    endSession();
    expect(hasSession()).toBe(false);
    await call('https://api.example.com/v1/queues', `Bearer ${handle}`);
    expect(seen[0].authorization).toBe(`Bearer ${handle}`);
  });

  test('every sign-in gets a new handle, and a handle is not the token', () => {
    const first = beginSession('tok-1');
    endSession();
    const second = beginSession('tok-1');
    expect(first).not.toBe(second);
    expect(first).not.toContain('tok-1');
  });
});
