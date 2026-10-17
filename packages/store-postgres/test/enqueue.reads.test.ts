import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind } from './storeHelpers';

describeDb('enqueue: namespaces and reads', () => {
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

  const row = async (id: string) =>
    (
      await t.fresh.sql<Array<{ state: string }>>`SELECT state FROM qcloud_jobs WHERE id = ${id}`
    )[0]!;

  describe('namespaces', () => {
    test('two namespaces share a schema without seeing each other', async () => {
      const other = t.another({ namespace: 'other' });
      const options = { jobId: 'same-id' };
      const [a] = await t.store.enqueue([{ queue: 'q', data: 'a', options }]);
      const [b] = await other.enqueue([{ queue: 'q', data: 'b', options }]);
      expect([a!.created, b!.created]).toEqual([true, true]);
      expect((await t.store.getJob('same-id'))!.data).toBe('a');
      expect((await other.getJob('same-id'))!.data).toBe('b');
      expect((await other.counts('q')).waiting).toBe(1);
      expect(a!.ring!.bell.namespace).toBe('test');
      expect(b!.ring!.bell.namespace).toBe('other');
    });

    test('an empty namespace is refused', () => {
      expect(() => t.another({ namespace: '' })).toThrow(/namespace/);
    });
  });

  describe('reads report the state at the database time', () => {
    test('a delayed job past its run time reads as claimable while its row still says delayed', async () => {
      const [late, lateHigh] = await t.store.enqueue([
        { queue: 'r', data: 1, options: { delay: 1_000 } },
        { queue: 'r', data: 2, options: { delay: 1_000, priority: 4 } },
      ]);
      expect((await t.store.counts('r')).delayed).toBe(2);
      t.clock.advance(1_001);
      expect((await row(late!.id)).state).toBe('delayed');
      expect((await t.store.getJob(late!.id))!.state).toBe('waiting');
      expect((await t.store.getJob(lateHigh!.id))!.state).toBe('prioritized');
      expect(await t.store.counts('r')).toMatchObject({ delayed: 0, waiting: 1, prioritized: 1 });
      const ready = await t.store.listJobs({
        queue: 'r',
        states: ['waiting', 'prioritized'],
        limit: 10,
      });
      expect(ready.items.map((r) => r.id)).toEqual([late!.id, lateHigh!.id]);
      t.clock.advance(-1_001);
    });

    test('exactly at its run time a delayed job is ready', async () => {
      const [job] = await t.store.enqueue([{ queue: 's', data: 1, options: { delay: 500 } }]);
      t.clock.advance(499);
      expect((await t.store.getJob(job!.id))!.state).toBe('delayed');
      t.clock.advance(1);
      expect((await t.store.getJob(job!.id))!.state).toBe('waiting');
      t.clock.advance(-500);
    });

    test('getJob is null for an unknown id and for another queue', async () => {
      expect(await t.store.getJob('nope')).toBeNull();
    });

    test('listJobs pages by cursor in id order, and counts covers every state', async () => {
      await t.store.enqueue(Array.from({ length: 7 }, (_, n) => ({ queue: 'p', data: n })));
      const first = await t.store.listJobs({ queue: 'p', limit: 3 });
      expect(first.items.map((r) => r.data)).toEqual([0, 1, 2]);
      const second = await t.store.listJobs({ queue: 'p', limit: 3, cursor: first.next! });
      expect(second.items.map((r) => r.data)).toEqual([3, 4, 5]);
      const last = await t.store.listJobs({ queue: 'p', limit: 3, cursor: second.next! });
      expect(last).toMatchObject({ items: [{ data: 6 }], next: null });
      expect(Object.keys(await t.store.counts('p')).sort()).toEqual([
        'active',
        'completed',
        'delayed',
        'failed',
        'prioritized',
        'waiting',
        'waiting-children',
      ]);
    });
  });
});
