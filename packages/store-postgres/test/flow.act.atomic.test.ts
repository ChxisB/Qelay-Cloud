import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { act, request, viewOf } from './flowActionHelpers';
import { addTree, failFor, fanOut, finish, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const edgeCount = async (t: TestStore): Promise<number> =>
  Number(
    (
      await t.fresh.sql<
        Array<{ total: string }>
      >`SELECT count(*)::text AS total FROM qcloud_dependencies`
    )[0]!.total
  );

const jobCount = async (t: TestStore): Promise<number> =>
  Number(
    (
      await t.fresh.sql<Array<{ total: string }>>`SELECT count(*)::text AS total FROM qcloud_jobs`
    )[0]!.total
  );

/**
 * Makes every deleted job row take a second, so a test can end the connection while the delete is
 * under way, after the rows before it are already deleted inside the transaction.
 */
async function slowDeletes(t: TestStore): Promise<void> {
  await t.fresh.sql.unsafe(`
    CREATE OR REPLACE FUNCTION qcloud_slow_delete() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`);
  await t.fresh.sql.unsafe(`
    CREATE TRIGGER qcloud_slow_delete BEFORE DELETE ON qcloud_jobs
    FOR EACH ROW EXECUTE FUNCTION qcloud_slow_delete()`);
}

async function killDeleter(t: TestStore): Promise<number> {
  const rows = await t.fresh.sql<Array<{ killed: boolean }>>`
    SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%DELETE FROM qcloud_jobs%'`;
  return rows.filter((row) => row.killed).length;
}

describeDb('flows: an action is applied whole or not at all', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    await t.fresh.sql.unsafe(`DROP TRIGGER IF EXISTS qcloud_slow_delete ON qcloud_jobs`);
  });

  test('a connection that ends in the middle of a flow removal leaves every job in place', async () => {
    const [root] = await addTree(t.store, {
      queue: 'top',
      data: 0,
      children: [
        {
          queue: 'mid',
          data: 1,
          children: [
            { queue: 'leaf', data: 2 },
            { queue: 'leaf', data: 3 },
          ],
        },
        { queue: 'other', data: 4 },
      ],
    });
    await finish(t, 'leaf');
    const before = await viewOf(t, root!.id);
    const asked = await request(
      t,
      root!.id,
      'remove',
      before.nodes.filter((node) => node.version !== null).map((node) => node.id)
    );
    const edgesBefore = await edgeCount(t);
    await slowDeletes(t);

    const removing = t.store.flows.act(root!.id, asked).then(
      () => 'finished' as const,
      () => 'failed' as const
    );
    await Bun.sleep(1_500);
    expect(await killDeleter(t)).toBeGreaterThan(0);
    expect(await removing).toBe('failed');

    // Nothing was removed, nothing half-removed: the flow reads as it did and still works.
    expect(await jobCount(t)).toBe(before.nodes.length);
    expect(await edgeCount(t)).toBe(edgesBefore);
    const after = await viewOf(t, root!.id);
    expect(after.nodes.map((node) => [node.id, node.state, node.version])).toEqual(
      before.nodes.map((node) => [node.id, node.state, node.version])
    );
    expect(await flowDefects(t)).toEqual([]);

    // The same request goes through once the connection is healthy.
    await t.fresh.sql.unsafe(`DROP TRIGGER qcloud_slow_delete ON qcloud_jobs`);
    expect(await t.store.flows.act(root!.id, asked)).toMatchObject({ applied: true });
    expect(await jobCount(t)).toBe(0);
  }, 30_000);

  test('a retry that cannot be recorded changes nothing', async () => {
    const [parent] = await addTree(t.store, fanOut(2));
    const one = await failFor(t, 'children');
    const two = await failFor(t, 'children');
    const failing = t.another({
      recorder: {
        record: async () => {
          throw new Error('journal is down');
        },
      },
    });
    const asked = await request(t, parent!.id, 'retry-failed', [one.id, two.id]);
    await expect(failing.flows.act(parent!.id, asked)).rejects.toThrow('journal is down');
    expect((await summary(t, one.id))!.state).toBe('failed');
    expect((await summary(t, two.id))!.state).toBe('failed');
    expect(await act(t, parent!.id, 'retry-failed', [one.id, two.id])).toMatchObject({
      applied: true,
    });
  });

  test('a promote that cannot be recorded leaves the parent waiting and the failures unrecorded', async () => {
    const [parent] = await addTree(t.store, fanOut(1));
    const failed = await failFor(t, 'children');
    const failing = t.another({
      recorder: {
        record: async () => {
          throw new Error('journal is down');
        },
      },
    });
    const asked = await request(t, parent!.id, 'promote', [parent!.id, failed.id], parent!.id);
    await expect(failing.flows.act(parent!.id, asked)).rejects.toThrow('journal is down');
    expect((await summary(t, parent!.id))!.state).toBe('waiting-children');
    expect(await t.store.flows.ignoredFailures(parent!.id)).toEqual({});
    expect(await flowDefects(t)).toEqual([]);
  });
});
