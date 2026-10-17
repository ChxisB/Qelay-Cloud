import { describe, expect, test } from 'bun:test';
import type { Method, Route } from '../src';
import { Router } from '../src';

const route = (method: Method, path: string): Route => ({
  method,
  path,
  access: 'read',
  handle: () => path,
});
const found = (router: Router, method: string, path: string) => {
  const match = router.match(method, path);
  return match.kind === 'found' ? { path: match.route.path, params: match.params } : match.kind;
};

describe('Router', () => {
  const router = new Router([
    route('GET', '/queues/:queue'),
    route('GET', '/queues/summary'),
    route('DELETE', '/queues/:queue'),
    route('GET', '/queues/:queue/jobs/:id'),
    route('GET', '/'),
  ]);

  test('a literal segment beats a parameter, whatever the registration order', () => {
    expect(found(router, 'GET', '/queues/summary')).toEqual({
      path: '/queues/summary',
      params: {},
    });
    expect(found(router, 'GET', '/queues/emails')).toEqual({
      path: '/queues/:queue',
      params: { queue: 'emails' },
    });
  });

  test('parameters are percent-decoded', () => {
    expect(found(router, 'GET', '/queues/a%2Fb/jobs/1%3A2')).toEqual({
      path: '/queues/:queue/jobs/:id',
      params: { queue: 'a/b', id: '1:2' },
    });
  });

  test('a malformed escape, an empty parameter and a wrong segment count do not match', () => {
    expect(found(router, 'GET', '/queues/%E0%A4%A')).toBe('none');
    expect(found(router, 'GET', '/queues//jobs/1')).toBe('none');
    expect(found(router, 'GET', '/queues/a/jobs')).toBe('none');
    expect(found(router, 'GET', '/queues/a/jobs/1/extra')).toBe('none');
  });

  test('a known path with another method reports the methods that are allowed', () => {
    expect(router.match('PUT', '/queues/emails')).toEqual({
      kind: 'method',
      allowed: ['GET', 'DELETE'],
    });
  });

  test('the root and trailing slashes', () => {
    expect(found(router, 'GET', '/')).toEqual({ path: '/', params: {} });
    expect(found(router, 'GET', '/queues/summary/')).toEqual({
      path: '/queues/summary',
      params: {},
    });
  });

  test('a path is matched whole: no prefix, no case folding', () => {
    expect(found(router, 'GET', '/Queues/summary')).toBe('none');
    expect(found(router, 'GET', '/queues-extra')).toBe('none');
  });

  test('the same method and shape twice throws at construction, even with other parameter names', () => {
    expect(() => new Router([route('GET', '/a/:x'), route('GET', '/a/:y')])).toThrow(
      /registered twice/
    );
    expect(() => new Router([route('GET', '/a'), route('GET', '/a')])).toThrow(/registered twice/);
    expect(() => new Router([route('GET', '/a'), route('POST', '/a')])).not.toThrow();
  });

  test('a path must start with a slash', () => {
    expect(() => new Router([route('GET', 'a')])).toThrow(/start with/);
  });

  describe('a trailing wildcard', () => {
    const wild = new Router([
      route('GET', '/server/*'),
      route('GET', '/server/info'),
      route('GET', '/jobs/:id/logs'),
      route('GET', '/jobs/custom/:customId'),
      route('GET', '/jobs/:id'),
    ]);

    test('takes one or more segments and is tried last', () => {
      expect(found(wild, 'GET', '/server/info')).toEqual({ path: '/server/info', params: {} });
      expect(found(wild, 'GET', '/server/config/reload')).toEqual({
        path: '/server/*',
        params: {},
      });
      expect(found(wild, 'GET', '/server')).toBe('none');
    });

    test('a parameter later in the path loses to one earlier, so a literal prefix wins', () => {
      expect(found(wild, 'GET', '/jobs/custom/order-1')).toEqual({
        path: '/jobs/custom/:customId',
        params: { customId: 'order-1' },
      });
      expect(found(wild, 'GET', '/jobs/42/logs')).toEqual({
        path: '/jobs/:id/logs',
        params: { id: '42' },
      });
      expect(found(wild, 'GET', '/jobs/42')).toEqual({ path: '/jobs/:id', params: { id: '42' } });
    });

    test('only the last segment may be a wildcard', () => {
      expect(() => new Router([route('GET', '/a/*/b')])).toThrow(/last segment/);
    });
  });

  test('routes are listed back', () => {
    expect(router.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /queues/:queue',
      'GET /',
      'GET /queues/:queue',
      'GET /queues/:queue/jobs/:id',
      'GET /queues/summary',
    ]);
  });
});
