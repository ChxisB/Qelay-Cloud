import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { PayloadTooLargeError } from '../src/errors';
import { codec, readJob, resetTables } from './finishHelpers';
import { addTree, fanOut } from './flowHelpers';
import { countStatements } from './statementCount';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const POLICY = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000, maxDelay: 600_000 },
  timeout: 30_000,
};
const boom = { message: 'boom', unrecoverable: false };

describeDb('queue retry policy', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  /** What the job row stores of the three settings, the backoff being inside the payload. */
  async function stored(id: string) {
    const [row] = await t.fresh.sql<
      Array<{ max_attempts: number; timeout: string | null; payload: Uint8Array }>
    >`SELECT max_attempts, timeout, payload FROM qcloud_jobs WHERE id = ${id}`;
    const { backoff } = codec.decode(row!.payload) as { backoff: unknown };
    return {
      attempts: row!.max_attempts,
      timeout: row!.timeout === null ? null : Number(row!.timeout),
      backoff,
    };
  }

  test('a policy is read back, replaced whole, and removed by null or {}', async () => {
    expect(await t.store.queues.policy('q')).toBeNull();
    expect(await t.store.queues.setPolicy('q', POLICY)).toEqual(POLICY);
    expect(await t.store.queues.policy('q')).toEqual(POLICY);
    expect(
      await t.store.queues.setPolicy('q', {
        attempts: 2,
        backoff: { type: 'fixed', delay: 500 },
      })
    ).toEqual({
      attempts: 2,
      backoff: { type: 'fixed', delay: 500 },
    });
    expect(await t.store.queues.setPolicy('q', {})).toBeNull();
    expect(await t.store.queues.policy('q')).toBeNull();
    await t.store.queues.setPolicy('q', POLICY);
    expect(await t.store.queues.setPolicy('q', null)).toBeNull();
    expect(await t.store.queues.policy('q')).toBeNull();
  });

  test('setting the first policy on a queue never used creates the row; another queue has none', async () => {
    await t.store.queues.setPolicy('fresh', POLICY);
    expect(await t.store.queues.policy('fresh')).toEqual(POLICY);
    expect(await t.store.queues.policy('other')).toBeNull();
  });

  test('a job that sets nothing gets the policy; the job row stores it', async () => {
    await t.store.queues.setPolicy('q', POLICY);
    const [id] = await enqueueN(t.store, 1);
    expect(await stored(id!)).toEqual({
      attempts: 5,
      timeout: 30_000,
      backoff: POLICY.backoff,
    });
  });

  test("a job's own attempts, backoff and timeout each win, and the others still come from the policy", async () => {
    await t.store.queues.setPolicy('q', POLICY);
    const [own, someOwn] = await t.store.enqueue([
      { queue: 'q', data: 1, options: { attempts: 2, backoff: 100, timeout: 1_000 } },
      { queue: 'q', data: 2, options: { attempts: 1 } },
    ]);
    expect(await stored(own!.id)).toEqual({
      attempts: 2,
      timeout: 1_000,
      backoff: { type: 'fixed', delay: 100 },
    });
    expect(await stored(someOwn!.id)).toEqual({
      attempts: 1,
      timeout: 30_000,
      backoff: POLICY.backoff,
    });
  });

  test('a policy applies to jobs added after it is saved, and to its queue only', async () => {
    const [before] = await enqueueN(t.store, 1);
    const [elsewhere] = await enqueueN(t.store, 1, {}, 'other');
    await t.store.queues.setPolicy('q', POLICY);
    const [after] = await enqueueN(t.store, 1);
    expect((await stored(before!)).attempts).toBe(1);
    expect((await stored(elsewhere!)).attempts).toBe(1);
    expect((await stored(after!)).attempts).toBe(5);
    await t.store.queues.setPolicy('q', null);
    expect((await stored(after!)).attempts).toBe(5);
    const [removed] = await enqueueN(t.store, 1);
    expect((await stored(removed!)).attempts).toBe(1);
  });

  test('a failed job is retried after the policy backoff', async () => {
    await t.store.queues.setPolicy('q', {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
    });
    await enqueueN(t.store, 1);
    const [job] = await t.store.claim('q', 'w', 1);
    await t.store.fail(job!.lease, boom);
    // The first retry waits twice the base (see backoff.test).
    expect(await readJob(t, job!.id)).toMatchObject({
      state: 'delayed',
      attempts: 1,
      run_at: String(START + 2_000),
    });
  });

  test('a flow child gets the policy of its queue, its parent the policy of the parent queue', async () => {
    await t.store.queues.setPolicy('children', { attempts: 4 });
    await t.store.queues.setPolicy('parents', { attempts: 7 });
    const [parent, child] = await addTree(t.store, fanOut(1));
    expect((await stored(parent!.id)).attempts).toBe(7);
    expect((await stored(child!.id)).attempts).toBe(4);
  });

  test('a cron job gets the policy of the queue it fires into', async () => {
    await t.store.queues.setPolicy('cq', { attempts: 6 });
    await t.store.crons.upsert({ name: 'tick', queue: 'cq', repeatEvery: 60_000 });
    t.clock.advance(60_000);
    await t.store.crons.claimDue();
    const page = await t.store.listJobs({ queue: 'cq', limit: 10 });
    expect(page.items).toHaveLength(1);
    expect((await stored(page.items[0]!.id)).attempts).toBe(6);
  });

  test('a queue with a policy costs an enqueue no statement more than a queue without', async () => {
    const counted = countStatements(t.fresh.db);
    const store = t.another({ db: counted.db });
    await store.enqueue([{ queue: 'plain', data: 1 }]);
    const plain = counted.count();
    await t.store.queues.setPolicy('with', POLICY);
    counted.reset();
    await store.enqueue([{ queue: 'with', data: 1 }]);
    expect(counted.count()).toBe(plain);
    // Measured on the code before queue policies: 5.
    expect(plain).toBe(5);
  });

  test('an invalid policy is refused and names the field; the stored one stays', async () => {
    await t.store.queues.setPolicy('q', POLICY);
    for (const [policy, option] of [
      [{ attempts: 0 }, 'attempts'],
      [{ backoff: { type: 'linear', delay: 1 } }, 'backoff.type'],
      [{ delay: 5 }, 'delay'],
    ] as const) {
      const error = await t.store.queues.setPolicy('q', policy as never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsupportedOptionError);
      expect((error as UnsupportedOptionError).option).toBe(option);
    }
    expect(await t.store.queues.policy('q')).toEqual(POLICY);
  });

  test('a policy backoff that pushes a job over the payload limit refuses the enqueue', async () => {
    const [plain] = await t.store.enqueue([{ queue: 'other', data: 'x'.repeat(40) }]);
    const [row] = await t.fresh.sql<Array<{ size: number }>>`
      SELECT length(payload) AS size FROM qcloud_jobs WHERE id = ${plain!.id}`;
    const tight = t.another({ maxPayloadBytes: row!.size });
    await t.store.queues.setPolicy('q', { backoff: POLICY.backoff });
    await tight.enqueue([{ queue: 'other', data: 'x'.repeat(40) }]);
    const error = await tight
      .enqueue([{ queue: 'q', data: 'x'.repeat(40) }])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadTooLargeError);
  });
});
