import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JobVersionError, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { act, request, viewOf } from './flowActionHelpers';
import { addTree, edgesOf, failFor, fanOut, finish, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: retry-failed', () => {
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

  test('a failed child goes back on the queue as a fresh job, and the parent is released when it completes', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children', 'first try');
    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');

    const result = await act(t, parent!.id, 'retry-failed', [failed.id]);
    expect(result).toMatchObject({
      applied: true,
      changes: [{ id: failed.id, queue: 'children', from: 'failed', to: 'waiting' }],
    });
    if (!result.applied) throw new Error('unreachable');
    expect(result.rings.map((ring) => ring.bell.jobId)).toEqual([failed.id]);

    const [row] = await t.fresh.sql<
      Array<{ state: string; attempts: number; error: string | null; dlq_entry: Uint8Array | null }>
    >`SELECT state, attempts, error, dlq_entry FROM qcloud_jobs WHERE id = ${failed.id}`;
    expect(row).toMatchObject({ state: 'waiting', attempts: 0, error: null, dlq_entry: null });
    expect(log.events.map((event) => event.type)).toContain('retried');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await edgesOf(t, parent!.id)).toEqual([first!.id, second!.id].sort());

    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await flowDefects(t)).toEqual([]);
  });

  test('a retried child that fails again blocks the parent again', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const failed = await failFor(t, 'children');
    await act(t, parent!.id, 'retry-failed', [failed.id]);
    await failFor(t, 'children', 'second failure');
    const view = await viewOf(t, parent!.id);
    expect(view.nodes.find((node) => node.id === failed.id)).toMatchObject({
      state: 'failed',
      blocking: true,
      error: 'second failure',
    });
  });

  test('several failed children are retried together', async () => {
    const [parent] = await addTree(t.store, fanOut(3));
    const ids = [(await failFor(t, 'children')).id, (await failFor(t, 'children')).id];
    const result = await act(t, parent!.id, 'retry-failed', ids);
    expect(result.applied && result.changes.map((change) => change.id).sort()).toEqual(
      [...ids].sort()
    );
    expect((await summary(t, ids[0]!))!.state).toBe('waiting');
    expect((await summary(t, ids[1]!))!.state).toBe('waiting');
  });

  test('a version that moved throws and nothing is changed', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children');
    const stale = await request(t, parent!.id, 'retry-failed', [failed.id]);
    expect(await act(t, parent!.id, 'retry-failed', [failed.id])).toMatchObject({ applied: true });
    await failFor(t, 'children', 'again');
    await expect(t.store.flows.act(parent!.id, stale)).rejects.toBeInstanceOf(JobVersionError);
    expect(
      (
        await t.fresh.sql<Array<{ state: string; error: string }>>`
        SELECT state, error FROM qcloud_jobs WHERE id = ${failed.id}`
      )[0]
    ).toMatchObject({ state: 'failed', error: 'again' });
  });

  test('one job that cannot be retried refuses the whole request', async () => {
    const [parent, , second] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children');
    const waiting = failed.id === second!.id ? 'x' : second!.id;
    const result = await act(t, parent!.id, 'retry-failed', [failed.id, waiting]);
    expect(result).toEqual({ applied: false, refusal: { kind: 'not_retryable', ids: [waiting] } });
    expect((await summary(t, failed.id))!.state).toBe('failed');
  });

  test('a child whose policy let go of it holds nothing, so it is not retried', async () => {
    const [parent] = await addTree(
      t.store,
      fanOut(2, { child: { ignoreDependencyOnFailure: true } })
    );
    const failed = await failFor(t, 'children');
    const result = await act(t, parent!.id, 'retry-failed', [failed.id]);
    expect(result).toEqual({
      applied: false,
      refusal: { kind: 'not_retryable', ids: [failed.id] },
    });
  });

  test('once the root is cancelled there is no flow to act on', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const failed = await failFor(t, 'children');
    const stale = await request(t, parent!.id, 'retry-failed', [failed.id]);
    await t.store.cancel(parent!.id);
    // The root is gone, so there is no flow to act on.
    expect(await t.store.flows.act(parent!.id, stale)).toEqual({
      applied: false,
      refusal: { kind: 'not_found' },
    });
    expect((await summary(t, failed.id))!.state).toBe('failed');
  });

  test('a parent that never ran because a grandchild failed is not retried: its children are not done', async () => {
    const [root, middle] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      children: [
        {
          queue: 'middle',
          data: 1,
          children: [{ queue: 'leaf', data: 2, options: { failParentOnFailure: true } }],
        },
      ],
    });
    await failFor(t, 'leaf');
    expect((await summary(t, middle!.id))!.state).toBe('failed');
    const result = await act(t, root!.id, 'retry-failed', [middle!.id]);
    expect(result).toEqual({
      applied: false,
      refusal: { kind: 'not_retryable', ids: [middle!.id] },
    });
    expect((await summary(t, middle!.id))!.state).toBe('failed');
  });

  test('a job that is not in the flow is foreign', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const [stranger] = await addTree(
      t.store,
      fanOut(1, { parentQueue: 'others', childQueue: 'more' })
    );
    const failed = await failFor(t, 'more');
    const view = await viewOf(t, parent!.id);
    const result = await t.store.flows.act(parent!.id, {
      action: 'retry-failed',
      jobs: [{ id: failed.id, expectedVersion: 1 }],
    });
    expect(result).toEqual({ applied: false, refusal: { kind: 'foreign', ids: [failed.id] } });
    expect(view.nodes).toHaveLength(2);
    expect(stranger).toBeDefined();
  });

  test('a request that names no jobs, a job twice or a bad version is refused before the database', async () => {
    const [parent, child] = await addTree(t.store, fanOut(1));
    const flows = t.store.flows;
    const call = (jobs: Array<{ id: string; expectedVersion: number }>) =>
      flows.act(parent!.id, { action: 'retry-failed', jobs });
    await expect(call([])).rejects.toBeInstanceOf(UnsupportedOptionError);
    const twice = { id: child!.id, expectedVersion: 0 };
    await expect(call([twice, twice])).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(call([{ id: child!.id, expectedVersion: -1 }])).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
    await expect(
      flows.act(parent!.id, { action: 'retry-failed', jobs: [twice], parent: parent!.id })
    ).rejects.toBeInstanceOf(UnsupportedOptionError);
  });
});
