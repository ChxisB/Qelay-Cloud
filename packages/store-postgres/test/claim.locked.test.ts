import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, rewind } from './storeHelpers';

/**
 * A claim never waits for a row another transaction holds (`FOR UPDATE SKIP LOCKED`). The writer
 * that matters is `markRung`, which updates `rung_at` of a job right after the SDK rang its bell, so
 * a claim started by that very bell can find the job locked. The claim is empty, the bell is spent,
 * and the job is taken by the next claim: its next bell, or the tick's re-ring (invariant 3, at
 * most `reRingAfterMs` plus a tick interval later).
 */
describeDb('claim: a row another transaction holds', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state, qcloud_group_state`;
    rewind(t);
  });

  /** Holds `UPDATE rung_at` (what `markRung` does) on the job until the returned function is called. */
  async function holdRow(id: string): Promise<() => Promise<void>> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = t.fresh.sql.begin(async (tx) => {
      await tx`UPDATE qcloud_jobs SET rung_at = ${t.clock.now()} WHERE id = ${id}`;
      locked();
      await held;
    });
    await acquired;
    return async () => {
      release();
      await holder;
    };
  }

  test('a claim skips a job a markRung-like writer holds, and takes it once the writer commits', async () => {
    const [id] = await enqueueN(t.store, 1);
    const release = await holdRow(id!);
    expect(await t.store.claim('q', 'w1', 1)).toEqual([]);
    await release();
    const [job] = await t.store.claim('q', 'w1', 1);
    expect(job?.id).toBe(id!);
  });

  test('the jobs around the held one are taken, and the held one is not lost', async () => {
    const [first, second, third] = await enqueueN(t.store, 3);
    const release = await holdRow(second!);
    const taken = await t.store.claim('q', 'w1', 3);
    expect(taken.map((job) => job.id)).toEqual([first!, third!]);
    await release();
    expect((await t.store.claim('q', 'w1', 3)).map((job) => job.id)).toEqual([second!]);
  });

  test('a markRung that races a claim never leaves the job unclaimable: the next claim has it', async () => {
    const [id] = await enqueueN(t.store, 1);
    const claims = await Promise.all([
      t.store.claim('q', 'w1', 1),
      t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]),
    ]);
    const taken = claims[0].length === 1 ? claims[0] : await t.store.claim('q', 'w1', 1);
    expect(taken.map((job) => job.id)).toEqual([id!]);
  });
});
