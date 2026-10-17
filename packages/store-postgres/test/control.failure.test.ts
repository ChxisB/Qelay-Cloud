import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

describeDb('control: job failure', () => {
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

  test('an unknown id is null, and so is a job that never failed', async () => {
    expect(await t.store.control.failure('missing')).toBeNull();
    const job = await claimOne(t);
    expect(await t.store.control.failure(job.id)).toBeNull();
  });

  test('a job that is retrying carries the history of its failed attempts and no final reason', async () => {
    const job = await claimOne(t, { attempts: 3, backoff: 0 });
    await t.store.fail(job.lease, { message: 'first', unrecoverable: false });
    const failure = (await t.store.control.failure(job.id))!;
    expect(failure.reason).toBeNull();
    expect(failure.stack).toBeNull();
    expect(failure.stalls).toBe(0);
    expect(failure.attempts.map((attempt) => [attempt.attempt, attempt.error])).toEqual([
      [1, 'first'],
    ]);
  });

  test('a failed job carries its final reason, the stack it failed with and every attempt', async () => {
    const job = await claimOne(t, { attempts: 2, backoff: 0 });
    await t.store.fail(job.lease, { message: 'first', unrecoverable: false });
    const [again] = await t.store.claim('q', 'w2', 1);
    await t.store.fail(again!.lease, {
      message: 'second',
      stack: 'Error: second\n    at handler (worker.ts:1:1)',
      unrecoverable: false,
    });
    const failure = (await t.store.control.failure(job.id))!;
    expect(failure.reason).not.toBeNull();
    expect(failure.stack).toBe('Error: second\n    at handler (worker.ts:1:1)');
    expect(failure.attempts.map((attempt) => attempt.error)).toEqual(['first', 'second']);
  });

  test('a job that finished by completing carries no failure', async () => {
    const job = await claimOne(t);
    await t.store.complete(job.lease, 'done');
    expect(await t.store.control.failure(job.id)).toBeNull();
  });

  test('failuresMany answers for several jobs in one read and leaves out the ones with none', async () => {
    const retrying = await claimOne(t, { attempts: 3, backoff: 0 });
    await t.store.fail(retrying.lease, { message: 'again', unrecoverable: false });
    const failed = await claimOne(t, { attempts: 1 }, 'other');
    await t.store.fail(failed.lease, { message: 'gone', unrecoverable: false });
    const fine = await claimOne(t, {}, 'third');
    const found = await t.store.control.failuresMany([retrying.id, failed.id, fine.id, 'missing']);
    expect([...found.keys()].sort()).toEqual([failed.id, retrying.id].sort());
    expect(found.get(retrying.id)).toEqual((await t.store.control.failure(retrying.id))!);
    expect(found.get(failed.id)).toEqual((await t.store.control.failure(failed.id))!);
    expect((await t.store.control.failuresMany([])).size).toBe(0);
  });

  test('failuresMany refuses more ids than one page', async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => `j${index}`);
    await expect(t.store.control.failuresMany(ids)).rejects.toThrow('at most 1000');
  });
});
