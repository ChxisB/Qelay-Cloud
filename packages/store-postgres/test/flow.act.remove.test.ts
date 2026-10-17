import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JobVersionError, MAX_FLOW_JOBS } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { act, request, seedFlow, viewOf } from './flowActionHelpers';
import { addTree, failFor, fanOut, finish, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

/** Every job of the flow, each at the version a fresh view shows: what an operator confirms. */
async function removeAll(t: TestStore, root: string) {
  const view = await viewOf(t, root);
  const ids = view.nodes.filter((node) => node.version !== null).map((node) => node.id);
  return act(t, root, 'remove', ids);
}

const counts = async (t: TestStore) =>
  (
    await t.fresh.sql<Array<Record<string, string>>>`
      SELECT (SELECT count(*) FROM qcloud_jobs)::text AS jobs,
             (SELECT count(*) FROM qcloud_dependencies)::text AS edges,
             (SELECT count(*) FROM qcloud_flow_failures)::text AS failures,
             (SELECT count(*) FROM qcloud_completions)::text AS completions`
  )[0]!;

describeDb('flows: remove a whole flow', () => {
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

  test('every job, edge, kept failure and completion record of the flow goes, and nothing else', async () => {
    const [root, middle] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      children: [
        {
          queue: 'middle',
          data: 1,
          children: [
            { queue: 'leaf', data: 2, options: { ignoreDependencyOnFailure: true } },
            { queue: 'leaf', data: 3, options: { removeOnComplete: true } },
          ],
        },
        { queue: 'other', data: 4 },
      ],
    });
    const [kept] = await addTree(
      t.store,
      fanOut(2, { parentQueue: 'kept', childQueue: 'kept-children' })
    );
    await failFor(t, 'leaf', 'ignored failure');
    await finish(t, 'leaf');
    expect((await summary(t, middle!.id))!.state).toBe('waiting');

    const result = await removeAll(t, root!.id);
    expect(result).toMatchObject({ applied: true, rings: [] });
    if (!result.applied) throw new Error('unreachable');
    expect(result.changes).toHaveLength(4);
    expect(result.changes.every((change) => change.to === 'removed')).toBe(true);
    expect(result.changes.map((change) => change.id)).toContain(root!.id);

    expect(await t.store.flows.view(root!.id)).toBeNull();
    expect((await t.store.flows.roots({ limit: 10 })).items.map((item) => item.id)).toEqual([
      kept!.id,
    ]);
    // What is left is the other flow, whole.
    expect(await counts(t)).toEqual({ jobs: '3', edges: '2', failures: '0', completions: '0' });
    expect(log.events.filter((event) => event.type === 'removed')).toHaveLength(4);
    expect(await flowDefects(t)).toEqual([]);
  });

  test('a flow with a running job is refused whole and every job stays', async () => {
    const [root] = await addTree(t.store, fanOut(3));
    const [running] = await t.store.claim('children', 'w', 1);
    const before = await counts(t);
    const result = await removeAll(t, root!.id);
    expect(result).toEqual({ applied: false, refusal: { kind: 'active', ids: [running!.id] } });
    expect(await counts(t)).toEqual(before);
    await t.store.complete(running!.lease, 'done');
    expect(await removeAll(t, root!.id)).toMatchObject({ applied: true });
    expect((await counts(t)).jobs).toBe('0');
  });

  test('a job the request did not name makes the picture stale: unseen', async () => {
    const [root, first] = await addTree(t.store, fanOut(2));
    const view = await viewOf(t, root!.id);
    const others = view.nodes.filter((node) => node.id !== first!.id).map((node) => node.id);
    const result = await act(t, root!.id, 'remove', others);
    expect(result).toEqual({ applied: false, refusal: { kind: 'unseen', ids: [first!.id] } });
    expect((await counts(t)).jobs).toBe('3');
  });

  test('a job that left the flow, or never was in it, is foreign', async () => {
    const [root] = await addTree(t.store, fanOut(1));
    const base = await request(t, root!.id, 'remove', [root!.id]);
    const result = await t.store.flows.act(root!.id, {
      action: 'remove',
      jobs: [...base.jobs, { id: 'nobody', expectedVersion: 0 }],
    });
    expect(result).toMatchObject({ applied: false, refusal: { kind: 'foreign', ids: ['nobody'] } });
  });

  test('a version that moved throws and the whole flow stays', async () => {
    const [root] = await addTree(t.store, fanOut(2));
    const view = await viewOf(t, root!.id);
    const stale = {
      action: 'remove' as const,
      jobs: view.nodes.map((node) => ({ id: node.id, expectedVersion: node.version! })),
    };
    await finish(t, 'children');
    await expect(t.store.flows.act(root!.id, stale)).rejects.toBeInstanceOf(JobVersionError);
    expect((await counts(t)).jobs).toBe('3');
  });

  test('a job that is not the root of a flow has nothing to remove', async () => {
    const [, child] = await addTree(t.store, fanOut(1));
    const result = await t.store.flows.act(child!.id, {
      action: 'remove',
      jobs: [{ id: child!.id, expectedVersion: 0 }],
    });
    expect(result).toEqual({ applied: false, refusal: { kind: 'not_found' } });
    const [plain] = await t.store.enqueue([{ queue: 'x', data: 1 }]);
    expect(
      await t.store.flows.act(plain!.id, {
        action: 'remove',
        jobs: [{ id: plain!.id, expectedVersion: 0 }],
      })
    ).toEqual({ applied: false, refusal: { kind: 'not_found' } });
  });

  test('a flow with more jobs than an action reads is refused', async () => {
    await seedFlow(t, 'huge', MAX_FLOW_JOBS + 1);
    const result = await t.store.flows.act('huge', {
      action: 'remove',
      jobs: [{ id: 'huge', expectedVersion: 0 }],
    });
    expect(result).toEqual({
      applied: false,
      refusal: { kind: 'too_large', limit: MAX_FLOW_JOBS },
    });
    expect((await counts(t)).jobs).toBe(String(MAX_FLOW_JOBS + 1));
  });
});
