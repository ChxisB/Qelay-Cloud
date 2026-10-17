import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

describeDb('doorbell: what the local transport reads', () => {
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

  describe('hasClaimable', () => {
    test('an empty queue has nothing to claim', async () => {
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
    });

    test.each([
      ['a waiting job', {}],
      ['a prioritized job', { priority: 5 }],
      ['a LIFO job', { lifo: true }],
    ])('%s is claimable', async (_name, options) => {
      await enqueueN(t.store, 1, options);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(true);
    });

    test('a grouped job is claimable', async () => {
      await t.store.enqueue([{ queue: 'q', data: 1, options: { group: { id: 'g' } } }]);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(true);
    });

    test('a delayed job is claimable once its time has passed, though nothing promoted it', async () => {
      await enqueueN(t.store, 1, { delay: 5_000 });
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
      t.clock.advance(4_999);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
      t.clock.advance(1);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(true);
    });

    test('only jobs of the queue asked about count', async () => {
      await enqueueN(t.store, 1, {}, 'other');
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
      expect(await t.store.doorbell.hasClaimable('other')).toBe(true);
    });

    test('a claimed job is not claimable any more', async () => {
      await enqueueN(t.store, 1);
      await t.store.claim('q', 'w', 1);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
    });

    test('a paused queue is not claimable, grouped jobs included, until it is resumed', async () => {
      await enqueueN(t.store, 1);
      await t.store.enqueue([{ queue: 'q', data: 2, options: { group: { id: 'g' } } }]);
      await t.store.pause('q');
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
      await t.store.resume('q');
      expect(await t.store.doorbell.hasClaimable('q')).toBe(true);
    });

    test('a queue with only a paused group has nothing to claim', async () => {
      await t.store.enqueue([{ queue: 'q', data: 1, options: { group: { id: 'g' } } }]);
      await t.fresh.sql`
        INSERT INTO qcloud_group_state (namespace, queue, group_id, paused)
        VALUES ('test', 'q', 'g', TRUE)
        ON CONFLICT (namespace, queue, group_id) DO UPDATE SET paused = TRUE`;
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
    });

    test('a rate-limited queue still says yes: the claim finds nothing, which is cheap', async () => {
      await enqueueN(t.store, 3);
      await t.store.setRateLimit('q', { max: 1, durationMs: 60_000 });
      await t.store.claim('q', 'w', 1);
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(true);
    });

    test('another namespace’s jobs are not seen', async () => {
      const other = t.another({ namespace: 'elsewhere' });
      await enqueueN(other, 2);
      expect(await t.store.doorbell.hasClaimable('q')).toBe(false);
    });
  });

  describe('snapshot', () => {
    test('an empty queue reports zeros and no oldest age, at the database time', async () => {
      expect(await t.store.doorbell.snapshot('q')).toEqual({
        ready: 0,
        delayed: 0,
        active: 0,
        failed: 0,
        oldestReadyAgeMs: null,
        observedAt: t.clock.now(),
      });
    });

    test('counts claimable, delayed, active and failed jobs of the queue', async () => {
      await enqueueN(t.store, 2);
      await enqueueN(t.store, 1, { priority: 2 });
      await enqueueN(t.store, 4, { delay: 60_000 });
      await enqueueN(t.store, 5, {}, 'other');
      await enqueueN(t.store, 1, { attempts: 1, priority: 9 });
      await enqueueN(t.store, 1, { priority: 3 });
      const [doomed] = await t.store.claim('q', 'w', 1);
      await t.store.fail(doomed!.lease, { message: 'boom', unrecoverable: false });
      await t.store.claim('q', 'w', 1);
      expect(await t.store.doorbell.snapshot('q')).toMatchObject({
        ready: 3,
        delayed: 4,
        active: 1,
        failed: 1,
      });
    });

    test('a delayed job past its time counts as ready, as `counts` says', async () => {
      await enqueueN(t.store, 1, { delay: 1_000 });
      t.clock.advance(1_000);
      expect(await t.store.doorbell.snapshot('q')).toMatchObject({ ready: 1, delayed: 0 });
    });

    test('the oldest age runs from when a job became claimable, not from when it was created', async () => {
      await enqueueN(t.store, 1, { delay: 10_000 });
      t.clock.advance(12_500);
      expect((await t.store.doorbell.snapshot('q')).oldestReadyAgeMs).toBe(2_500);
      expect((await t.store.doorbell.snapshot('empty')).oldestReadyAgeMs).toBeNull();
    });

    test('jobs that are not claimable yet do not make the queue look old', async () => {
      await enqueueN(t.store, 2, { delay: 60_000 });
      t.clock.advance(1_000);
      expect((await t.store.doorbell.snapshot('q')).oldestReadyAgeMs).toBeNull();
    });
  });
});
