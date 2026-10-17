import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PubSub } from '@google-cloud/pubsub';
import type { DeadLetterAge, TransportStats } from '@qelay-cloud/core';
import { deadLetterOldestAgeMs } from '@qelay-cloud/core';
import { GRPC_ONLY, MONITORING_LAG_MS, PubSubTransport, queueNames } from '../src';

const UNDELIVERED = 'pubsub.googleapis.com/subscription/num_undelivered_messages';
const OLDEST = 'pubsub.googleapis.com/subscription/oldest_unacked_message_age';
const NAMESPACE = 'prod';
const names = queueNames(NAMESPACE, 'emails');

interface Seen {
  readonly url: URL;
  readonly authorization: string | null;
}

function series(metric: string, subscription: string, points: [string, Record<string, unknown>][]) {
  return {
    metric: { type: metric },
    resource: { type: 'pubsub_subscription', labels: { subscription_id: subscription } },
    points: points.map(([endTime, value]) => ({ interval: { endTime }, value })),
  };
}

const HEALTHY = {
  timeSeries: [
    series(UNDELIVERED, names.subscription, [
      ['2026-10-14T10:00:00Z', { int64Value: '7' }],
      ['2026-10-14T10:02:00Z', { int64Value: '9' }],
      ['2026-10-14T10:01:00Z', { int64Value: '8' }],
    ]),
    series(OLDEST, names.subscription, [['2026-10-14T10:02:00Z', { doubleValue: 12.5 }]]),
    series(UNDELIVERED, names.deadLetterSubscription, [
      ['2026-10-14T10:01:00Z', { int64Value: '2' }],
    ]),
    series(OLDEST, names.deadLetterSubscription, [['2026-10-14T10:02:00Z', { doubleValue: 90 }]]),
  ],
};

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[];
let answer: () => Response | Promise<Response>;
let errors: { error: Error; source: string }[];
const open: PubSubTransport[] = [];

function make(
  options: { cacheMs?: number; timeoutMs?: number; token?: string | null } = {}
): PubSubTransport {
  const transport = new PubSubTransport({
    namespace: NAMESPACE,
    // Nothing here ever reaches a broker: `stats` talks to the stub only.
    client: new PubSub({
      projectId: 'proj-1',
      apiEndpoint: '127.0.0.1:1',
      emulatorMode: true,
      ...GRPC_ONLY,
    }),
    monitoring: {
      endpoint: `http://127.0.0.1:${server.port}`,
      getAccessToken: async () => (options.token === undefined ? 'test-token' : options.token),
      cacheMs: options.cacheMs ?? 30_000,
      timeoutMs: options.timeoutMs ?? 2_000,
    },
    onError: (error, source) => errors.push({ error, source }),
  });
  open.push(transport);
  return transport;
}

function allNull(stats: TransportStats): void {
  expect(stats.depth).toBeNull();
  expect(stats.inFlight).toBeNull();
  expect(stats.delayed).toBeNull();
  expect(stats.oldestAgeMs).toBeNull();
  expect(stats.deadLetterDepth).toBeNull();
}

