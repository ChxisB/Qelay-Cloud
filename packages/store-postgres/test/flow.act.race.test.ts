import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { JobVersionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { resetTables } from './finishHelpers';
import { request } from './flowActionHelpers';
import { addTree, fanOut, flowDefects, summary } from './flowHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const ROUNDS = 25;

/**
 * A flow of two children in queues of its own (`c<n>` under `p<n>`): the first is failed for good, so
 * it holds the parent, and the second is claimed, so it is running with its lease in hand.
 */
async function stuckAndRunning(t: TestStore, round: number) {
  const queue = `c${round}`;
  const [parent] = await addTree(
    t.store,
    fanOut(2, { parentQueue: `p${round}`, childQueue: queue })
  );
  const [first, second] = await t.store.claim(queue, 'w', 2);
  await t.store.fail(first!.lease, { message: 'broke', unrecoverable: true });
  return { parent: parent!.id, failed: first!.id, running: second!, queue };
}

const settle = <T>(work: Promise<T>) =>
  work.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error }) as const
  );

describeDb('flows: an action racing a worker or another action', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  test('a retry while the other child finishes: both land, the parent keeps waiting for the retried one', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { parent, failed, running } = await stuckAndRunning(t, round);
      const asked = await request(t, parent, 'retry-failed', [failed]);
      const [retried, completed] = await Promise.all([
        settle(t.store.flows.act(parent, asked)),
        settle(t.store.complete(running.lease, 'done')),
      ]);
      expect(retried).toHaveProperty('value.applied', true);
      expect(completed).toHaveProperty('value.ok', true);
      expect((await summary(t, parent))!.state).toBe('waiting-children');
      expect((await summary(t, failed))!.state).toBe('waiting');
    }
    expect(await flowDefects(t)).toEqual([]);
  }, 60_000);

  test('a promote while the other child finishes: it is refused, or it releases the parent once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { parent, failed, running } = await stuckAndRunning(t, round);
      const asked = await request(t, parent, 'promote', [parent, failed], parent);
      const [promoted] = await Promise.all([
        settle(t.store.flows.act(parent, asked)),
        settle(t.store.complete(running.lease, 'done')),
      ]);
      if ('error' in promoted) throw promoted.error;
      if (promoted.value.applied) {
        expect((await summary(t, parent))!.state).toBe('waiting');
      } else {
        // The child was still running when the action looked: the parent keeps waiting.
        expect(promoted.value.refusal).toMatchObject({ kind: 'not_stuck' });
        expect((await summary(t, parent))!.state).toBe('waiting-children');
      }
    }
    expect(await flowDefects(t)).toEqual([]);
  }, 60_000);

  test('a retry and a promote of the same picture: at most one is applied', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const queue = `c${round}`;
      const [parent] = await addTree(
        t.store,
        fanOut(1, { parentQueue: `p${round}`, childQueue: queue })
      );
      const [job] = await t.store.claim(queue, 'w', 1);
      await t.store.fail(job!.lease, { message: 'broke', unrecoverable: true });
      const retry = await request(t, parent!.id, 'retry-failed', [job!.id]);
      const promote = await request(t, parent!.id, 'promote', [parent!.id, job!.id], parent!.id);
      const [first, second] = await Promise.all([
        settle(t.store.flows.act(parent!.id, retry)),
        settle(t.store.flows.act(parent!.id, promote)),
      ]);
      const applied = [first, second].filter(
        (outcome) => 'value' in outcome && outcome.value.applied
      );
      expect(applied).toHaveLength(1);
      for (const outcome of [first, second]) {
        if ('error' in outcome) expect(outcome.error).toBeInstanceOf(JobVersionError);
      }
      expect(await flowDefects(t)).toEqual([]);
    }
  }, 60_000);

  test('a removal while a worker finishes a child: the flow is gone or whole, never half', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const queue = `c${round}`;
      const [parent] = await addTree(
        t.store,
        fanOut(2, { parentQueue: `p${round}`, childQueue: queue })
      );
      const [running] = await t.store.claim(queue, 'w', 1);
      const view = await t.store.flows.view(parent!.id);
      const asked = {
        action: 'remove' as const,
        jobs: view!.nodes.map((node) => ({ id: node.id, expectedVersion: node.version! })),
      };
      const [removed] = await Promise.all([
        settle(t.store.flows.act(parent!.id, asked)),
        settle(t.store.complete(running!.lease, 'done')),
      ]);
      const left = await t.fresh.sql<Array<{ total: string }>>`
        SELECT count(*)::text AS total FROM qcloud_jobs WHERE flow_root = ${parent!.id}`;
      if ('value' in removed && removed.value.applied) expect(left[0]!.total).toBe('0');
      else expect(left[0]!.total).toBe('3');
      await t.fresh.sql`DELETE FROM qcloud_jobs WHERE flow_root = ${parent!.id}`;
      await t.fresh.sql`DELETE FROM qcloud_dependencies WHERE job_id = ${parent!.id}`;
      await t.fresh.sql`DELETE FROM qcloud_completions`;
    }
    expect(await flowDefects(t)).toEqual([]);
  }, 60_000);
});
