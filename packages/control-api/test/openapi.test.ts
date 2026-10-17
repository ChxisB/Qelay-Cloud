import { describe, expect, test } from 'bun:test';
import type { PostgresStore } from '@qelay-cloud/store-postgres';
import { MemoryTransport } from '@qelay-cloud/transport-local';
import { documented, asSpecPath, keysFit, refs, spec } from './openapiSpec';
import { bodyOf, fakeReadiness, harness, sampleOverview, sampleStats } from './support';

// The routes of the core groups, which a build without a store serves. `/audit` and the two
// transport routes are among them: they answer 501 until their source is configured, so a client can
// tell "off" from "not there". `/deployment` works without a store and says what it cannot read.
const CORE = [
  'GET /health',
  'GET /health/ready',
  'GET /ready',
  'GET /capabilities',
  'GET /dashboard',
  'GET /stats',
  'GET /audit',
  'GET /transport',
  'GET /transport/dead-letters',
  'GET /deployment',
];

describe('docs/openapi.yaml', () => {
  test('a build without a store serves the core groups, and the document has them all', () => {
    const served = harness({}, { routes: [] }).app.routes.map(
      (route) => `${route.method} ${asSpecPath(route.path)}`
    );
    expect(served.sort()).toEqual([...CORE].sort());
    expect(documented()).toEqual(expect.arrayContaining(CORE));
  });

  test('a build with a store serves exactly the routes the document describes', () => {
    const jobs = {
      store: {} as PostgresStore,
      transport: new MemoryTransport(),
    };
    const served = harness({}, { routes: [], jobs }).app.routes.map(
      (route) => `${route.method} ${asSpecPath(route.path)}`
    );
    const missing = documented().filter((operation) => !served.includes(operation));
    const undocumented = served.filter((operation) => !documented().includes(operation));
    expect({ missing, undocumented }).toEqual({ missing: [], undocumented: [] });
  });

  test('the only operation with no token is GET /health, and it says so', () => {
    const open = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(
          ([, operation]) => Array.isArray(operation.security) && operation.security.length === 0
        )
        .map(([method]) => `${method.toUpperCase()} ${path}`)
    );
    expect(open).toEqual(['GET /health']);
    expect(spec.security).toEqual([{ bearer: [] }]);
  });

  test('a route that needs a token documents 401 and 403', () => {
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path === '/health') continue;
      for (const operation of Object.values(item)) {
        expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '403']));
      }
    }
  });

  test('every $ref resolves', () => {
    for (const ref of refs(spec)) {
      const [, section, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? [];
      expect(spec.components[section ?? '']?.[name ?? ''], ref).toBeDefined();
    }
  });

  // Not a schema validator: it pins the top-level keys of each body to the schema's `properties` and
  // `required`, which is where a field added to the code and forgotten in the spec shows up.
  describe('the bodies served have the keys the schemas name', () => {
    const reader = { overview: async () => sampleOverview(), stats: async () => sampleStats() };

    const cases: [string, string, () => Promise<Response>][] = [
      ['Health', 'GET /health', () => harness().call('GET', '/health', { token: null })],
      ['Readiness', 'GET /health/ready (ready)', () => harness().call('GET', '/health/ready')],
      [
        'Readiness',
        'GET /ready (not ready)',
        () =>
          harness(
            {},
            {
              readiness: fakeReadiness({
                database: async () => {
                  throw new Error('down');
                },
              }),
            }
          ).call('GET', '/ready'),
      ],
      ['Capabilities', 'GET /capabilities', () => harness().call('GET', '/capabilities')],
      [
        'DeploymentResponse',
        'GET /deployment',
        () => harness({ deployment: { cacheMs: 0 } }).call('GET', '/deployment'),
      ],
      [
        'Overview',
        'GET /dashboard',
        () => harness({}, { dashboard: reader }).call('GET', '/dashboard'),
      ],
      ['Stats', 'GET /stats', () => harness({}, { dashboard: reader }).call('GET', '/stats')],
      ['Error', 'GET /nowhere', () => harness().call('GET', '/nowhere')],
    ];

    test.each(cases)('%s: %s', async (name, _label, call) => {
      expect(keysFit(await bodyOf(await call()), name)).toEqual([]);
    });
  });
});
