import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JobVersionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { recording, resetTables } from './finishHelpers';
import { act, request } from './flowActionHelpers';
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

/** Everything a promote of `parent` must name: the parent, then each failed child that holds it. */
const promote = (t: TestStore, parent: string, ...failed: string[]) =>
  act(t, parent, 'promote', [parent, ...failed], parent);

describeDb('flows: promote a stuck parent', () => {
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

  test('a parent held only by a failed child runs, and its processor reads the failure as ignored', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children', 'cannot be fixed');
    const done = await finish(t, 'children', 'fine');
    const result = await promote(t, parent!.id, failed.id);
    expect(result).toMatchObject({
      applied: true,
      changes: [{ id: parent!.id, queue: 'parents', from: 'waiting-children', to: 'waiting' }],
    });
    if (!result.applied) throw new Error('unreachable');
    expect(result.rings.map((ring) => ring.bell.jobId)).toEqual([parent!.id]);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await t.store.flows.ignoredFailures(parent!.id)).toEqual({
      [`children:${failed.id}`]: 'cannot be fixed',
    });
    expect(await failuresOf(t, parent!.id)).toEqual([
      { child_id: failed.id, mode: 'ignore', error: 'cannot be fixed' },
    ]);
    expect(await edgesOf(t, parent!.id)).toEqual([done.id]);
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`children:${done.id}`]: 'fine',
    });
    // The failed child stays in the DLQ, untouched.
    expect((await summary(t, failed.id))!.state).toBe('failed');
    expect(log.events.map((event) => event.type)).toContain('promoted');
    expect(await flowDefects(t)).toEqual([]);
    expect([first!.id, second!.id]).toContain(failed.id);
  });

  test('every failed child that holds the parent is let go together', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const one = await failFor(t, 'children', 'one');
    const two = await failFor(t, 'children', 'two');
    expect(await promote(t, parent!.id, one.id, two.id)).toMatchObject({ applied: true });
    expect(Object.keys(await t.store.flows.ignoredFailures(parent!.id)).sort()).toEqual(
      [`children:${one.id}`, `children:${two.id}`].sort()
    );
    expect(await edgesOf(t, parent!.id)).toEqual([]);
  });

  test('a flow stuck below the root is released at that level only', async () => {
    const [root, middle] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      children: [{ queue: 'middle', data: 1, children: [{ queue: 'leaf', data: 2 }] }],
    });
    const failed = await failFor(t, 'leaf');
    expect(await t.store.flows.view(middle!.id)).toBeNull();
    const result = await act(t, root!.id, 'promote', [middle!.id, failed.id], middle!.id);
    expect(result).toMatchObject({ applied: true, changes: [{ id: middle!.id, to: 'waiting' }] });
    expect((await summary(t, root!.id))!.state).toBe('waiting-children');
    await finish(t, 'middle');
    expect((await summary(t, root!.id))!.state).toBe('waiting');
  });

  test('a child that has not finished leaves the parent waiting, and nothing is changed', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children');
    const waiting = failed.id === first!.id ? second!.id : first!.id;
    const result = await promote(t, parent!.id, failed.id);
    expect(result).toEqual({
      applied: false,
      refusal: { kind: 'not_stuck', reason: 'children_unfinished', ids: [waiting] },
    });
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await edgesOf(t, parent!.id)).toHaveLength(2);
    expect(await failuresOf(t, parent!.id)).toEqual([]);
  });

  test('a child that is running when the parent is promoted counts as unfinished', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children');
    const [running] = await t.store.claim('children', 'w', 1);
    const result = await promote(t, parent!.id, failed.id);
    expect(result).toEqual({
      applied: false,
      refusal: { kind: 'not_stuck', reason: 'children_unfinished', ids: [running!.id] },
    });
    // It finishes afterwards, and the parent is still held by the failed child.
    await t.store.complete(running!.lease, 'done');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await promote(t, parent!.id, failed.id)).toMatchObject({ applied: true });
  });

  test('a parent that is not waiting is refused', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    await finish(t, 'children');
    expect(await act(t, parent!.id, 'promote', [parent!.id], parent!.id)).toEqual({
      applied: false,
      refusal: { kind: 'not_stuck', reason: 'not_waiting', ids: [parent!.id] },
    });
  });

  test('a waiting parent with no failed child holding it is refused', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    await finish(t, 'children');
    // Put the released parent back to waiting, as a repair of a lost release would find it.
    await t.fresh.sql`
      UPDATE qcloud_jobs SET state = 'waiting-children', version = version + 1 WHERE id = ${parent!.id}`;
    expect(await act(t, parent!.id, 'promote', [parent!.id], parent!.id)).toEqual({
      applied: false,
      refusal: { kind: 'not_stuck', reason: 'nothing_blocks', ids: [] },
    });
  });

  test('a failed child the request did not name makes the picture stale: unseen', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const one = await failFor(t, 'children');
    const two = await failFor(t, 'children');
    const result = await promote(t, parent!.id, one.id);
    expect(result).toEqual({ applied: false, refusal: { kind: 'unseen', ids: [two.id] } });
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
  });

  test('a named job that does not hold the parent is foreign', async () => {
    const [parent, first, second] = await addTree(t.store, fanOut(2));
    const failed = await failFor(t, 'children');
    const other = failed.id === first!.id ? second!.id : first!.id;
    const result = await t.store.flows.act(parent!.id, {
      action: 'promote',
      parent: parent!.id,
      jobs: [...(await request(t, parent!.id, 'promote', [parent!.id, failed.id, other])).jobs],
    });
    expect(result).toEqual({ applied: false, refusal: { kind: 'foreign', ids: [other] } });
  });

  test('a parent outside the flow is foreign', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const [stranger] = await addTree(
      t.store,
      fanOut(1, { parentQueue: 'others', childQueue: 'more' })
    );
    const result = await t.store.flows.act(parent!.id, {
      action: 'promote',
      parent: stranger!.id,
      jobs: [{ id: stranger!.id, expectedVersion: 0 }],
    });
    expect(result).toEqual({ applied: false, refusal: { kind: 'foreign', ids: [stranger!.id] } });
  });

  test('a version that moved, the parent or a child, throws and nothing is changed', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const one = await failFor(t, 'children');
    const two = await failFor(t, 'children');
    const stale = await request(t, parent!.id, 'promote', [parent!.id, one.id, two.id], parent!.id);
    // A retry moves a child; the old picture no longer fits.
    expect(await act(t, parent!.id, 'retry-failed', [one.id])).toMatchObject({ applied: true });
    await failFor(t, 'children', 'again');
    await expect(t.store.flows.act(parent!.id, stale)).rejects.toBeInstanceOf(JobVersionError);
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');

    const moved = await request(t, parent!.id, 'promote', [parent!.id, one.id, two.id], parent!.id);
    await t.fresh.sql`UPDATE qcloud_jobs SET version = version + 1 WHERE id = ${parent!.id}`;
    await expect(t.store.flows.act(parent!.id, moved)).rejects.toBeInstanceOf(JobVersionError);
    expect(await failuresOf(t, parent!.id)).toEqual([]);
  });
});
