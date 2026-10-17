import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addTree, failFor, fanOut, finish, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

interface Tag {
  readonly id: string;
  readonly parent_id: string | null;
  readonly flow_root: string | null;
  readonly flow_depth: number | null;
  readonly version: string;
}

const tagsOf = (t: TestStore): Promise<Tag[]> =>
  t.fresh.sql<Tag[]>`
    SELECT id, parent_id, flow_root, flow_depth, version::text FROM qcloud_jobs ORDER BY id`;

describeDb('flows: membership tags', () => {
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

  test('each job of a flow carries its root and its depth below it, and a plain job carries neither', async () => {
    const [root, middle, leaf, other] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      options: { jobId: 'top-job' },
      children: [
        { queue: 'mid', data: 1, children: [{ queue: 'leaf', data: 2 }] },
        { queue: 'other', data: 3 },
      ],
    });
    const [plain] = await t.store.enqueue([{ queue: 'plain', data: 4 }]);
    const tags = new Map((await tagsOf(t)).map((tag) => [tag.id, tag]));
    expect(tags.get(root!.id)).toMatchObject({
      flow_root: 'top-job',
      flow_depth: 0,
      parent_id: null,
    });
    expect(tags.get(middle!.id)).toMatchObject({ flow_root: 'top-job', flow_depth: 1 });
    expect(tags.get(leaf!.id)).toMatchObject({ flow_root: 'top-job', flow_depth: 2 });
    expect(tags.get(other!.id)).toMatchObject({ flow_root: 'top-job', flow_depth: 1 });
    expect(tags.get(plain!.id)).toMatchObject({ flow_root: null, flow_depth: null });
  });

  test('a flow added under the id of a cancelled one detaches the old children', async () => {
    const [first] = await addTree(t.store, fanOut(2, { parent: { jobId: 'again' } }));
    const old = (await tagsOf(t)).filter((tag) => tag.id !== first!.id);
    expect(old).toHaveLength(2);
    await t.store.cancel(first!.id);
    // The children went on as plain jobs. They still name their old parent and flow.
    expect((await tagsOf(t)).every((tag) => tag.flow_root === 'again')).toBe(true);

    const [second, fresh] = await addTree(t.store, fanOut(1, { parent: { jobId: 'again' } }));
    expect(second!.id).toBe('again');
    const after = await tagsOf(t);
    for (const orphan of old) {
      expect(after.find((tag) => tag.id === orphan.id)).toMatchObject({
        parent_id: null,
        flow_root: null,
        flow_depth: null,
      });
      expect(Number(after.find((tag) => tag.id === orphan.id)!.version)).toBeGreaterThan(
        Number(orphan.version)
      );
    }
    const view = await t.store.flows.view('again');
    expect(view!.nodes.map((node) => node.id).sort()).toEqual([fresh!.id, 'again'].sort());
    expect(await t.store.flows.childIds('again', 10)).toEqual([fresh!.id]);
  });

  test('an old child of a reused parent id finishes without touching the new flow', async () => {
    const [first, oldChild] = await addTree(
      t.store,
      fanOut(1, { parent: { jobId: 'again' }, childQueue: 'old' })
    );
    await t.store.cancel(first!.id);
    const [, fresh] = await addTree(
      t.store,
      fanOut(1, { parent: { jobId: 'again' }, childQueue: 'new' })
    );
    await finish(t, 'old');
    expect((await summary(t, 'again'))!.state).toBe('waiting-children');
    expect((await summary(t, oldChild!.id))!.state).toBe('completed');
    await failFor(t, 'new');
    expect((await summary(t, 'again'))!.state).toBe('waiting-children');
    expect((await summary(t, fresh!.id))!.state).toBe('failed');
    expect(await flowDefects(t)).toEqual([]);
  });
});
