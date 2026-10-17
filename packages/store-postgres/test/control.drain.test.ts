import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, recording, resetTables } from './finishHelpers';
import { makeFlow, remainingIds } from './flowFixtures';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

describeDb('control: drain and clean of pending jobs', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  describe('drain', () => {
    test('deletes the waiting, prioritized and delayed jobs of the queue and nothing else', async () => {
      // Claiming takes the head of the queue, so the jobs that finish or hold a lease go first.
      const active = (await claimOne(t)).id;
      const done = await claimOne(t);
      await t.store.complete(done.lease, null);
      const failed = await claimOne(t);
      await t.store.fail(failed.lease, { message: 'x', unrecoverable: true });
      const waiting = await enqueueN(t.store, 2);
      const prioritized = await enqueueN(t.store, 1, { priority: 2 });
      const delayed = await enqueueN(t.store, 1, { delay: 60_000 });
      const [other] = await enqueueN(t.store, 1, {}, 'other');
      log.events.length = 0;

      const report = await t.store.control.drain('q');
      expect([...report.removed].sort()).toEqual([...waiting, ...prioritized, ...delayed].sort());
      expect(report.more).toBe(false);
      expect(await remainingIds(t)).toEqual([active, done.id, failed.id, other!].sort());
      expect(log.events).toHaveLength(4);
      expect(log.events.map((event) => String(event.state)).sort()).toEqual([
        'delayed',
        'prioritized',
        'waiting',
        'waiting',
      ]);
      expect(log.events[0]).toMatchObject({ type: 'removed', error: 'drained', removed: true });
      expect(await t.store.claim('q', 'w2', 10)).toEqual([]);
    });

    test('works on a paused queue, and frees the dedup key and custom id of what it deleted', async () => {
      await t.store.enqueue([
        { queue: 'q', data: 1, options: { jobId: 'cid', deduplication: { id: 'dk' } } },
      ]);
      await t.store.pause('q');
      expect((await t.store.control.drain('q')).removed).toHaveLength(1);
      const again = await t.store.enqueue([
        { queue: 'q', data: 2, options: { jobId: 'cid', deduplication: { id: 'dk' } } },
      ]);
      expect(again[0]).toMatchObject({ id: 'cid', state: 'waiting' });
    });

    test('a limit bounds one call, and `more` says another has work', async () => {
      await enqueueN(t.store, 5);
      const first = await t.store.control.drain('q', { limit: 2 });
      expect(first.removed).toHaveLength(2);
      expect(first.more).toBe(true);
      const second = await t.store.control.drain('q', { limit: 3 });
      expect(second.removed).toHaveLength(3);
      expect(second.more).toBe(false);
      expect(await remainingIds(t)).toEqual([]);
    });

    test('leaves a job a live flow parent waits on, and the parent itself', async () => {
      const flow = await makeFlow(t);
      const plain = await enqueueN(t.store, 2);
      const report = await t.store.control.drain('q');
      expect([...report.removed].sort()).toEqual([...plain].sort());
      expect(await remainingIds(t)).toEqual([flow.parent, ...flow.children].sort());
      // Drained from the parent's queue, the waiting-children parent is not pending and stays too.
      expect((await t.store.control.drain('flows')).removed).toEqual([]);
    });

    test('a child is drained once nothing waits on it any more', async () => {
      const flow = await makeFlow(t);
      expect(await t.store.control.remove(flow.parent)).toBe('removed');
      expect((await t.store.control.drain('q')).removed).toEqual([...flow.children]);
    });

    test.each([[{ limit: 0 }], [{ limit: 10_001 }], [{ limit: 1.5 }]])(
      'a limit of %p is refused',
      async (options) => {
        await expect(t.store.control.drain('q', options)).rejects.toBeInstanceOf(
          UnsupportedOptionError
        );
      }
    );

    test('a queue name that is empty is refused', async () => {
      await expect(t.store.control.drain('')).rejects.toBeInstanceOf(UnsupportedOptionError);
    });
  });

  describe('cleanPending', () => {
    test('deletes the jobs of one state that were created long enough ago', async () => {
      const old = await enqueueN(t.store, 2);
      t.clock.advance(10_000);
      const fresh = await enqueueN(t.store, 2);
      const report = await t.store.control.cleanPending('q', {
        state: 'waiting',
        olderThanMs: 5_000,
      });
      expect([...report.removed].sort()).toEqual([...old].sort());
      expect(await remainingIds(t)).toEqual([...fresh].sort());
      expect(log.events.at(-1)).toMatchObject({
        type: 'removed',
        error: 'cleaned',
        state: 'waiting',
      });
    });

    test.each([
      ['prioritized', { priority: 3 }],
      ['delayed', { delay: 600_000 }],
    ] as const)('reaches %s jobs and only those', async (state, options) => {
      const target = await enqueueN(t.store, 1, options);
      const rest = await enqueueN(t.store, 1);
      const report = await t.store.control.cleanPending('q', { state, olderThanMs: 0 });
      expect(report.removed).toEqual(target);
      expect(await remainingIds(t)).toEqual(rest);
    });

    test('a delayed job whose time has come counts as waiting, as a reader sees it', async () => {
      const [due] = await enqueueN(t.store, 1, { delay: 1_000 });
      t.clock.advance(2_000);
      expect(
        (await t.store.control.cleanPending('q', { state: 'delayed', olderThanMs: 0 })).removed
      ).toEqual([]);
      expect(
        (await t.store.control.cleanPending('q', { state: 'waiting', olderThanMs: 0 })).removed
      ).toEqual([due!]);
    });

    test('skips what a live flow parent waits on, and a limit bounds the call', async () => {
      const flow = await makeFlow(t);
      await enqueueN(t.store, 3);
      const first = await t.store.control.cleanPending('q', {
        state: 'waiting',
        olderThanMs: 0,
        limit: 2,
      });
      expect(first.removed).toHaveLength(2);
      expect(first.more).toBe(true);
      const rest = await t.store.control.cleanPending('q', { state: 'waiting', olderThanMs: 0 });
      expect(rest.removed).toHaveLength(1);
      expect(rest.more).toBe(false);
      expect(await remainingIds(t, 'q')).toEqual([...flow.children].sort());
    });

    test.each([['active'], ['completed'], ['failed'], ['paused'], ['waiting-children']])(
      'the state %p is not a pending state and is refused',
      async (state) => {
        await expect(
          t.store.control.cleanPending('q', { state: state as 'waiting', olderThanMs: 0 })
        ).rejects.toBeInstanceOf(UnsupportedOptionError);
      }
    );
  });
});
