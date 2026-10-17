import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { createMsgpackCodec } from '../src/codec';
import { GroupFullError } from '../src/errors';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind } from './storeHelpers';

interface Row {
  id: string;
  group_id: string | null;
  group_order: string | null;
  priority: number;
  state: string;
}

describeDb('enqueue: groups', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs`;
    rewind(t);
  });

  const sql = () => t.fresh.sql;
  const rows = () =>
    sql()<Row[]>`SELECT id, group_id, group_order, priority, state FROM qcloud_jobs ORDER BY id`;
  const grouped = (id: string | number, extra: object = {}, queue = 'q', data: unknown = id) => ({
    queue,
    data,
    options: { group: { id, ...extra } },
  });

  describe('maxSize', () => {
    test('a job that would exceed the group is refused with the group and the position', async () => {
      await t.store.enqueue([grouped('g', { maxSize: 2 }), grouped('g', { maxSize: 2 })]);
      const error = await t.store.enqueue([grouped('g', { maxSize: 2 })]).catch((e) => e);
      expect(error).toBeInstanceOf(GroupFullError);
      expect(error).toMatchObject({
        queue: 'q',
        groupId: 'g',
        maxSize: 2,
        index: 0,
        code: 'STORE_ERROR',
      });
      expect(error.message).toBe(
        'group g of queue q has reached its maximum size of 2 (job 0). Nothing was admitted.'
      );
    });

    test('the refusal rolls back the whole call, including the jobs before it', async () => {
      await t.store.enqueue([grouped('g', { maxSize: 2 })]);
      const error = await t.store
        .enqueue([
          { queue: 'q', data: 'plain' },
          grouped('g', { maxSize: 2 }),
          grouped('g', { maxSize: 2 }),
        ])
        .catch((e) => e);
      expect(error).toBeInstanceOf(GroupFullError);
      expect(error.index).toBe(2);
      expect(await rows()).toHaveLength(1);
    });

    test('jobs of one batch count against each other', async () => {
      const error = await t.store
        .enqueue([
          grouped('g', { maxSize: 2 }),
          grouped('g', { maxSize: 2 }),
          grouped('g', { maxSize: 2 }),
        ])
        .catch((e) => e);
      expect(error).toMatchObject({ index: 2 });
      expect(await rows()).toHaveLength(0);
    });

    test('counts waiting, prioritized and delayed jobs, and not active or finished ones', async () => {
      const made = await t.store.enqueue([
        grouped('g', { maxSize: 4 }),
        { queue: 'q', data: 1, options: { group: { id: 'g', maxSize: 4 }, delay: 9_000 } },
        { queue: 'q', data: 1, options: { group: { id: 'g', maxSize: 4, priority: 2 } } },
        grouped('g', { maxSize: 4 }),
      ]);
      await expect(t.store.enqueue([grouped('g', { maxSize: 4 })])).rejects.toBeInstanceOf(
        GroupFullError
      );
      await sql()`UPDATE qcloud_jobs SET state = 'active' WHERE id = ${made[0]!.id}`;
      await sql()`UPDATE qcloud_jobs SET state = 'completed' WHERE id = ${made[3]!.id}`;
      const room = await t.store.enqueue([
        grouped('g', { maxSize: 4 }),
        grouped('g', { maxSize: 4 }),
      ]);
      expect(room.map((r) => r.created)).toEqual([true, true]);
      await expect(t.store.enqueue([grouped('g', { maxSize: 4 })])).rejects.toBeInstanceOf(
        GroupFullError
      );
    });

    test('is per queue and per group', async () => {
      await t.store.enqueue([grouped('g', { maxSize: 1 })]);
      const others = await t.store.enqueue([
        grouped('h', { maxSize: 1 }),
        grouped('g', { maxSize: 1 }, 'other-queue'),
      ]);
      expect(others.map((r) => r.created)).toEqual([true, true]);
    });

    test('a job that sets no maxSize is not capped, even in a group that is full', async () => {
      await t.store.enqueue([grouped('g', { maxSize: 1 })]);
      const [free] = await t.store.enqueue([grouped('g')]);
      expect(free!.created).toBe(true);
    });

    test('a numeric id and its string form are the same group', async () => {
      await t.store.enqueue([grouped(7, { maxSize: 1 })]);
      await expect(t.store.enqueue([grouped('7', { maxSize: 1 })])).rejects.toBeInstanceOf(
        GroupFullError
      );
      expect((await rows())[0]!.group_id).toBe('7');
    });

    test('a duplicate does not take room', async () => {
      const job = (id: string) => ({
        queue: 'q',
        data: 1,
        options: { jobId: id, group: { id: 'g', maxSize: 1 } },
      });
      await t.store.enqueue([job('one')]);
      const [again] = await t.store.enqueue([job('one')]);
      expect(again).toMatchObject({ id: 'one', created: false });
    });
  });

  test('a group priority sets the priority column and the starting state', async () => {
    const [job] = await t.store.enqueue([grouped('g', { priority: 5 })]);
    expect((await rows())[0]).toMatchObject({ id: job!.id, priority: 5, state: 'prioritized' });
  });

  describe('group_order', () => {
    test('is null without a group', async () => {
      await t.store.enqueue([{ queue: 'q', data: 1 }]);
      expect((await rows())[0]!.group_order).toBeNull();
    });

    test('follows the order jobs are enqueued in, within a batch and across batches', async () => {
      const first = await t.store.enqueue([
        grouped('a', {}, 'q', 0),
        grouped('b', {}, 'q', 1),
        { queue: 'q', data: 'plain' },
        grouped('a', {}, 'q', 2),
        grouped('b', {}, 'q', 3),
      ]);
      const second = await t.store.enqueue([grouped('a', {}, 'q', 4), grouped('b', {}, 'q', 5)]);
      const order = new Map(
        (await rows()).map((r) => [r.id, r.group_order === null ? null : BigInt(r.group_order)])
      );
      const grouped_ = [...first, ...second].filter((r) => order.get(r.id) !== null);
      const numbers = grouped_.map((r) => order.get(r.id)!);
      expect(numbers).toHaveLength(6);
      expect([...numbers].sort((x, y) => (x < y ? -1 : 1))).toEqual(numbers);
      expect(new Set(numbers).size).toBe(6);
    });

    test('is allocated across concurrent callers without a repeat, and each batch stays in order', async () => {
      const stores = Array.from({ length: 6 }, () => t.another());
      await Promise.all(
        stores.map((store, caller) =>
          store.enqueue(
            Array.from({ length: 20 }, (_, n) => grouped('shared', {}, 'q', { caller, n }))
          )
        )
      );
      const jobs = await t.fresh.sql<Array<{ order: string; data: Uint8Array }>>`
        SELECT group_order AS order, payload AS data FROM qcloud_jobs WHERE group_id = 'shared'`;
      expect(jobs).toHaveLength(120);
      expect(new Set(jobs.map((j) => j.order)).size).toBe(120);
      const codec = createMsgpackCodec();
      const byCaller = new Map<number, Array<{ n: number; order: bigint }>>();
      for (const job of jobs) {
        const { caller, n } = (codec.decode(job.data) as { data: { caller: number; n: number } })
          .data;
        byCaller.set(caller, [...(byCaller.get(caller) ?? []), { n, order: BigInt(job.order) }]);
      }
      expect(byCaller.size).toBe(6);
      for (const entries of byCaller.values()) {
        expect(entries).toHaveLength(20);
        const inInputOrder = entries.sort((a, b) => a.n - b.n).map((entry) => entry.order);
        expect(inInputOrder.every((order, at) => at === 0 || order > inInputOrder[at - 1]!)).toBe(
          true
        );
      }
    });

    test('a rolled-back call leaves a gap but never hands a number out twice', async () => {
      await t.store.enqueue([grouped('g', {}, 'q', 'before')]);
      await expect(
        t.store.enqueue([grouped('g', {}, 'q', 'lost'), grouped('g', { maxSize: 1 }, 'q', 'full')])
      ).rejects.toBeInstanceOf(GroupFullError);
      await t.store.enqueue([grouped('g', {}, 'q', 'after')]);
      const orders = (await rows()).map((r) => BigInt(r.group_order!));
      expect(orders).toHaveLength(2);
      expect(orders[1]! > orders[0]!).toBe(true);
    });

    test('decision: group_order stays on the sequence and qcloud_queue_state.group_sequence stays unused', async () => {
      await t.store.enqueue([grouped('g'), grouped('g', { maxSize: 5 })]);
      const state = await sql()<
        Array<{ group_sequence: string }>
      >`SELECT group_sequence FROM qcloud_queue_state`;
      expect(state.every((row) => row.group_sequence === '0')).toBe(true);
      const [sequence] = await sql()<
        Array<{ is_called: boolean }>
      >`SELECT is_called FROM qcloud_group_order_seq`;
      expect(sequence!.is_called).toBe(true);
    });
  });
});
