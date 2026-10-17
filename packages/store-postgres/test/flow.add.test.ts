import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { FlowError, flattenFlow } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { addTree, edgesOf, fanOut, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: add', () => {
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

  test('writes the parent waiting for its children and one edge per child', async () => {
    const [parent, ...children] = await addTree(t.store, fanOut(3));
    expect(parent!.state).toBe('waiting-children');
    expect(parent!.ring).toBeNull();
    expect(children.map((child) => child.state)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(children.every((child) => child.ring !== null)).toBe(true);
    expect(await summary(t, parent!.id)).toMatchObject({
      state: 'waiting-children',
      rung_at: null,
    });
    expect(await edgesOf(t, parent!.id)).toEqual(children.map((child) => child.id).sort());
    for (const child of children) {
      expect((await summary(t, child.id))!.parent_id).toBe(parent!.id);
    }
  });

  test('children are waiting, prioritized or delayed as for any job, and only claimable ones carry a ring', async () => {
    const [, plain, urgent, later] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'children' },
        { queue: 'children', options: { priority: 3 } },
        { queue: 'children', options: { delay: 60_000 } },
      ],
    });
    expect([plain!.state, urgent!.state, later!.state]).toEqual([
      'waiting',
      'prioritized',
      'delayed',
    ]);
    expect(plain!.ring).not.toBeNull();
    expect(urgent!.ring).not.toBeNull();
    expect(later!.ring).toBeNull();
  });

  test('a parent is never claimable while it waits', async () => {
    await addTree(t.store, fanOut(1));
    expect(await t.store.claim('parents', 'w', 5)).toEqual([]);
    expect(await t.store.claim('children', 'w', 5)).toHaveLength(1);
  });

  test('nests: a child can itself be a parent', async () => {
    const jobs = await addTree(t.store, {
      queue: 'a',
      children: [{ queue: 'b', children: [{ queue: 'c' }, { queue: 'c' }] }, { queue: 'c' }],
    });
    const [root, middle, leaf1, leaf2, other] = jobs;
    expect(jobs.map((job) => job.state)).toEqual([
      'waiting-children',
      'waiting-children',
      'waiting',
      'waiting',
      'waiting',
    ]);
    expect(await edgesOf(t, root!.id)).toEqual([middle!.id, other!.id].sort());
    expect(await edgesOf(t, middle!.id)).toEqual([leaf1!.id, leaf2!.id].sort());
    expect((await summary(t, middle!.id))!.parent_id).toBe(root!.id);
  });

  test('journals the parent as waiting-children', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const pushed = log.events.filter((event) => event.type === 'pushed');
    expect(pushed.find((event) => event.jobId === parent!.id)!.state).toBe('waiting-children');
    expect(pushed).toHaveLength(2);
  });

  test('is all or nothing: a job the store refuses leaves no job and no edge', async () => {
    const tree = fanOut(3);
    const huge = 'x'.repeat(2_000_000);
    const broken = {
      ...tree,
      children: [...tree.children!.slice(0, 2), { queue: 'children', data: huge }],
    };
    await expect(addTree(t.store, broken)).rejects.toThrow();
    const [{ count }] = await t.fresh.sql<
      Array<{ count: string }>
    >`SELECT count(*) FROM qcloud_jobs`;
    expect(Number(count)).toBe(0);
    const [{ edges }] = await t.fresh.sql<Array<{ edges: string }>>`
      SELECT count(*) AS edges FROM qcloud_dependencies`;
    expect(Number(edges)).toBe(0);
  });

  test('is all or nothing when a later step of the transaction fails', async () => {
    log.failWith(new Error('journal down'));
    try {
      await expect(addTree(t.store, fanOut(2))).rejects.toThrow('journal down');
    } finally {
      log.failWith(null);
    }
    const [{ count }] = await t.fresh.sql<
      Array<{ count: string }>
    >`SELECT count(*) FROM qcloud_jobs`;
    expect(Number(count)).toBe(0);
    const [{ edges }] = await t.fresh.sql<Array<{ edges: string }>>`
      SELECT count(*) AS edges FROM qcloud_dependencies`;
    expect(Number(edges)).toBe(0);
  });

  test('a flow submitted twice with the same root id has one parent', async () => {
    const tree = { ...fanOut(2), options: { jobId: 'root' } };
    const first = await t.store.flows.add(flattenFlow(tree));
    const second = await t.store.flows.add(flattenFlow(tree));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      root: { created: false, state: 'waiting-children' },
    });
    const [{ count }] = await t.fresh.sql<
      Array<{ count: string }>
    >`SELECT count(*) FROM qcloud_jobs`;
    expect(Number(count)).toBe(3);
  });

  test('refuses a node whose custom id belongs to a live job that is not the root', async () => {
    await t.store.enqueue([{ queue: 'children', data: null, options: { jobId: 'taken' } }]);
    const tree = {
      queue: 'parents',
      children: [{ queue: 'children', options: { jobId: 'taken' } }],
    };
    await expect(addTree(t.store, tree)).rejects.toBeInstanceOf(FlowError);
    const [{ count }] = await t.fresh.sql<
      Array<{ count: string }>
    >`SELECT count(*) FROM qcloud_jobs`;
    expect(Number(count)).toBe(1);
  });

  test('takes over the custom id of a finished job and forgets its completion', async () => {
    await t.store.enqueue([{ queue: 'children', data: null, options: { jobId: 'kid' } }]);
    const [job] = await t.store.claim('children', 'w', 1);
    await t.store.complete(job!.lease, 'old');
    const [parent] = await addTree(t.store, {
      queue: 'parents',
      children: [{ queue: 'children', options: { jobId: 'kid' } }],
    });
    expect(await edgesOf(t, parent!.id)).toEqual(['kid']);
    const [{ count }] = await t.fresh.sql<Array<{ count: string }>>`
      SELECT count(*) FROM qcloud_completions WHERE job_id = 'kid'`;
    expect(Number(count)).toBe(0);
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
  });
});
