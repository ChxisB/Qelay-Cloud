import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { PayloadTooComplexError, PayloadTooLargeError } from '../src/errors';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind } from './storeHelpers';

describeDb('enqueue: input and payload limits', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs`;
    rewind(t);
  });

  const rows = () => t.fresh.sql<Array<{ id: string }>>`SELECT id FROM qcloud_jobs ORDER BY id`;

  describe('input that cannot be admitted fails the whole call first', () => {
    const good = { queue: 'q', data: 1 };
    test.each([
      [
        'an unsupported option',
        { queue: 'q', data: 1, options: { repeat: { every: 1 } } as never },
      ],
      ['an unknown option', { queue: 'q', data: 1, options: { nope: 1 } as never }],
      ['an empty queue', { queue: '', data: 1 }],
      ['a queue with NUL', { queue: 'a\0b', data: 1 }],
      ['a queue over 256 characters', { queue: 'q'.repeat(257), data: 1 }],
      ['an empty name', { queue: 'q', name: '', data: 1 }],
      ['a lone surrogate in a name', { queue: 'q', name: 'a\uD800', data: 1 }],
      ['a custom id with NUL', { queue: 'q', data: 1, options: { jobId: 'a\0' } }],
      [
        'a custom id over 256 characters',
        { queue: 'q', data: 1, options: { jobId: 'j'.repeat(257) } },
      ],
      ['a dedup key with NUL', { queue: 'q', data: 1, options: { deduplication: { id: 'a\0' } } }],
      ['an empty group id', { queue: 'q', data: 1, options: { group: { id: '' } } }],
      ['an unsafe numeric group id', { queue: 'q', data: 1, options: { group: { id: 2 ** 60 } } }],
      [
        'a group id over 256 characters',
        { queue: 'q', data: 1, options: { group: { id: 'g'.repeat(257) } } },
      ],
    ])('%s', async (_label, bad) => {
      const error = await t.store.enqueue([good, bad, good]).catch((caught) => caught);
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect(await rows()).toHaveLength(0);
    });

    test('data the codec cannot encode names the job', async () => {
      const error = await t.store
        .enqueue([good, { queue: 'q', data: Symbol('x') }])
        .catch((e) => e);
      expect(error).toMatchObject({ code: 'STORE_ERROR' });
      expect(error.message).toMatch(/payload of job 1 cannot be encoded/);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('the payload', () => {
    test('a Date, a Map and a bigint come back as they went in', async () => {
      const data = {
        at: new Date('2026-10-14T00:00:00Z'),
        by: new Map<string, unknown>([['k', 2n ** 80n]]),
        count: 12n,
      };
      const [job] = await t.store.enqueue([{ queue: 'q', data }]);
      const back = (await t.store.getJob(job!.id))!.data as typeof data;
      expect(back.at).toEqual(data.at);
      expect(back.by).toEqual(data.by);
      expect(back.count).toBe(12n);
    });

    test('a __proto__ key stays a key and pollutes nothing', async () => {
      const data = JSON.parse('{"__proto__": {"admin": true}, "ok": 1}');
      const [job] = await t.store.enqueue([{ queue: 'q', data }]);
      const back = (await t.store.getJob(job!.id))!.data as Record<string, unknown>;
      expect(Object.getOwnPropertyDescriptor(back, '__proto__')?.value).toEqual({ admin: true });
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
      expect((back as { ok: number }).ok).toBe(1);
    });

    test('a payload over the limit is refused with its size and position, and nothing is admitted', async () => {
      const [probe] = await t.store.enqueue([{ queue: 'q', data: 'x'.repeat(100) }]);
      const size = (
        await t.fresh.sql<Array<{ n: number }>>`
        SELECT octet_length(payload) AS n FROM qcloud_jobs WHERE id = ${probe!.id}`
      )[0]!.n;
      await t.fresh.sql`TRUNCATE qcloud_jobs`;

      const exact = t.another({ maxPayloadBytes: size });
      expect(await exact.enqueue([{ queue: 'q', data: 'x'.repeat(100) }])).toHaveLength(1);
      const tight = t.another({ maxPayloadBytes: size - 1 });
      const error = await tight
        .enqueue([
          { queue: 'q', data: 1 },
          { queue: 'q', data: 'x'.repeat(100) },
        ])
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(PayloadTooLargeError);
      expect(error).toMatchObject({ size, limit: size - 1, index: 1 });
      expect(await rows()).toHaveLength(1);
    });

    test('a payload with too many values or too deep is refused whatever its size, and nothing is admitted', async () => {
      const small = t.another({ maxPayloadNodes: 5, maxPayloadDepth: 3 });
      const many = await small
        .enqueue([
          { queue: 'q', data: 1 },
          { queue: 'q', data: [1, 2, 3, 4, 5, 6] },
        ])
        .catch((caught) => caught);
      expect(many).toBeInstanceOf(PayloadTooComplexError);
      expect(many).toMatchObject({ kind: 'nodes', limit: 5, index: 1 });
      const deep = await small.enqueue([{ queue: 'q', data: [[[[1]]]] }]).catch((caught) => caught);
      expect(deep).toMatchObject({ kind: 'depth', limit: 3, index: 0 });
      expect(await rows()).toHaveLength(0);
      expect(await t.store.enqueue([{ queue: 'q', data: Array(19_000).fill(null) }])).toHaveLength(
        1
      );
      const million = await t.store
        .enqueue([{ queue: 'q', data: Array(1_000_000).fill(null) }])
        .catch((caught) => caught);
      expect(million).toBeInstanceOf(PayloadTooComplexError);
    });

    test('the default limit is 1 MiB', async () => {
      const error = await t.store
        .enqueue([{ queue: 'q', data: new Uint8Array(1024 * 1024) }])
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(PayloadTooLargeError);
      expect(error.limit).toBe(1024 * 1024);
    });
  });
});
