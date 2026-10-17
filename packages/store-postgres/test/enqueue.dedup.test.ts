import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

interface Row {
  id: string;
  state: string;
  unique_key: string | null;
  unique_expires_at: string | null;
  version: string;
}

describeDb('enqueue: deduplication', () => {
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

  const sql = () => t.fresh.sql;
  const all = () => sql()<Row[]>`SELECT * FROM qcloud_jobs ORDER BY id`;
  const keyed = (key: string, extra: object = {}, data: unknown = key) => ({
    queue: 'q',
    data,
    options: { deduplication: { id: key, ...extra } },
  });

  test('a live job holding the key answers a second enqueue', async () => {
    const [first] = await t.store.enqueue([keyed('k', {}, 'one')]);
    const [second] = await t.store.enqueue([keyed('k', {}, 'two')]);
    expect(second).toEqual({ id: first!.id, created: false, state: 'waiting', ring: null });
    expect(await all()).toHaveLength(1);
    expect((await t.store.getJob(first!.id))!.data).toBe('one');
  });

  test('the key is scoped to the queue', async () => {
    const [a] = await t.store.enqueue([keyed('k')]);
    const [b] = await t.store.enqueue([{ ...keyed('k'), queue: 'other' }]);
    expect([a!.created, b!.created]).toEqual([true, true]);
  });

  test('a job without a ttl holds its key while it is live', async () => {
    const [first] = await t.store.enqueue([keyed('k')]);
    expect((await all())[0]).toMatchObject({ unique_key: 'k', unique_expires_at: null });
    t.clock.advance(10 * 365 * 24 * 3_600_000);
    expect((await t.store.enqueue([keyed('k')]))[0]).toMatchObject({
      id: first!.id,
      created: false,
    });
    t.clock.advance(-10 * 365 * 24 * 3_600_000);
  });

  test('a finished job no longer holds its key', async () => {
    const [first] = await t.store.enqueue([keyed('k')]);
    await sql()`UPDATE qcloud_jobs SET state = 'completed', unique_key = NULL WHERE id = ${first!.id}`;
    const [again] = await t.store.enqueue([keyed('k')]);
    expect(again!.created).toBe(true);
    expect(again!.id).not.toBe(first!.id);
  });

  describe('ttl', () => {
    test('the window ends at exactly created + ttl', async () => {
      const [first] = await t.store.enqueue([keyed('k', { ttl: 1_000 })]);
      expect((await all())[0]!.unique_expires_at).toBe(String(START + 1_000));
      t.clock.advance(999);
      expect((await t.store.enqueue([keyed('k', { ttl: 1_000 })]))[0]).toMatchObject({
        id: first!.id,
        created: false,
      });
      t.clock.advance(1);
      const [after] = await t.store.enqueue([keyed('k', { ttl: 1_000 })]);
      expect(after!.created).toBe(true);
      expect(after!.id).not.toBe(first!.id);
      t.clock.advance(-1_000);
    });

    test('an expired holder keeps running without its key, and is not deleted', async () => {
      const [first] = await t.store.enqueue([keyed('k', { ttl: 100 })]);
      t.clock.advance(100);
      await t.store.enqueue([keyed('k', { ttl: 100 })]);
      const rows = await all();
      expect(rows).toHaveLength(2);
      const released = rows.find((r) => r.id === first!.id)!;
      expect(released).toMatchObject({
        state: 'waiting',
        unique_key: null,
        unique_expires_at: null,
      });
      expect(released.version).toBe('1');
      expect(rows.find((r) => r.id !== first!.id)).toMatchObject({ unique_key: 'k' });
      t.clock.advance(-100);
    });
  });

  describe('extend', () => {
    test('a duplicate with extend moves the window to now + ttl', async () => {
      const [first] = await t.store.enqueue([keyed('k', { ttl: 1_000, extend: true })]);
      t.clock.advance(600);
      const [dup] = await t.store.enqueue([keyed('k', { ttl: 1_000, extend: true })]);
      expect(dup).toMatchObject({ id: first!.id, created: false });
      expect((await all())[0]).toMatchObject({
        unique_expires_at: String(START + 600 + 1_000),
        version: '1',
      });
      t.clock.advance(900);
      expect((await t.store.enqueue([keyed('k', { ttl: 1_000 })]))[0]!.created).toBe(false);
      t.clock.advance(-1_500);
    });

    test('without extend the window stays where it was', async () => {
      await t.store.enqueue([keyed('k', { ttl: 1_000 })]);
      t.clock.advance(600);
      await t.store.enqueue([keyed('k', { ttl: 1_000 })]);
      expect((await all())[0]).toMatchObject({
        unique_expires_at: String(START + 1_000),
        version: '0',
      });
      t.clock.advance(-600);
    });

    test('extend without a ttl has nothing to move', async () => {
      await t.store.enqueue([keyed('k', { extend: true })]);
      await t.store.enqueue([keyed('k', { extend: true })]);
      expect((await all())[0]).toMatchObject({ unique_expires_at: null, version: '0' });
    });

    test('a later extend in the same call wins, and a window extended over a job planned in the call', async () => {
      const results = await t.store.enqueue([
        keyed('k', { ttl: 1_000 }),
        keyed('k', { ttl: 5_000, extend: true }),
      ]);
      expect(results.map((r) => r.created)).toEqual([true, false]);
      expect((await all())[0]!.unique_expires_at).toBe(String(START + 5_000));
    });
  });

  describe('replace', () => {
    test('a waiting holder is deleted and the new job takes the key', async () => {
      const [old] = await t.store.enqueue([keyed('k', {}, 'old')]);
      const [fresh] = await t.store.enqueue([keyed('k', { replace: true }, 'new')]);
      expect(fresh!.created).toBe(true);
      expect(fresh!.id).not.toBe(old!.id);
      expect(await t.store.getJob(old!.id)).toBeNull();
      expect((await all()).map((r) => r.unique_key)).toEqual(['k']);
      expect((await t.store.getJob(fresh!.id))!.data).toBe('new');
    });

    test('a delayed holder is deleted too', async () => {
      const [old] = await t.store.enqueue([
        { ...keyed('k'), options: { deduplication: { id: 'k' }, delay: 10_000 } },
      ]);
      await t.store.enqueue([keyed('k', { replace: true })]);
      expect(await t.store.getJob(old!.id)).toBeNull();
    });

    test('an active holder keeps running with no key, and the new job takes the key', async () => {
      const [old] = await t.store.enqueue([keyed('k', {}, 'old')]);
      await sql()`UPDATE qcloud_jobs SET state = 'active', attempts = 1 WHERE id = ${old!.id}`;
      const [fresh] = await t.store.enqueue([keyed('k', { replace: true }, 'new')]);
      expect(fresh!.created).toBe(true);
      expect(await all()).toHaveLength(2);
      expect((await t.store.getJob(old!.id))!.state).toBe('active');
      expect((await all()).find((r) => r.id === old!.id)).toMatchObject({
        unique_key: null,
        unique_expires_at: null,
      });
    });

    test('replace with no holder is just an enqueue', async () => {
      const [job] = await t.store.enqueue([keyed('k', { replace: true })]);
      expect(job!.created).toBe(true);
    });

    test('a holder that was planned earlier in the same call is cancelled, not inserted', async () => {
      const [a, b] = await t.store.enqueue([
        keyed('k', {}, 'a'),
        keyed('k', { replace: true }, 'b'),
      ]);
      expect([a!.created, b!.created]).toEqual([true, true]);
      expect(a!.ring).toBeNull();
      expect(b!.ring).not.toBeNull();
      const rows = await all();
      expect(rows.map((r) => r.id)).toEqual([b!.id]);
      expect(await t.store.getJob(a!.id)).toBeNull();
    });

    test('three in a row leave only the last', async () => {
      const results = await t.store.enqueue([
        keyed('k', { replace: true }, 1),
        keyed('k', { replace: true }, 2),
        keyed('k', { replace: true }, 3),
      ]);
      expect(results.map((r) => r.created)).toEqual([true, true, true]);
      const rows = await t.store.listJobs({ queue: 'q', limit: 10 });
      expect(rows.items.map((r) => r.data)).toEqual([3]);
    });
  });

  test('a duplicate of a replaced job in the same call is a duplicate of the replacement', async () => {
    const [a, b, c] = await t.store.enqueue([
      keyed('k', {}, 'a'),
      keyed('k', { replace: true }, 'b'),
      keyed('k', {}, 'c'),
    ]);
    expect(c).toMatchObject({ id: b!.id, created: false });
    expect(a!.created).toBe(true);
  });

  test('custom id wins over a dedup key: a live custom id is a duplicate before the key is looked at', async () => {
    await t.store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'j' } }]);
    await t.store.enqueue([keyed('k')]);
    const [again] = await t.store.enqueue([
      { queue: 'q', data: 2, options: { jobId: 'j', deduplication: { id: 'k', replace: true } } },
    ]);
    expect(again).toMatchObject({ id: 'j', created: false });
    expect(await all()).toHaveLength(2);
  });

  test('a replaced holder frees the id for a custom-id job in the same call', async () => {
    await t.store.enqueue([keyed('k', {}, 'old')]);
    const [fresh] = await t.store.enqueue([
      {
        queue: 'q',
        data: 'new',
        options: { jobId: 'mine', deduplication: { id: 'k', replace: true } },
      },
    ]);
    expect(fresh).toMatchObject({ id: 'mine', created: true });
    expect((await all()).map((r) => r.id)).toEqual(['mine']);
  });

  test('a group-capped job replaced by the same key does not count twice', async () => {
    const group = { id: 'g', maxSize: 1 };
    const first = (extra: object) => ({
      queue: 'q',
      data: 1,
      options: { group, deduplication: { id: 'k', ...extra } },
    });
    await t.store.enqueue([first({})]);
    const [swapped] = await t.store.enqueue([first({ replace: true })]);
    expect(swapped!.created).toBe(true);
    expect((await t.store.counts('q')).waiting).toBe(1);
  });
});
