import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { api } from '../src/lib/api';
import { OpsParseError } from '../src/lib/ops/types';
import { deployment, queue, transport } from './ops.helpers';

const realFetch = globalThis.fetch;
let seen: Array<{ path: string; method: string; authorization: string | null }> = [];
let respond: () => Response = () => Response.json({});

beforeEach(() => {
  seen = [];
  useConnectionStore.setState({
    baseUrl: 'http://api.test',
    token: 'viewer-token',
    agentToken: '',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      authorization: request.headers.get('authorization'),
    });
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
});

describe('the ops client', () => {
  test('reads each endpoint with GET and the connection token', async () => {
    respond = () => Response.json(transport([queue('q')]));
    await api.transport();
    respond = () => Response.json(deployment());
    await api.deployment();
    respond = () =>
      Response.json({ queue: 'q', available: true, reason: null, items: [], timestamp: 1 });
    await api.transportDeadLetters('q');
    expect(seen.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/transport'],
      ['GET', '/deployment'],
      ['GET', '/transport/dead-letters?queue=q&limit=25'],
    ]);
    expect(seen.every((r) => r.authorization === 'Bearer viewer-token')).toBe(true);
  });

  test('encodes a queue name that holds reserved characters', async () => {
    respond = () =>
      Response.json({ queue: 'a/b?c', available: true, reason: null, items: [], timestamp: 1 });
    await api.transportDeadLetters('a/b?c', 5);
    expect(seen[0]!.path).toBe('/transport/dead-letters?queue=a%2Fb%3Fc&limit=5');
  });

  test('refuses an answer of the wrong shape instead of guessing', async () => {
    respond = () => Response.json({ ok: true, tick: 'fine' });
    await expect(api.deployment()).rejects.toBeInstanceOf(OpsParseError);
    respond = () => Response.json({ queues: 'many' });
    await expect(api.transport()).rejects.toBeInstanceOf(OpsParseError);
  });

  test('an error status is an error, whatever the body says', async () => {
    respond = () =>
      Response.json({ error: { code: 'forbidden', message: 'operators only' } }, { status: 403 });
    await expect(api.transportDeadLetters('q')).rejects.toThrow();
  });
});
