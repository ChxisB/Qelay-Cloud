import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addTree, failFor, fanOut, finish } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: what a parent reads about its children', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('childrenValues has the result of each completed child by queue and id, and no other', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({});
    const done = await finish(t, 'children', { n: 1 });
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`children:${done.id}`]: { n: 1 },
    });
    const other = done.id === first!.id ? second! : first!;
    await finish(t, 'children', { n: 2 });
    expect(Object.keys(await t.store.flows.childrenValues(parent!.id)).sort()).toEqual(
      [`children:${first!.id}`, `children:${second!.id}`].sort()
    );
    expect(other.id).not.toBe(done.id);
  });

  test('a child removed on completion still has its result', async () => {
    const [parent] = await addTree(t.store, fanOut(1, { child: { removeOnComplete: true } }));
    const done = await finish(t, 'children', 'kept');
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`children:${done.id}`]: 'kept',
    });
  });

  test('the children of another parent are not mixed in', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const [other] = await addTree(
      t.store,
      fanOut(1, { parentQueue: 'others', childQueue: 'more' })
    );
    await finish(t, 'more', 'theirs');
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({});
    expect(Object.values(await t.store.flows.childrenValues(other!.id))).toEqual(['theirs']);
  });

  test('dependencies splits the children into processed and unprocessed', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const before = await t.store.flows.dependencies(parent!.id);
    expect(before.processed).toEqual({});
    expect([...before.unprocessed].sort()).toEqual(
      [`children:${first!.id}`, `children:${second!.id}`].sort()
    );
    const done = await finish(t, 'children', 'x');
    const after = await t.store.flows.dependencies(parent!.id);
    expect(after.processed).toEqual({ [`children:${done.id}`]: 'x' });
    expect(after.unprocessed).toEqual([
      `children:${done.id === first!.id ? second!.id : first!.id}`,
    ]);
  });

  test('a failed child with no policy stays unprocessed: the parent still waits for it', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const failed = await failFor(t, 'children');
    expect(await t.store.flows.dependencies(parent!.id)).toEqual({
      processed: {},
      unprocessed: [`children:${failed.id}`],
    });
  });

  test('a child recorded as ignored or continued is in neither list, and its error is readable', async () => {
    const [parent, , , , pending] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'ignored', options: { ignoreDependencyOnFailure: true } },
        { queue: 'continued', options: { continueParentOnFailure: true } },
        { queue: 'removed', options: { removeDependencyOnFailure: true } },
        { queue: 'waiting' },
      ],
    });
    const ignored = await failFor(t, 'ignored', 'ignore me');
    const continued = await failFor(t, 'continued', 'continue past me');
    await failFor(t, 'removed', 'gone');
    const dependencies = await t.store.flows.dependencies(parent!.id);
    expect(dependencies.processed).toEqual({});
    expect(dependencies.unprocessed).toEqual([`waiting:${pending!.id}`]);
    expect(await t.store.flows.ignoredFailures(parent!.id)).toEqual({
      [`ignored:${ignored.id}`]: 'ignore me',
    });
    expect(await t.store.flows.failedChildren(parent!.id)).toEqual({
      [`continued:${continued.id}`]: 'continue past me',
    });
  });

  test('reads of a job that is not a parent are empty', async () => {
    const [plain] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
    for (const id of [plain?.id ?? 'x', 'no-such-job']) {
      expect(await t.store.flows.childrenValues(id)).toEqual({});
      expect(await t.store.flows.dependencies(id)).toEqual({ processed: {}, unprocessed: [] });
      expect(await t.store.flows.failedChildren(id)).toEqual({});
      expect(await t.store.flows.ignoredFailures(id)).toEqual({});
    }
  });

  test('tree shows every level with the state of each job, children in the order they were given', async () => {
    const [root, middle, leaf, sibling] = await addTree(t.store, {
      queue: 'a',
      children: [{ queue: 'b', children: [{ queue: 'c' }] }, { queue: 'd' }],
    });
    expect(await t.store.flows.tree(root!.id)).toEqual({
      id: root!.id,
      queue: 'a',
      state: 'waiting-children',
      children: [
        {
          id: middle!.id,
          queue: 'b',
          state: 'waiting-children',
          children: [{ id: leaf!.id, queue: 'c', state: 'waiting', children: [] }],
        },
        { id: sibling!.id, queue: 'd', state: 'waiting', children: [] },
      ],
    });
  });

  test('tree keeps a completed child that was removed on completion, as completed', async () => {
    const [root] = await addTree(t.store, fanOut(1, { child: { removeOnComplete: true } }));
    const done = await finish(t, 'children');
    const tree = await t.store.flows.tree(root!.id);
    expect(tree!.state).toBe('waiting');
    expect(tree!.children).toEqual([
      { id: done.id, queue: 'children', state: 'completed', children: [] },
    ]);
  });

  test('tree reads as many levels and children as it is told to', async () => {
    const [root] = await addTree(t.store, {
      queue: 'a',
      children: [
        { queue: 'b', children: [{ queue: 'c' }, { queue: 'c' }] },
        { queue: 'b' },
        { queue: 'b' },
      ],
    });
    const shape = (node: { children: readonly unknown[] } | null): unknown => node;
    const count = (
      node: { children: readonly { children: readonly unknown[] }[] } | null
    ): number =>
      node === null ? 0 : 1 + node.children.reduce((sum, child) => sum + count(child as never), 0);
    expect(count((await t.store.flows.tree(root!.id)) as never)).toBe(6);
    expect(shape(await t.store.flows.tree(root!.id, { depth: 0 }))).toMatchObject({ children: [] });
    expect(count((await t.store.flows.tree(root!.id, { depth: 1 })) as never)).toBe(4);
    const narrow = await t.store.flows.tree(root!.id, { maxChildren: 1 });
    expect(narrow!.children).toHaveLength(1);
    expect(narrow!.children[0]!.children).toHaveLength(1);
    expect(shape(await t.store.flows.tree(root!.id, { maxChildren: 0 }))).toMatchObject({
      children: [],
    });
    await expect(t.store.flows.tree(root!.id, { depth: -1 })).rejects.toThrow(RangeError);
  });

  test('tree of an unknown job is null, and of a job with no children has none', async () => {
    expect(await t.store.flows.tree('no-such-job')).toBeNull();
    const [plain] = await t.store.enqueue([{ queue: 'q', data: 1 }]);
    expect(await t.store.flows.tree(plain!.id)).toMatchObject({ children: [] });
  });
});
