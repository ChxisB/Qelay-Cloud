import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { addTree, edgesOf, failFor, failuresOf, finish, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('flows: a child that fails after its parent was released', () => {
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

  /** `continue` releases the parent while the other children are still running. */
  const released = () =>
    addTree(t.store, {
      queue: 'parents',
      children: [
        { queue: 'first', options: { continueParentOnFailure: true } },
        { queue: 'ignored', options: { ignoreDependencyOnFailure: true } },
        { queue: 'removed', options: { removeDependencyOnFailure: true } },
        { queue: 'plain' },
        { queue: 'failing', options: { failParentOnFailure: true } },
      ],
    });

  test('a late ignore is recorded and a late remove is dropped, and the released parent is left as it is', async () => {
    const [parent, first, ignored, removed, plain, failing] = await released();
    await failFor(t, 'first', 'early');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    const version = await t.fresh.sql`SELECT version FROM qcloud_jobs WHERE id = ${parent!.id}`;

    await failFor(t, 'ignored', 'late ignore');
    await failFor(t, 'removed', 'late remove');
    expect(await edgesOf(t, parent!.id)).toEqual([failing!.id, plain!.id].sort());
    expect(await failuresOf(t, parent!.id)).toEqual(
      [
        { child_id: first!.id, mode: 'continue', error: 'early' },
        { child_id: ignored!.id, mode: 'ignore', error: 'late ignore' },
      ].sort((a, b) => (a.child_id < b.child_id ? -1 : 1))
    );
    const { unprocessed } = await t.store.flows.dependencies(parent!.id);
    expect([...unprocessed].sort()).toEqual([`failing:${failing!.id}`, `plain:${plain!.id}`]);
    expect(removed).toBeDefined();
    // Not released a second time, not failed.
    expect(await t.fresh.sql`SELECT version FROM qcloud_jobs WHERE id = ${parent!.id}`).toEqual(
      version
    );
    expect(await flowDefects(t)).toEqual([]);
  });

  test('a late failParentOnFailure does not fail a parent that was released', async () => {
    const [parent, , , , , failing] = await released();
    await failFor(t, 'first', 'early');
    await failFor(t, 'failing', 'too late');
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    // The edge stays: nothing lets go of a child whose policy is to fail a parent that is already running.
    expect(await edgesOf(t, parent!.id)).toContain(failing!.id);
    expect(await flowDefects(t)).toEqual([]);
  });

  test('a child that completes after the release changes nothing', async () => {
    const [parent, , , , plain] = await released();
    await failFor(t, 'first', 'early');
    const done = await finish(t, 'plain', 'late result');
    expect(done.id).toBe(plain!.id);
    expect((await summary(t, parent!.id))!.state).toBe('waiting');
    expect(await t.store.flows.childrenValues(parent!.id)).toEqual({
      [`plain:${plain!.id}`]: 'late result',
    });
  });

  test('a late failure of a child whose parent was cancelled records nothing', async () => {
    const [parent, , ignored] = await released();
    await t.store.cancel(parent!.id);
    await failFor(t, 'ignored', 'orphaned');
    expect(await failuresOf(t, parent!.id)).toEqual([]);
    expect((await summary(t, ignored!.id))!.state).toBe('failed');
    expect(await flowDefects(t)).toEqual([]);
  });
});
