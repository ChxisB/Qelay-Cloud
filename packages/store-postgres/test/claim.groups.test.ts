import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind } from './storeHelpers';

describeDb('claim: groups', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_group_state`;
    rewind(t);
  });

  /** One job of group `group`, its `data` being `label`. */
  const job = (
    group: string | number | null,
    label: string,
    extra: object = {},
    options: object = {}
  ) => ({
    queue: 'q',
    data: label,
    options: { ...options, ...(group === null ? {} : { group: { id: group, ...extra } }) },
  });
  const put = (...jobs: ReturnType<typeof job>[]) => t.store.enqueue(jobs);
  const pull = async (n: number, group?: object) =>
    (await t.store.claim('q', 'w', n, group ? { group } : undefined)).map(
      (claimed) => claimed.data
    );
  const groupRow = async (id: string) =>
    (await t.fresh.sql`SELECT * FROM qcloud_group_state WHERE group_id = ${id}`)[0];

  describe('round-robin', () => {
    test('one job per group before any group gets a second, in the order the groups first appeared', async () => {
      await put(
        job('a', 'a1'),
        job('a', 'a2'),
        job('a', 'a3'),
        job('b', 'b1'),
        job('b', 'b2'),
        job('c', 'c1')
      );
      expect(await pull(3)).toEqual(['a1', 'b1', 'c1']);
    });

    test('the group served longest ago goes first on the next claim', async () => {
      await put(
        job('a', 'a1'),
        job('a', 'a2'),
        job('b', 'b1'),
        job('b', 'b2'),
        job('c', 'c1'),
        job('c', 'c2')
      );
      expect(await pull(1)).toEqual(['a1']);
      expect(await pull(1)).toEqual(['b1']);
      expect(await pull(1)).toEqual(['c1']);
      expect(await pull(1)).toEqual(['a2']);
      expect(await pull(2)).toEqual(['b2', 'c2']);
    });

    test('a group that appears later joins the back of the rotation, as upstream does', async () => {
      await put(job('a', 'a1'), job('a', 'a2'));
      expect(await pull(1)).toEqual(['a1']);
      await put(job('b', 'b1'));
      expect(await pull(2)).toEqual(['a2', 'b1']);
    });

    test('a group with several jobs fills the rest of a big claim after one round', async () => {
      await put(job('a', 'a1'), job('a', 'a2'), job('a', 'a3'), job('b', 'b1'));
      expect(await pull(10)).toEqual(['a1', 'b1', 'a2', 'a3']);
    });

    test('numeric group ids are strings in the group state', async () => {
      await put(job(null, 'x'), job(7, 'n'));
      await pull(5);
      expect(await groupRow('7')).toMatchObject({ queue: 'q', group_id: '7' });
    });

    test('group state rows are created by the first claim that sees the group, with a rotation position', async () => {
      await put(job('a', 'a1'), job('b', 'b1'));
      expect(await groupRow('a')).toBeUndefined();
      await pull(1);
      const [a, b] = [await groupRow('a'), await groupRow('b')];
      expect(Number(b.last_served)).toBeGreaterThan(0);
      // `a` was served, so it now sits behind `b`, which has not been.
      expect(Number(a.last_served)).toBeGreaterThan(Number(b.last_served));
    });
  });

  describe('inside a group', () => {
    test('the lower group priority runs first, then admission order', async () => {
      await put(
        job('g', 'five', { priority: 5 }),
        job('g', 'one-a', { priority: 1 }),
        job('g', 'three', { priority: 3 }),
        job('g', 'one-b', { priority: 1 })
      );
      expect(await pull(4)).toEqual(['one-a', 'one-b', 'three', 'five']);
    });

    test('a delayed group job waits for its run_at', async () => {
      await put(job('g', 'later', {}, { delay: 5_000 }), job('g', 'now'));
      expect(await pull(5)).toEqual(['now']);
      t.clock.advance(5_000);
      expect(await pull(5)).toEqual(['later']);
    });
  });

  describe('mixed with ungrouped jobs', () => {
    test('ungrouped jobs come first, grouped jobs fill the rest', async () => {
      await put(job('g', 'g1'), job(null, 'u1'), job('g', 'g2'), job(null, 'u2'));
      expect(await pull(3)).toEqual(['u1', 'u2', 'g1']);
    });

    test('affinity to a group takes only that group', async () => {
      await put(job(null, 'u1'), job('a', 'a1'), job('b', 'b1'), job('b', 'b2'));
      expect(await pull(5, { affinity: 'b' })).toEqual(['b1', 'b2']);
      expect(await pull(5, { affinity: 'nobody' })).toEqual([]);
    });

    test('affinity null takes no grouped job', async () => {
      await put(job('a', 'a1'), job(null, 'u1'), job(null, 'u2'));
      expect(await pull(5, { affinity: null })).toEqual(['u1', 'u2']);
      expect(await pull(5, { affinity: null })).toEqual([]);
      expect(await pull(5)).toEqual(['a1']);
    });
  });

  describe('limits on a group', () => {
    test('concurrency: at most that many jobs of one group are active', async () => {
      await put(job('a', 'a1'), job('a', 'a2'), job('a', 'a3'), job('b', 'b1'), job('b', 'b2'));
      expect(await pull(10, { concurrency: 1 })).toEqual(['a1', 'b1']);
      expect(await pull(10, { concurrency: 1 })).toEqual([]);
    });

    test('a slot comes back when a job of the group is given back, or its lease expires', async () => {
      await put(job('a', 'a1'), job('a', 'a2'), job('a', 'a3'));
      const [first] = await t.store.claim('q', 'w', 5, { group: { concurrency: 1 } });
      await t.store.release(first!.lease);
      const [again] = await t.store.claim('q', 'w', 5, { group: { concurrency: 1 } });
      expect(again!.data).toBe('a1');
      expect(await pull(5, { concurrency: 1 })).toEqual([]);
      t.clock.advance(30_000);
      expect(await pull(5, { concurrency: 1 })).toEqual(['a2']);
    });

    test('rate: at most max jobs of one group per window, which restarts after it ran out', async () => {
      await put(
        job('a', 'a1'),
        job('a', 'a2'),
        job('a', 'a3'),
        job('b', 'b1'),
        job('b', 'b2'),
        job('b', 'b3')
      );
      const limit = { max: 2, duration: 1_000 };
      expect(await pull(10, { limit })).toEqual(['a1', 'b1', 'a2', 'b2']);
      expect(await pull(10, { limit })).toEqual([]);
      t.clock.advance(1_000);
      expect(await pull(10, { limit })).toEqual(['a3', 'b3']);
    });

    test('the group count is per group: a busy group does not slow another', async () => {
      await put(job('a', 'a1'), job('a', 'a2'), job('b', 'b1'));
      const limit = { max: 1, duration: 60_000 };
      expect(await pull(10, { limit })).toEqual(['a1', 'b1']);
    });
  });

  describe("a group's own settings win over the worker's", () => {
    const setGroup = (id: string, columns: string) =>
      t.fresh.sql.unsafe(
        `INSERT INTO qcloud_group_state (namespace, queue, group_id, ${columns.split('=')[0]})
         VALUES ('test', 'q', '${id}', ${columns.split('=')[1]})`
      );

    test('its own concurrency limit beats the default', async () => {
      await setGroup('a', 'concurrency_limit=1');
      await put(job('a', 'a1'), job('a', 'a2'), job('b', 'b1'), job('b', 'b2'));
      expect(await pull(10, { concurrency: 5 })).toEqual(['a1', 'b1', 'b2']);
    });

    test('its own rate limit applies although the worker gave none, and its window restarts (fixes upstream)', async () => {
      await t.fresh.sql`
        INSERT INTO qcloud_group_state (namespace, queue, group_id, rate_limit, rate_duration_ms)
        VALUES ('test', 'q', 'a', 1, 1000)`;
      await put(job('a', 'a1'), job('a', 'a2'), job('a', 'a3'));
      expect(await pull(5)).toEqual(['a1']);
      expect(await pull(5)).toEqual([]);
      t.clock.advance(1_000);
      expect(await pull(5)).toEqual(['a2']);
      t.clock.advance(1_000);
      expect(await pull(5)).toEqual(['a3']);
    });

    test('a paused group is skipped, and the others carry on', async () => {
      await setGroup('a', 'paused=TRUE');
      await put(job('a', 'a1'), job('b', 'b1'));
      expect(await pull(5)).toEqual(['b1']);
    });

    test('a group held back until a time is skipped until then', async () => {
      await setGroup('a', 'manual_rate_limit_until=1800000005000');
      await put(job('a', 'a1'), job('b', 'b1'));
      expect(await pull(5)).toEqual(['b1']);
      t.clock.advance(5_000);
      expect(await pull(5)).toEqual(['a1']);
    });
  });

  test('the queue limits apply to grouped jobs too', async () => {
    await put(job('a', 'a1'), job('b', 'b1'), job('c', 'c1'));
    await t.store.setConcurrencyLimit('q', 2);
    expect(await pull(10)).toEqual(['a1', 'b1']);
    expect(await pull(10)).toEqual([]);
  });

  test('every claimed job is leased and counted like any other', async () => {
    await put(job('a', 'a1'), job('b', 'b1'));
    const claimed = await t.store.claim('q', 'w', 5);
    expect(claimed).toHaveLength(2);
    for (const one of claimed) expect(await t.store.heartbeat(one.lease)).toBe(true);
    expect((await t.store.counts('q')).active).toBe(2);
  });
});
