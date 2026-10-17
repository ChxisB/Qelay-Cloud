import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { NewFlowNode } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { blobOf, expireLease, metric, readJob, recording, resetTables } from './finishHelpers';
import { addTree, edgesOf, failFor, failuresOf, fanOut, finish, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: what a failed child does to its parent', () => {
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

  test('failParentOnFailure fails the parent with the child error and clears its dependency rows', async () => {
    const [parent, child, sibling] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'children', options: { failParentOnFailure: true } },
        { queue: 'children' },
      ],
    });
    const failed = await failFor(t, 'children', 'disk full');
    expect(failed.id).toBe(child!.id);
    const row = await readJob(t, parent!.id);
    expect(row).toMatchObject({
      state: 'failed',
      error: `Child job ${child!.id} failed: disk full`,
      failure_reason: 'explicit_fail',
      rung_at: null,
    });
    expect(blobOf(row)).toMatchObject({
      reason: 'explicit_fail',
      error: `Child job ${child!.id} failed: disk full`,
    });
    expect(await edgesOf(t, parent!.id)).toEqual([]);
    expect(await failuresOf(t, parent!.id)).toEqual([]);
    expect(log.events.filter((event) => event.jobId === parent!.id).at(-1)).toMatchObject({
      type: 'failed',
      state: 'failed',
    });
    // The sibling is untouched, and the parent never ran: no failed metric for it.
    expect((await summary(t, sibling!.id))!.state).toBe('waiting');
    expect((await metric(t, 'parents', 'failed')).total).toBe(0);
    expect(await t.store.claim('parents', 'w', 1)).toEqual([]);
  });

  test('a parent that asked for removeOnFail is deleted when it fails for a child', async () => {
    const [parent] = await addTree(t.store, {
      queue: 'parents',
      options: { removeOnFail: true },
      children: [{ queue: 'children', options: { failParentOnFailure: true } }],
    });
    await failFor(t, 'children');
    expect(await readJob(t, parent!.id)).toBeUndefined();
    expect(await edgesOf(t, parent!.id)).toEqual([]);
    expect(log.events.at(-1)).toMatchObject({ type: 'failed', jobId: parent!.id, removed: true });
  });

  test('a failed parent fails its own parent in turn when its edge says so', async () => {
    const [root, middle, leaf] = await addTree(t.store, {
      queue: 'a',
      children: [
        {
          queue: 'b',
          options: { failParentOnFailure: true },
          children: [{ queue: 'c', options: { failParentOnFailure: true } }],
        },
      ],
    });
    await failFor(t, 'c', 'deep');
    expect((await readJob(t, middle!.id))!.error).toBe(`Child job ${leaf!.id} failed: deep`);
    expect((await readJob(t, root!.id))!.error).toBe(
      `Child job ${middle!.id} failed: Child job ${leaf!.id} failed: deep`
    );
    expect(await edgesOf(t, root!.id)).toEqual([]);
  });

  test('a failed parent whose edge has no policy leaves its own parent waiting', async () => {
    const [root, middle] = await addTree(t.store, {
      queue: 'a',
      children: [
        { queue: 'b', children: [{ queue: 'c', options: { failParentOnFailure: true } }] },
      ],
    });
    await failFor(t, 'c');
    expect((await summary(t, middle!.id))!.state).toBe('failed');
    expect((await summary(t, root!.id))!.state).toBe('waiting-children');
  });

  test('continueParentOnFailure releases the parent at once and records the failure', async () => {
    const [parent, child, sibling] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'children', options: { continueParentOnFailure: true } },
        { queue: 'children' },
      ],
    });
    const failed = await failFor(t, 'children', 'flaky');
    expect(failed.id).toBe(child!.id);
    expect(failed.rings).toBe(1);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await failuresOf(t, parent!.id)).toEqual([
      { child_id: child!.id, mode: 'continue', error: 'flaky' },
    ]);
    // Only the failed child's edge went: the sibling's stays, so its result is readable later.
    expect(await edgesOf(t, parent!.id)).toEqual([sibling!.id]);
    expect(await t.store.flows.failedChildren(parent!.id)).toEqual({
      [`children:${child!.id}`]: 'flaky',
    });
    // The sibling finishing afterwards does not release the parent a second time.
    await finish(t, 'children', 'late');
    expect(log.events.filter((event) => event.type === 'promoted')).toHaveLength(1);
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`children:${sibling!.id}`]: 'late',
    });
  });

  test('ignoreDependencyOnFailure drops the child and the parent waits for the rest', async () => {
    const [parent, child, sibling] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'children', options: { ignoreDependencyOnFailure: true } },
        { queue: 'children' },
      ],
    });
    await failFor(t, 'children', 'ignored');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await edgesOf(t, parent!.id)).toEqual([sibling!.id]);
    expect(await failuresOf(t, parent!.id)).toEqual([
      { child_id: child!.id, mode: 'ignore', error: 'ignored' },
    ]);
    const done = await finish(t, 'children');
    expect(done.rings).toBe(1);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await t.store.flows.ignoredFailures(parent!.id)).toEqual({
      [`children:${child!.id}`]: 'ignored',
    });
    expect(await t.store.flows.failedChildren(parent!.id)).toEqual({});
  });

  test('ignoring the last unresolved child releases the parent', async () => {
    const [parent] = await addTree(
      t.store,
      fanOut(2, { child: { ignoreDependencyOnFailure: true } })
    );
    await finish(t, 'children');
    const failed = await failFor(t, 'children');
    expect(failed.rings).toBe(1);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
  });

  test('removeDependencyOnFailure drops the child and records nothing', async () => {
    const [parent, , sibling] = await addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'children', options: { removeDependencyOnFailure: true } },
        { queue: 'children' },
      ],
    });
    await failFor(t, 'children');
    expect(await edgesOf(t, parent!.id)).toEqual([sibling!.id]);
    expect(await failuresOf(t, parent!.id)).toEqual([]);
    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
  });

  test('a child with no policy blocks its parent for good', async () => {
    const [parent, child, sibling] = await addTree(t.store, fanOut(2));
    await failFor(t, 'children');
    await finish(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await edgesOf(t, parent!.id)).toEqual([child!.id, sibling!.id].sort());
    const deps = await t.store.flows.dependencies(parent!.id);
    expect(deps.unprocessed).toHaveLength(1);
    expect(Object.keys(deps.processed)).toHaveLength(1);
  });

  test('when a child sets several policies the strongest applies: fail, continue, ignore, remove', async () => {
    const options = {
      failParentOnFailure: true,
      continueParentOnFailure: true,
      ignoreDependencyOnFailure: true,
      removeDependencyOnFailure: true,
    };
    const [parent] = await addTree(t.store, fanOut(1, { child: options }));
    await failFor(t, 'children');
    expect((await summary(t, parent!.id))!.state).toBe('failed');
    await resetTables(t);
    const { failParentOnFailure: _omitted, ...rest } = options;
    const [second] = await addTree(t.store, fanOut(2, { child: rest }));
    await failFor(t, 'children');
    expect((await summary(t, second!.id))!.state).toBe('waiting');
    expect((await failuresOf(t, second!.id))[0]!.mode).toBe('continue');
  });

  test('a child that retries before it fails for good applies its policy once, at the last attempt', async () => {
    const tree: NewFlowNode = fanOut(1, { child: { attempts: 2, continueParentOnFailure: true } });
    const [parent] = await addTree(t.store, tree);
    const [job] = await t.store.claim('children', 'w', 1);
    await t.store.fail(job!.lease, { message: 'one', unrecoverable: false });
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    t.clock.advance(3_600_000);
    const [again] = await t.store.claim('children', 'w', 1);
    await t.store.fail(again!.lease, { message: 'two', unrecoverable: false });
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await failuresOf(t, parent!.id)).toHaveLength(1);
  });

  test('a child whose lease expires for good applies its policy through recovery and returns the ring', async () => {
    const [parent] = await addTree(
      t.store,
      fanOut(1, { child: { attempts: 1, continueParentOnFailure: true } })
    );
    const [job] = await t.store.claim('children', 'w', 1);
    expireLease(t, job!, 1_000);
    const report = await t.store.recoverExpired();
    expect(report.recovered).toBe(1);
    expect(report.rings.map((ring) => ring.bell.jobId)).toEqual([parent!.id]);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect((await failuresOf(t, parent!.id))[0]!.error).toBe('Job lease expired');
  });
});
