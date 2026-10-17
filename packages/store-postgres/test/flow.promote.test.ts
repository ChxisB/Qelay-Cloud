import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { addTree, edgesOf, fanOut, finish, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: promoting the parent', () => {
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

  test('the last child to complete releases the parent in its own transaction and returns its ring', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const first = await finish(t, 'children');
    expect(first.rings).toBe(0);
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    const last = await finish(t, 'children');
    expect(last.rings).toBe(1);
    expect(await summary(t, parent!.id)).toMatchObject({ state: 'waiting', rung_at: null });
    expect(log.events.filter((event) => event.type === 'promoted')).toEqual([
      { type: 'promoted', queue: 'parents', jobId: parent!.id, state: 'waiting' },
    ]);
    const [claimed] = await t.store.claim('parents', 'w', 1);
    expect(claimed!.id).toBe(parent!.id);
  });

  test('keeps the edges after the children complete', async () => {
    const [parent, ...children] = await addTree(t.store, fanOut(2));
    await finish(t, 'children');
    await finish(t, 'children');
    expect(await edgesOf(t, parent!.id)).toEqual(children.map((child) => child.id).sort());
  });

  test('the parent keeps its priority: prioritized once released', async () => {
    const [parent] = await addTree(t.store, fanOut(1, { parent: { priority: 4 } }));
    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('prioritized');
  });

  test('the parent delay counts from the moment it is released', async () => {
    const [parent] = await addTree(t.store, fanOut(1, { parent: { delay: 60_000 } }));
    t.clock.advance(30_000);
    const done = await finish(t, 'children');
    expect(done.rings).toBe(0);
    expect((await summary(t, parent!.id))!.state).toBe('delayed');
    const [{ run_at }] = await t.fresh.sql<Array<{ run_at: string }>>`
      SELECT run_at FROM qcloud_jobs WHERE id = ${parent!.id}`;
    expect(Number(run_at)).toBe(t.clock.now() + 60_000);
    expect(await t.store.claim('parents', 'w', 1)).toEqual([]);
    t.clock.advance(60_000);
    expect(await t.store.claim('parents', 'w', 1)).toHaveLength(1);
  });

  test('a completion that rolls back leaves the parent waiting and the child active', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const [job] = await t.store.claim('children', 'w', 1);
    log.failWith(new Error('journal down'));
    try {
      await expect(t.store.complete(job!.lease, 'ok')).rejects.toThrow();
    } finally {
      log.failWith(null);
    }
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect((await summary(t, job!.id))!.state).toBe('active');
    await t.store.complete(job!.lease, 'ok');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
  });

  test('a flow of three levels releases each level in turn', async () => {
    const [root, middle] = await addTree(t.store, {
      queue: 'a',
      children: [{ queue: 'b', children: [{ queue: 'c' }] }],
    });
    await finish(t, 'c');
    expect((await summary(t, middle!.id))!.state).toBe('waiting');
    expect((await summary(t, root!.id))!.state).toBe('waiting-children');
    await finish(t, 'b');
    expect((await summary(t, root!.id))!.state).toBe('waiting');
  });

  test('a child removed on completion still counts as complete', async () => {
    const [parent, child] = await addTree(
      t.store,
      fanOut(1, { child: { removeOnComplete: true } })
    );
    await finish(t, 'children', 'kept');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await summary(t, child!.id)).toBeUndefined();
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`children:${child!.id}`]: 'kept',
    });
  });

  test('a completed parent no longer reacts to a late duplicate completion', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const [job] = await t.store.claim('children', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    const before = await summary(t, parent!.id);
    await expect(t.store.complete(job!.lease, 'ok')).resolves.toBeDefined();
    expect(await summary(t, parent!.id)).toEqual(before!);
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(1);
  });
});
