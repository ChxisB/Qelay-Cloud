import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { renderRoutes, routeTable } from '../../../scripts/security-routes';
import { bodyOf, DEV_TOKEN, harness } from './support';

/**
 * Task 72: each row of docs/security/routes.md, read from the routes the app serves, is held to what
 * it says. A stub store is enough: authentication and the role check run before any handler, and a
 * handler that is reached only has to be reached, not to succeed.
 */
const rows = routeTable();
const jobs = { store: {} as PostgresStore, transport: new MemoryTransport() };
const app = (role: 'viewer' | 'operator') =>
  harness({ devToken: { token: DEV_TOKEN, role } }, { routes: [], jobs });
const concrete = (path: string) => path.replace(/:[^/]+/g, 'x').replace(/\/\*$/, '/x');
// A stream does not end by itself: its access rules are in events.test.ts and events.limits.test.ts.
const streams = (path: string) => path.startsWith('/events');

describe('docs/security/routes.md', () => {
  test('is the table of the routes the app serves, and the table is large enough to mean something', async () => {
    expect(rows.length).toBeGreaterThan(90);
    expect(await Bun.file(`${import.meta.dir}/../../../docs/security/routes.md`).text()).toBe(
      renderRoutes(rows)
    );
  });

  test('exactly one route is public, and it is GET /health', () => {
    expect(rows.filter((row) => row.who === 'public').map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /health',
    ]);
  });

  test('no route answers without a valid token, and a bad token is not echoed', async () => {
    const api = app('operator');
    for (const row of rows.filter((r) => r.who !== 'public')) {
      const path = concrete(row.path);
      const none = await api.call(row.method, path, { token: null });
      expect([row.method, row.path, none.status]).toEqual([row.method, row.path, 401]);
      const bad = await api.call(row.method, path, { token: 'canary-not-a-token' });
      expect([row.method, row.path, bad.status]).toEqual([row.method, row.path, 401]);
      expect(await bad.text()).not.toContain('canary-not-a-token');
    }
  });

  test('a viewer is refused 403 on every operator route and let through on every other', async () => {
    const api = app('viewer');
    for (const row of rows.filter((r) => r.who !== 'public' && !streams(r.path))) {
      const answer = await api.call(row.method, concrete(row.path), {
        ...(row.method === 'GET' ? {} : { body: {} }),
      });
      if (row.who === 'operator') {
        expect([row.method, row.path, answer.status]).toEqual([row.method, row.path, 403]);
        expect((await bodyOf<{ error: { code: string } }>(answer)).error.code).toBe('forbidden');
      } else {
        expect([row.method, row.path, answer.status === 403 || answer.status === 401]).toEqual([
          row.method,
          row.path,
          false,
        ]);
      }
    }
  });

  test('an operator is refused on no route', async () => {
    const api = app('operator');
    for (const row of rows.filter((r) => r.who !== 'public' && !streams(r.path))) {
      const answer = await api.call(row.method, concrete(row.path), {
        ...(row.method === 'GET' ? {} : { body: {} }),
      });
      expect([row.method, row.path, answer.status === 403 || answer.status === 401]).toEqual([
        row.method,
        row.path,
        false,
      ]);
    }
  });
});
