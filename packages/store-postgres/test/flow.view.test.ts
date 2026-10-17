import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { MAX_FLOW_VIEW_NODES } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { nodeOf, seedFlow, viewOf } from './flowActionHelpers';
import { addTree, failFor, fanOut, finish } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: what the control API shows', () => {
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

  test('the list has each flow newest first with its states, and counts the failed children that block', async () => {
    const [older, olderChild] = await addTree(t.store, fanOut(2, { parent: { jobId: 'older' } }));
    t.clock.advance(1_000);
    const [newer] = await addTree(
      t.store,
      fanOut(1, { parentQueue: 'others', childQueue: 'more', parent: { jobId: 'newer' } })
    );
    await failFor(t, 'children');
    const page = await t.store.flows.roots({ limit: 10 });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual([newer!.id, older!.id]);
    expect(page.items[0]).toMatchObject({
      queue: 'others',
      state: 'waiting-children',
      total: 2,
      states: { 'waiting-children': 1, waiting: 1 },
      blocked: 0,
    });
    expect(page.items[1]).toMatchObject({
      total: 3,
      states: { 'waiting-children': 1, waiting: 1, failed: 1 },
      blocked: 1,
    });
    expect(olderChild).toBeDefined();
    expect(older!.id).toBe('older');
  });

  test('the list pages, and a page past the end is empty', async () => {
    for (let at = 0; at < 3; at += 1) {
      t.clock.advance(10);
      await addTree(t.store, fanOut(1, { parent: { jobId: `flow-${at}` } }));
    }
    const first = await t.store.flows.roots({ limit: 2 });
    const second = await t.store.flows.roots({ limit: 2, offset: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['flow-2', 'flow-1']);
    expect(second.items.map((item) => item.id)).toEqual(['flow-0']);
    expect(second.total).toBe(3);
    expect((await t.store.flows.roots({ limit: 2, offset: 50 })).items).toEqual([]);
  });

  test('a flow is listed top level first with parents, policies and the jobs that block', async () => {
    const [root, mid, leaf, other] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      options: { jobId: 'top-job' },
      children: [
        {
          queue: 'mid',
          data: 1,
          options: { continueParentOnFailure: true },
          children: [{ queue: 'leaf', data: 2 }],
        },
        { queue: 'other', data: 3 },
      ],
    });
    await failFor(t, 'leaf', 'leaf broke');
    const view = await viewOf(t, root!.id);
    expect(view).toMatchObject({ root: 'top-job', total: 4, truncated: false });
    expect(view.nodes.map((node) => node.depth)).toEqual([0, 1, 1, 2]);
    expect(nodeOf(view, mid!.id)).toMatchObject({
      parentId: root!.id,
      mode: 'continue',
      blocking: false,
    });
    expect(nodeOf(view, leaf!.id)).toMatchObject({
      state: 'failed',
      parentId: mid!.id,
      depth: 2,
      mode: null,
      blocking: true,
      error: 'leaf broke',
      attempts: 1,
    });
    expect(nodeOf(view, other!.id)).toMatchObject({
      state: 'waiting',
      blocking: false,
      removed: false,
    });
    expect(nodeOf(view, root!.id)).toMatchObject({ parentId: null, depth: 0 });
    expect(typeof nodeOf(view, leaf!.id).version).toBe('number');
  });

  test('the failures a parent kept are listed with the jobs', async () => {
    const [parent] = await addTree(
      t.store,
      fanOut(2, { child: { ignoreDependencyOnFailure: true } })
    );
    await failFor(t, 'children', 'first failure');
    const view = await viewOf(t, parent!.id);
    expect(view.failures).toEqual([
      expect.objectContaining({ parentId: parent!.id, mode: 'ignore', error: 'first failure' }),
    ]);
  });

  test('a child removed when it completed is listed as completed, with no version', async () => {
    const [parent, , second] = await addTree(
      t.store,
      fanOut(2, { child: { removeOnComplete: true } })
    );
    const done = await finish(t, 'children');
    const view = await viewOf(t, parent!.id);
    expect(view.nodes).toHaveLength(3);
    expect(nodeOf(view, done.id)).toMatchObject({
      state: 'completed',
      version: null,
      removed: true,
      parentId: parent!.id,
      depth: 1,
    });
    expect(nodeOf(view, second!.id).removed).toBe(false);
    expect(view.total).toBe(2);
  });

  test('only the root of a flow has a view', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    expect(await t.store.flows.view(child!.id)).toBeNull();
    expect(await t.store.flows.view('nothing')).toBeNull();
    expect(await t.store.flows.view(parent!.id)).not.toBeNull();
  });

  test('a flow larger than the limit lists whole levels from the top and says so', async () => {
    const [root] = await addTree(t.store, fanOut(6));
    const view = await viewOf(t, root!.id, 4);
    expect(view).toMatchObject({ truncated: true, limit: 4, total: 7 });
    expect(view.nodes).toHaveLength(4);
    expect(view.nodes[0]!.id).toBe(root!.id);
    expect((await viewOf(t, root!.id, 7)).truncated).toBe(false);
  });

  test('a flow of 6,000 jobs is read in bounded pieces: the default limit and the ceiling', async () => {
    await seedFlow(t, 'big', 6_000);
    const standard = await viewOf(t, 'big');
    expect(standard).toMatchObject({ truncated: true, limit: 1_000, total: 6_000 });
    expect(standard.nodes).toHaveLength(1_000);
    expect(standard.nodes[0]).toMatchObject({ id: 'big', depth: 0 });
    const widest = await viewOf(t, 'big', 100_000);
    expect(widest).toMatchObject({ truncated: true, limit: MAX_FLOW_VIEW_NODES });
    expect(widest.nodes).toHaveLength(MAX_FLOW_VIEW_NODES);
    const page = await t.store.flows.roots({ limit: 5 });
    expect(page.items[0]).toMatchObject({ id: 'big', total: 6_000, states: { waiting: 5_999 } });
  });

  test('childIds lists the jobs that name a parent, in id order and bounded', async () => {
    const [parent, first, second, third] = await addTree(t.store, fanOut(3));
    const all = [first!.id, second!.id, third!.id].sort();
    expect(await t.store.flows.childIds(parent!.id, 10)).toEqual(all);
    expect(await t.store.flows.childIds(parent!.id, 2)).toEqual(all.slice(0, 2));
    expect(await t.store.flows.childIds(first!.id, 10)).toEqual([]);
  });

  test('a job reports its parent and flow root, and no parent once the parent is gone', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1, { parent: { jobId: 'p' } }));
    expect(await t.store.control.details(child!.id)).toMatchObject({
      parentId: 'p',
      flowRoot: 'p',
    });
    expect(await t.store.control.details(parent!.id)).toMatchObject({
      parentId: null,
      flowRoot: 'p',
    });
    await t.store.cancel(parent!.id);
    expect(await t.store.control.details(child!.id)).toMatchObject({
      parentId: null,
      flowRoot: 'p',
    });
    const [plain] = await t.store.enqueue([{ queue: 'x', data: 1 }]);
    expect(await t.store.control.details(plain!.id)).toMatchObject({
      parentId: null,
      flowRoot: null,
    });
  });
});
