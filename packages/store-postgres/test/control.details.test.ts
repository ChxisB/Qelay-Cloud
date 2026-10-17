import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('control: job details', () => {
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

  test('an unknown id is null', async () => {
    expect(await t.store.control.details('missing')).toBeNull();
  });

  test('a new job reads as the job record plus empty progress, result and timestamps', async () => {
    const [id] = await enqueueN(t.store, 1);
    expect(await t.store.control.details(id!)).toEqual({
      ...(await t.store.getJob(id!))!,
      progress: 0,
      progressMessage: null,
      returnValue: null,
      failedReason: null,
      startedAt: null,
      completedAt: null,
      version: 0,
      parentId: null,
      flowRoot: null,
      options: { priority: 0, lifo: false, attempts: 1, backoff: { type: 'fixed', delay: 1000 } },
    });
  });

  test('the version moves with a claim and a finish, so a reader can name what it read', async () => {
    const job = await claimOne(t);
    const claimed = (await t.store.control.details(job.id))!.version;
    expect(claimed).toBeGreaterThan(0);
    await t.store.complete(job.lease, 'done');
    expect((await t.store.control.details(job.id))!.version).toBeGreaterThan(claimed);
  });

  test('the options of the enqueue call are read back from the row and the payload', async () => {
    const [job] = await t.store.enqueue([
      {
        queue: 'q',
        name: 'n',
        data: 1,
        options: {
          priority: 3,
          lifo: true,
          attempts: 5,
          backoff: { type: 'exponential', delay: 200, maxDelay: 9_000 },
          timeout: 4_000,
          stallTimeout: 8_000,
          jobId: 'custom-1',
          deduplication: { id: 'dk', ttl: 60_000, extend: true },
          group: { id: 'g1', maxSize: 10 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      },
    ]);
    expect((await t.store.control.details(job!.id))?.options).toEqual({
      priority: 3,
      lifo: true,
      attempts: 5,
      backoff: { type: 'exponential', delay: 200, maxDelay: 9_000 },
      timeout: 4_000,
      stallTimeout: 8_000,
      jobId: 'custom-1',
      deduplication: { id: 'dk', ttl: 60_000, extend: true },
      group: { id: 'g1', maxSize: 10 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  });

  test('a completed job carries its return value and its start and finish times', async () => {
    const job = await claimOne(t);
    t.clock.advance(250);
    await t.store.complete(job.lease, { ok: [1, 2] });
    expect(await t.store.control.details(job.id)).toMatchObject({
      state: 'completed',
      returnValue: { ok: [1, 2] },
      startedAt: START,
      completedAt: START + 250,
      failedReason: null,
    });
  });

  test('a failed job carries the message it failed with', async () => {
    const job = await claimOne(t);
    await t.store.fail(job.lease, { message: 'boom', unrecoverable: false });
    expect(await t.store.control.details(job.id)).toMatchObject({
      state: 'failed',
      failedReason: 'boom',
      returnValue: null,
    });
  });

  describe('detailsMany', () => {
    test('reads several jobs in the order asked, leaves out an unknown id, and equals `details`', async () => {
      const ids = await enqueueN(t.store, 3);
      const asked = [ids[2]!, 'missing', ids[0]!, ids[1]!];
      const many = await t.store.control.detailsMany(asked);
      expect(many.map((job) => job.id)).toEqual([ids[2]!, ids[0]!, ids[1]!]);
      for (const job of many) expect(job).toEqual((await t.store.control.details(job.id))!);
    });

    test('an empty list is an empty answer without a query, and a custom id and a dollar sign in an id are plain text', async () => {
      expect(await t.store.control.detailsMany([])).toEqual([]);
      const [job] = await t.store.enqueue([
        { queue: 'q', data: 1, options: { jobId: 'a,"b"\\{c}' } },
      ]);
      expect((await t.store.control.detailsMany([job!.id])).map((one) => one.id)).toEqual([
        'a,"b"\\{c}',
      ]);
    });

    test('more than one page of ids is refused', async () => {
      const ids = Array.from({ length: 1001 }, (_, index) => `j${index}`);
      await expect(t.store.control.detailsMany(ids)).rejects.toBeInstanceOf(UnsupportedOptionError);
    });
  });
});
