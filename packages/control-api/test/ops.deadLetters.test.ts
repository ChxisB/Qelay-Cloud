import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Bell } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { enqueueN } from '../../store-postgres/test/storeHelpers';
import type { JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { reading, stubTransport } from './opsFixture';
import { transportHarness } from './transportHarness';

describeDb('GET /transport/dead-letters', () => {
  let f: JobsFixture;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(() => f.reset());
  const { open, get } = transportHarness(() => f);

  const bellFor = (jobId: string | undefined, queue = 'q'): Bell =>
    jobId === undefined ? { namespace: 'test', queue } : { namespace: 'test', queue, jobId };

  test('lists the poison bells with their delivery count and whether the job still exists', async () => {
    const [jobId] = await enqueueN(f.store, 1);
    const now = f.t.clock.now();
    const transport = stubTransport(() => reading(now), {
      peek: async () => [
        { bell: bellFor(jobId), deliveryCount: 5, deadLetteredAt: now - 30_000 },
        { bell: bellFor('gone-job'), deliveryCount: null, deadLetteredAt: null },
        { bell: null, deliveryCount: 5, deadLetteredAt: now - 1_000 },
      ],
    });
    const { status, body } = await get(open(transport), '/transport/dead-letters?queue=q&limit=10');
    expect(status).toBe(200);
    expect(transport.peeks).toEqual([{ queue: 'q', limit: 10 }]);
    expect(body).toMatchObject({ ok: true, queue: 'q', available: true, reason: null });
    expect(body.items).toEqual([
      {
        jobId,
        queue: 'q',
        deliveryCount: 5,
        deadLetteredAt: now - 30_000,
        ageMs: 30_000,
        jobExists: true,
      },
      {
        jobId: 'gone-job',
        queue: 'q',
        deliveryCount: null,
        deadLetteredAt: null,
        ageMs: null,
        jobExists: false,
      },
      {
        jobId: null,
        queue: 'q',
        deliveryCount: 5,
        deadLetteredAt: now - 1_000,
        ageMs: 1_000,
        jobExists: false,
      },
    ]);
  });

  test('an empty dead-letter queue is available and empty, which is not the same as unavailable', async () => {
    const now = f.t.clock.now();
    const { body } = await get(
      open(stubTransport(() => reading(now), { peek: async () => [] })),
      '/transport/dead-letters?queue=q'
    );
    expect(body).toMatchObject({ available: true, reason: null, items: [] });
  });

  test('a broker that cannot be read is "unreachable", never an empty list', async () => {
    const now = f.t.clock.now();
    const transport = stubTransport(() => reading(now), {
      peek: async () => {
        throw new Error('permission denied for projects/p/subscriptions/s');
      },
    });
    const { status, body } = await get(open(transport), '/transport/dead-letters?queue=q');
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: false, reason: 'unreachable', items: [] });
  });

  test('a transport that cannot peek, or has no dead-letter queue, is "not_supported"', async () => {
    const now = f.t.clock.now();
    const noPeek = await get(
      open(stubTransport(() => reading(now))),
      '/transport/dead-letters?queue=q'
    );
    expect(noPeek.body).toMatchObject({ available: false, reason: 'not_supported' });
    const none = stubTransport(() => reading(now), { peek: async () => [] });
    const declared = await get(open(none, { dead: false }), '/transport/dead-letters?queue=q');
    expect(declared.body).toMatchObject({ available: false, reason: 'not_supported' });
    expect(none.peeks).toEqual([]);
  });

  test('needs the operator role, because it reads the broker and names jobs', async () => {
    const now = f.t.clock.now();
    const transport = stubTransport(() => reading(now), { peek: async () => [] });
    const response = await open(transport, { role: 'viewer' }).call(
      'GET',
      '/transport/dead-letters?queue=q'
    );
    expect(response.status).toBe(403);
    expect(transport.peeks).toEqual([]);
  });

  test.each([
    ['no queue', '/transport/dead-letters'],
    ['a limit of zero', '/transport/dead-letters?queue=q&limit=0'],
    ['a limit past the cap', '/transport/dead-letters?queue=q&limit=101'],
  ])('refuses %s', async (_name, path) => {
    const now = f.t.clock.now();
    const transport = stubTransport(() => reading(now), { peek: async () => [] });
    const response = await open(transport).call('GET', path);
    expect(response.status).toBe(400);
    expect(transport.peeks).toEqual([]);
  });
});
