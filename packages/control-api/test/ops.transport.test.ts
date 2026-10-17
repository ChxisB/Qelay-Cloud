import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { NOTHING, reading, stubTransport } from './opsFixture';
import { errorOf, harness } from './support';
import type { Wire } from './transportHarness';
import { transportHarness } from './transportHarness';

describeDb('GET /transport', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());
  const { open, get } = transportHarness(() => f);

  test('puts the broker numbers next to the store numbers of each queue, each with its age', async () => {
    await enqueueN(f.store, 3, {}, 'emails');
    f.t.clock.advance(10_000);
    const now = f.t.clock.now();
    const api = open(stubTransport(() => reading(now)));
    const { status, body } = await get(api);
    expect(status).toBe(200);
    expect(body.transport).toEqual({
      name: 'gcp-pubsub',
      maxDeliverDelayMs: 0,
      ordering: 'none',
      approximateCounts: false,
    });
    expect(body.deadLetter).toEqual({ supported: true });
    expect(body.truncated).toBe(false);
    expect(body.queues).toHaveLength(1);
    expect(body.queues[0]).toMatchObject({
      queue: 'emails',
      doorbellDepth: 5,
      oldestUndeliveredAgeMs: 12_000,
      deadLetterDepth: 2,
      deadLetterOldestAgeMs: null,
      freshness: {
        observedAt: now - 120_000,
        ageMs: 120_000,
        maxStalenessMs: 330_000,
        source: 'cloud-monitoring',
      },
      store: { queue: 'emails', claimable: 3, notRung: 3, paused: false },
    });
    // 10 s ago they were enqueued, so the oldest has been waiting that long for a bell.
    expect(body.queues[0].store.oldestNotRungAgeMs).toBe(10_000);
  });

  test("carries the broker's in-flight and delayed counts, and null where it could not count them", async () => {
    await enqueueN(f.store, 1, {}, 'counted');
    await enqueueN(f.store, 1, {}, 'uncounted');
    const now = f.t.clock.now();
    const api = open(
      stubTransport((queue) =>
        queue === 'counted'
          ? reading(now, { inFlight: 3, delayed: 4 })
          : reading(now, { inFlight: null, delayed: null })
      )
    );
    const { body } = await get(api);
    const byQueue = new Map<string, Wire>(body.queues.map((row: Wire) => [row.queue, row]));
    expect(byQueue.get('counted')).toMatchObject({ inFlight: 3, delayed: 4 });
    // Not counted is unknown, never zero.
    expect(byQueue.get('uncounted')).toMatchObject({ inFlight: null, delayed: null });
  });

  test("says when the broker's counts are approximate, and that they are exact when it does not", async () => {
    await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    const sqs = await get(
      open(
        stubTransport(() => reading(now)),
        { approximate: true }
      )
    );
    expect(sqs.body.transport.approximateCounts).toBe(true);
    const other = await get(open(stubTransport(() => reading(now))));
    expect(other.body.transport.approximateCounts).toBe(false);
  });

  test('a number the broker did not give is null and its reading has no age', async () => {
    await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    const api = open(
      stubTransport(() => reading(now, { ...NOTHING, source: 'unavailable', maxStalenessMs: 0 }))
    );
    const { body } = await get(api);
    expect(body.queues[0]).toMatchObject({
      doorbellDepth: null,
      inFlight: null,
      delayed: null,
      oldestUndeliveredAgeMs: null,
      deadLetterDepth: null,
      freshness: { observedAt: null, ageMs: null, source: 'unavailable' },
    });
  });

  test('a broker that throws is unknown for that queue and does not fail the page', async () => {
    await enqueueN(f.store, 1, {}, 'a');
    await enqueueN(f.store, 1, {}, 'b');
    const now = f.t.clock.now();
    const api = open(
      stubTransport((queue) => {
        if (queue === 'a') throw new Error('postgres://user:hunter2@db/qelay is down');
        return reading(now);
      })
    );
    const { status, body } = await get(api);
    expect(status).toBe(200);
    const byQueue = new Map<string, Wire>(body.queues.map((row: Wire) => [row.queue, row]));
    expect(byQueue.get('a')).toMatchObject({
      doorbellDepth: null,
      freshness: { source: 'unavailable' },
    });
    expect(byQueue.get('b')).toMatchObject({ doorbellDepth: 5 });
    // The cause is logged by type, never by message: the message above has a password in it.
    const failures = api.recorded.warnings.filter(
      (entry) => entry.message === 'transport stats failed'
    );
    expect(failures).toEqual([
      { message: 'transport stats failed', fields: { queue: 'a', error: 'Error' } },
    ]);
    expect(JSON.stringify(api.recorded.warnings)).not.toContain('hunter2');
  });

  test('a transport with no dead-letter queue says so and reports no depth for one', async () => {
    await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    // The local transport counts failed jobs as its "dead letters": those are the store's, not a doorbell DLQ.
    const api = open(
      stubTransport(() => reading(now, { deadLetterDepth: 7 })),
      { dead: false }
    );
    const { body } = await get(api);
    expect(body.deadLetter).toEqual({ supported: false });
    expect(body.queues[0].deadLetterDepth).toBeNull();
    expect(body.queues[0].deadLetterOldestAgeMs).toBeNull();
  });

  test('a queue with nothing pending is zero without being asked, and a paused one is marked', async () => {
    await enqueueN(f.store, 2, {}, 'busy');
    await enqueueN(f.store, 1, {}, 'held');
    await f.store.pause('held');
    f.t.clock.advance(5_000);
    const now = f.t.clock.now();
    const api = open(stubTransport(() => reading(now)));
    const { body } = await get(api);
    const rows = new Map<string, Wire>(body.queues.map((row: Wire) => [row.queue, row.store]));
    expect(rows.get('busy')).toMatchObject({ claimable: 2, notRung: 2, paused: false });
    expect(rows.get('held')).toMatchObject({ claimable: 1, paused: true });
  });

  test('past the queue cap it lists the busy queues first and says it is truncated', async () => {
    await enqueueN(f.store, 1, {}, 'aaa-empty');
    await f.store.queues.config('aaa-empty');
    await enqueueN(f.store, 1, {}, 'aaa-done');
    const [claimed] = await f.store.claim('aaa-done', 'w', 1);
    await f.store.complete(claimed!.lease, 'ok');
    await enqueueN(f.store, 1, {}, 'zzz-busy');
    f.t.clock.advance(5_000);
    const now = f.t.clock.now();
    const api = open(
      stubTransport(() => reading(now)),
      { maxQueues: 2 }
    );
    const { body } = await get(api);
    expect(body.truncated).toBe(true);
    expect(body.queues).toHaveLength(2);
    // The queue with pending jobs is in even though it sorts last by name.
    expect(body.queues.map((row: Wire) => row.queue)).toContain('zzz-busy');
  });

  test('is read by a viewer', async () => {
    await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    const { status } = await get(
      open(
        stubTransport(() => reading(now)),
        { role: 'viewer' }
      )
    );
    expect(status).toBe(200);
  });

  test('keeps an answer for the cache time and reads again when asked to bypass it', async () => {
    await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    const transport = stubTransport(() => reading(now));
    const api = open(transport, { cacheMs: 5_000 });
    await get(api);
    await get(api);
    expect(transport.statsCalls).toHaveLength(1);
    const bypass = await api.call('GET', '/transport', { headers: { 'x-qelay-cache': 'bypass' } });
    expect(bypass.status).toBe(200);
    expect(transport.statsCalls).toHaveLength(2);
    f.t.clock.advance(5_000);
    await get(api);
    expect(transport.statsCalls).toHaveLength(3);
  });

  test('answers 501 when the deployment serves no jobs routes', async () => {
    const api = harness({ rateLimit: false }, {}, f.t.clock);
    const response = await api.call('GET', '/transport');
    expect(response.status).toBe(501);
    expect((await errorOf(response)).error.code).toBe('not_implemented');
  });
});
