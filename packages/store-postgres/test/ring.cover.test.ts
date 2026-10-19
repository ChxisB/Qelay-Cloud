import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, readJob, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

describeDb('ring cover: a recent bell covers the new jobs of its queue', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringCoverMs: 1_000, ringWindowMs: 60_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    rewind(t);
  });

  const add = async (queue = 'q', options = {}, store = t.store) => {
    const [job] = await store.enqueue([{ queue, data: 1, options }]);
    return job!;
  };
  /** A job rung and reported, as the SDK does after a publish. */
  const ringAndReport = async (queue = 'q') => {
    const job = await add(queue);
    await t.store.markRung([{ jobId: job.id, deliverAfterMs: 0 }]);
    return job;
  };
  const rungAt = async (id: string) => Number((await readJob(t, id))!.rung_at);

  test('a queue with no recent bell is rung, then a job inside the window is not, and is marked rung', async () => {
    const first = await ringAndReport();
    expect(first.ring).not.toBeNull();
    const second = await add();
    expect(second.created).toBe(true);
    expect(second.ring).toBeNull();
    expect(await rungAt(second.id)).toBe(START);
    // The tick does not take it for a job that never had a bell.
    expect(await t.store.dueForRing({ graceMs: 0, reRingAfterMs: 5_000 })).toEqual([]);
  });

  test('a batch on a covered queue is not rung at all; a batch on a bare queue is rung job by job', async () => {
    await ringAndReport('busy');
    const covered = await t.store.enqueue(
      Array.from({ length: 3 }, (_, n) => ({ queue: 'busy', data: n }))
    );
    expect(covered.map((job) => job.ring)).toEqual([null, null, null]);
    const bare = await t.store.enqueue(
      Array.from({ length: 3 }, (_, n) => ({ queue: 'idle', data: n }))
    );
    expect(bare.every((job) => job.ring !== null)).toBe(true);
  });

  test('the window ends: a bell older than ringCoverMs covers nothing', async () => {
    await ringAndReport();
    t.clock.advance(999);
    expect((await add()).ring).toBeNull();
    t.clock.advance(1);
    expect((await add()).ring).not.toBeNull();
  });

  test('a job that was claimed no longer covers its queue', async () => {
    const job = await claimOne(t, {});
    await t.store.markRung([{ jobId: job.id, deliverAfterMs: 0 }]);
    expect((await add()).ring).not.toBeNull();
  });

  test('a delayed job keeps its ring, and a pre-rung delayed job does not cover', async () => {
    await ringAndReport();
    const delayed = await add('q', { delay: 5_000 });
    expect(delayed.ring).toMatchObject({ dueInMs: 5_000 });
    await resetTables(t);
    const early = await add('q', { delay: 5_000 });
    await t.store.markRung([{ jobId: early.id, deliverAfterMs: 5_000 }]);
    expect((await add()).ring).not.toBeNull();
  });

  test('a covered job whose bell was lost is re-rung once the bell is reRingAfterMs old', async () => {
    await ringAndReport();
    const covered = await add();
    const options = { graceMs: 0, reRingAfterMs: 5_000, perQueueCap: 10 };
    t.clock.advance(4_999);
    expect(await t.store.dueForRing(options)).toEqual([]);
    t.clock.advance(1);
    const due = (await t.store.dueForRing(options)).map((ring) => ring.bell.jobId);
    expect(due).toContain(covered.id);
  });

  test('it is off unless asked for, and the option is checked', async () => {
    const plain = t.another({ ringCoverMs: 0 });
    await ringAndReport();
    expect((await add('q', {}, plain)).ring).not.toBeNull();
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => t.another({ ringCoverMs: bad })).toThrow(UnsupportedOptionError);
    }
  });
});
