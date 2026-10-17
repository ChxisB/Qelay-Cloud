import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { TickBudget } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import {
  addTree,
  edgesOf,
  failFor,
  failuresOf,
  fanOut,
  finish,
  flowDefects,
  summary,
} from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const BUDGET: TickBudget = {
  maxDurationMs: 5_000,
  maxRingsPerQueue: 100,
  maxItems: 100,
  reRingAfterMs: 5_000,
  ringGraceMs: 0,
};

describeDb('flows: operator actions', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  test('cancelling the last pending child releases the parent, and the tick rings it', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const done = await finish(t, 'children');
    const last = done.id === first!.id ? second! : first!;
    expect(await t.store.cancel(last.id)).toBe(true);
    expect(await summary(t, parent!.id)).toMatchObject({ state: 'waiting', rung_at: null });
    expect(await edgesOf(t, parent!.id)).toEqual([done.id]);
    expect(log.events.map((event) => event.type)).toContain('promoted');
    expect(await flowDefects(t)).toEqual([]);
    const report = await t.store.tick(BUDGET);
    expect(report.rings.map((ring) => ring.bell.jobId)).toContain(parent!.id);
  });

  test('cancelling a child the parent still has siblings for keeps it waiting', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    expect(await t.store.cancel(first!.id)).toBe(true);
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await edgesOf(t, parent!.id)).toEqual([second!.id]);
    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await flowDefects(t)).toEqual([]);
  });

  test('cancelling every child releases the parent with nothing to read', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    await t.store.cancel(first!.id);
    await t.store.cancel(second!.id);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({});
    expect(await flowDefects(t)).toEqual([]);
  });

  test('cancelling a parent removes its rows and leaves its children running as plain jobs', async () => {
    const [parent, first, second] = await addTree(
      t.store,
      fanOut(2, { child: { continueParentOnFailure: true } })
    );
    expect(await t.store.cancel(parent!.id)).toBe(true);
    expect(await summary(t, parent!.id)).toBeUndefined();
    expect(await edgesOf(t, parent!.id)).toEqual([]);
    expect(await flowDefects(t)).toEqual([]);
    // The children are still there, and finishing or failing them changes nothing else.
    expect((await summary(t, first!.id))!.state).toBe('waiting');
    await finish(t, 'children');
    await failFor(t, 'children');
    expect((await summary(t, second!.id))!.state).not.toBe('waiting-children');
    expect(await failuresOf(t, parent!.id)).toEqual([]);
    expect(await flowDefects(t)).toEqual([]);
  });

  test('cancelling the middle of a flow releases the root when it was the last thing it waited for', async () => {
    const [root, middle, leaf] = await addTree(t.store, {
      queue: 'a',
      children: [{ queue: 'b', children: [{ queue: 'c' }] }],
    });
    expect(await t.store.cancel(middle!.id)).toBe(true);
    expect((await summary(t, root!.id))!.state).toBe('waiting');
    expect(await edgesOf(t, root!.id)).toEqual([]);
    expect((await summary(t, leaf!.id))!.state).toBe('waiting');
    expect(await flowDefects(t)).toEqual([]);
  });

  test('remove refuses a child a live parent waits for, and takes the parent', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    expect(await t.store.control.remove(child!.id)).toBe('protected');
    expect((await summary(t, child!.id))!.state).toBe('waiting');
    expect(await t.store.control.remove(parent!.id)).toBe('removed');
    expect(await edgesOf(t, parent!.id)).toEqual([]);
    expect(await t.store.control.remove(child!.id)).toBe('removed');
    expect(await flowDefects(t)).toEqual([]);
  });

  test('drain leaves the pending children of a live parent in place', async () => {
    const [parent] = await addTree(t.store, fanOut(3));
    await t.store.enqueue([{ queue: 'children', data: 'plain' }]);
    const report = await t.store.control.drain('children');
    expect(report.removed).toHaveLength(1);
    expect(await edgesOf(t, parent!.id)).toHaveLength(3);
    expect(await flowDefects(t)).toEqual([]);
  });

  test('promote and changePriority refuse a parent that is waiting for its children', async () => {
    const [parent] = await addTree(t.store, fanOut(1, { parent: { delay: 60_000 } }));
    expect((await t.store.promote(parent!.id)).ok).toBe(false);
    expect(await t.store.changePriority(parent!.id, 3)).toBe(false);
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
  });

  test('a failed child with no policy is kept out of every DLQ delete while its parent waits', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    await failFor(t, 'children');
    expect(await t.store.purgeDlq('children')).toBe(0);
    expect(await t.store.purgeDlq('children', [child!.id])).toBe(0);
    // A limit of one entry would delete the older failure when a newer one arrives; this one is kept.
    await t.store.queues.setDlqConfig('children', { maxEntries: 1 });
    await t.store.enqueue([{ queue: 'children', data: 'other', options: { attempts: 1 } }]);
    await failFor(t, 'children');
    expect((await summary(t, child!.id))!.state).toBe('failed');
    t.clock.advance(30 * 86_400_000);
    expect(await t.store.purgeExpiredDlq(100)).toBe(0);
    expect((await summary(t, child!.id))!.state).toBe('failed');
    // Once the parent is cancelled nothing waits for the child any more.
    await t.store.cancel(parent!.id);
    expect(await t.store.purgeDlq('children', [child!.id])).toBe(1);
    expect(await flowDefects(t)).toEqual([]);
  });

  test('a child that expires before it ran releases the parent through the tick', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    await t.fresh.sql`UPDATE qcloud_jobs SET ttl = 1000 WHERE id = ${child!.id}`;
    t.clock.advance(5_000);
    const report = await t.store.expirePending();
    expect(report.expired).toBe(1);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await flowDefects(t)).toEqual([]);
    const tick = await t.store.tick(BUDGET);
    expect(tick.rings.map((ring) => ring.bell.jobId)).toContain(parent!.id);
  });
});