describe('PubSubTransport.stats', () => {
  beforeEach(() => {
    seen = [];
    errors = [];
    answer = () => Response.json(HEALTHY);
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          url: new URL(request.url),
          authorization: request.headers.get('authorization'),
        });
        return answer();
      },
    });
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((transport) => transport.close()));
    await server.stop(true);
  });

  test('reads depth, age and dead-letter depth from the newest point of each series', async () => {
    const before = Date.now();
    const stats = await make().stats('emails');
    const expected: TransportStats & DeadLetterAge = {
      depth: 9,
      delayed: 0,
      inFlight: null,
      oldestAgeMs: 12_500,
      deadLetterDepth: 2,
      deadLetterOldestAgeMs: 90_000,
      source: 'cloud-monitoring',
      // The oldest of the newest points: the numbers are no fresher than their stalest part.
      observedAt: Date.parse('2026-10-14T10:01:00Z'),
      maxStalenessMs: MONITORING_LAG_MS + 30_000,
    };
    expect(stats).toEqual(expected);
    expect(deadLetterOldestAgeMs(stats)).toBe(90_000);
    expect(stats.observedAt).toBeLessThan(before);
  });

  test('asks the right project, with the caller credentials, for the right series', async () => {
    await make().stats('emails');
    expect(seen).toHaveLength(1);
    const { url, authorization } = seen[0] as Seen;
    expect(authorization).toBe('Bearer test-token');
    expect(url.pathname).toBe('/v3/projects/proj-1/timeSeries');
    const filter = url.searchParams.get('filter') ?? '';
    expect(filter).toContain('resource.type = "pubsub_subscription"');
    expect(filter).toContain(`resource.labels.subscription_id = "${names.subscription}"`);
    expect(filter).toContain(`resource.labels.subscription_id = "${names.deadLetterSubscription}"`);
    expect(filter).toContain(`metric.type = "${UNDELIVERED}"`);
    expect(filter).toContain(`metric.type = "${OLDEST}"`);
    // The dead-letter subscription is asked for its oldest age too, not only its depth.
    const dead = filter.slice(filter.indexOf(names.deadLetterSubscription));
    expect(dead).toContain(`metric.type = "${OLDEST}"`);
    const end = Date.parse(url.searchParams.get('interval.endTime') ?? '');
    const start = Date.parse(url.searchParams.get('interval.startTime') ?? '');
    expect(end - start).toBeGreaterThanOrEqual(5 * 60_000);
    expect(Math.abs(end - Date.now())).toBeLessThan(5_000);
  });

  test('reuses a reading for the cache time, shares one request between concurrent callers, and reads each queue once', async () => {
    const transport = make({ cacheMs: 60_000 });
    const [a, b, c] = await Promise.all([
      transport.stats('emails'),
      transport.stats('emails'),
      transport.stats('emails'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await transport.stats('emails');
    expect(seen).toHaveLength(1);
    await transport.stats('sms');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url.searchParams.get('filter')).toContain(
      queueNames(NAMESPACE, 'sms').subscription
    );
  });

  test('reads again once the cache time has passed', async () => {
    const transport = make({ cacheMs: 40 });
    await transport.stats('emails');
    await Bun.sleep(80);
    await transport.stats('emails');
    expect(seen).toHaveLength(2);
  });

  test('a series that is missing is unknown, never zero', async () => {
    answer = () => Response.json({ timeSeries: [HEALTHY.timeSeries[0]] });
    const stats = await make().stats('emails');
    expect(stats.depth).toBe(9);
    expect(stats.oldestAgeMs).toBeNull();
    expect(stats.deadLetterDepth).toBeNull();
    answer = () => Response.json({});
    allNull(await make().stats('sms'));
    expect(errors).toHaveLength(0);
  });

  test('a series of another subscription is not this queue', async () => {
    const other = queueNames(NAMESPACE, 'sms');
    answer = () =>
      Response.json({
        timeSeries: [
          series(UNDELIVERED, other.subscription, [['2026-10-14T10:00:00Z', { int64Value: '99' }]]),
        ],
      });
    allNull(await make().stats('emails'));
  });

  const failures: [string, () => Response | Promise<Response>, RegExp][] = [
    [
      'a missing permission',
      () => new Response('{"error":{"message":"secret detail"}}', { status: 403 }),
      /answered 403/,
    ],
    ['a server error', () => new Response('oops', { status: 500 }), /answered 500/],
    ['a quota error', () => new Response('slow down', { status: 429 }), /answered 429/],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), /./],
    [
      'a body that is not an object',
      () => Response.json([1, 2, 3]),
      /something other than an object/,
    ],
    ['a timeSeries that is not a list', () => Response.json({ timeSeries: 'none' }), /not a list/],
    ['an answer that never comes', () => new Promise<Response>(() => {}), /./],
  ];
  for (const [what, respond, message] of failures) {
    test(`${what} degrades to unknown, reports once, and never throws`, async () => {
      answer = respond;
      const stats = await make({ timeoutMs: 300 }).stats('emails');
      allNull(stats);
      expect(stats.source).toBe('cloud-monitoring');
      expect(stats.maxStalenessMs).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.source).toBe('stats');
      expect(errors[0]?.error.message).toMatch(message);
      // A response body can echo what was asked: it is not copied into the report.
      expect(errors[0]?.error.message).not.toContain('secret detail');
    });
  }

  test('no credentials is a report, not an exception', async () => {
    allNull(await make({ token: null }).stats('emails'));
    expect(errors[0]?.error.message).toMatch(/no access token/);
    expect(seen).toHaveLength(0);
  });

  test('a failing API is not asked again at once, and is asked again after a while', async () => {
    answer = () => new Response('nope', { status: 503 });
    const transport = make({ cacheMs: 60 });
    allNull(await transport.stats('emails'));
    allNull(await transport.stats('emails'));
    expect(seen).toHaveLength(1);
    await Bun.sleep(100);
    answer = () => Response.json(HEALTHY);
    expect((await transport.stats('emails')).depth).toBe(9);
    expect(seen).toHaveLength(2);
  });

  test('no monitoring configured on an emulator, or turned off, answers unavailable without a request', async () => {
    for (const monitoring of [undefined, false] as const) {
      const transport = new PubSubTransport({
        namespace: NAMESPACE,
        client: new PubSub({
          projectId: 'proj-1',
          apiEndpoint: '127.0.0.1:1',
          emulatorMode: true,
          ...GRPC_ONLY,
        }),
        ...(monitoring === undefined ? {} : { monitoring }),
      });
      const stats = await transport.stats('emails');
      allNull(stats);
      expect(stats.source).toBe('unavailable');
      expect(stats.maxStalenessMs).toBe(0);
      await transport.close();
    }
    expect(seen).toHaveLength(0);
  });

  test('a queue that cannot be a subscription name is unknown, not an exception', async () => {
    allNull(await make().stats(''));
    expect(errors[0]?.source).toBe('stats');
  });
});
