import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { JobVersionError, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, readJob, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

/**
 * `expectedVersion` fences every operator action (DESIGN.md invariant 2): an action decided against
 * a version the job has left changes nothing and says so.
 */
describeDb('operator actions: version fencing', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ ringWindowMs: 60_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const delayed = async (): Promise<string> => (await enqueueN(t.store, 1, { delay: 60_000 }))[0]!;
  const versionOf = async (id: string): Promise<number> =>
    (await t.store.control.details(id))!.version;

  type Action = (id: string, expectedVersion?: number) => Promise<unknown>;
  const actions: Array<[string, Action]> = [
    [
      'promote',
      (id, v) => t.store.promote(id, v === undefined ? undefined : { expectedVersion: v }),
    ],
    [
      'changePriority',
      (id, v) =>
        t.store.changePriority(id, 5, v === undefined ? undefined : { expectedVersion: v }),
    ],
    ['cancel', (id, v) => t.store.cancel(id, v === undefined ? undefined : { expectedVersion: v })],
    [
      'updateData',
      (id, v) =>
        t.store.control.updateData(
          id,
          { n: 2 },
          v === undefined ? undefined : { expectedVersion: v }
        ),
    ],
    [
      'changeDelay',
      (id, v) =>
        t.store.control.changeDelay(
          id,
          90_000,
          v === undefined ? undefined : { expectedVersion: v }
        ),
    ],
    [
      'remove',
      (id, v) => t.store.control.remove(id, v === undefined ? undefined : { expectedVersion: v }),
    ],
  ];

  describe.each(actions)('%s', (_name, run) => {
    test('with a stale version throws JobVersionError and changes nothing', async () => {
      const id = await delayed();
      const seen = await versionOf(id);
      // Another operator edits the job: it is now at a newer version than the one read.
      await t.store.changePriority(id, 2);
      const before = await readJob(t, id);
      const error = await run(id, seen).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JobVersionError);
      expect(error).toMatchObject({ jobId: id, expected: seen, actual: seen + 1 });
      expect(await readJob(t, id)).toEqual(before!);
    });

    test('with the current version is applied, and without a version it is applied as before', async () => {
      const first = await delayed();
      await expect(run(first, await versionOf(first))).resolves.not.toBeInstanceOf(Error);
      const second = await delayed();
      await expect(run(second)).resolves.not.toBeInstanceOf(Error);
    });

    test('names a version that is not a non-negative integer: refused as an option', async () => {
      const id = await delayed();
      for (const bad of [-1, 1.5, Number.NaN]) {
        await expect(run(id, bad)).rejects.toBeInstanceOf(UnsupportedOptionError);
      }
    });
  });

  test('a job that a worker claimed after it was read is fenced even though the action would refuse it anyway', async () => {
    const [id] = await enqueueN(t.store, 1);
    const seen = await versionOf(id!);
    const job = await claimOne(t);
    expect(job.id).toBe(id!);
    await expect(t.store.cancel(id!, { expectedVersion: seen })).rejects.toBeInstanceOf(
      JobVersionError
    );
    // The lease is untouched: the worker can still finish the job.
    await t.store.complete(job.lease, 'done');
    expect((await t.store.getJob(id!))?.state).toBe('completed');
  });

  test('an unknown id with a version is still "not found", not a version error', async () => {
    expect(await t.store.cancel('missing', { expectedVersion: 3 })).toBe(false);
    expect(await t.store.control.remove('missing', { expectedVersion: 3 })).toBe('not-found');
    expect((await t.store.promote('missing', { expectedVersion: 3 })).ok).toBe(false);
  });

  test('every edit moves the version by one, so the next stale action is caught', async () => {
    const id = await delayed();
    const start = await versionOf(id);
    await t.store.control.updateData(id, { n: 3 }, { expectedVersion: start });
    expect(await versionOf(id)).toBe(start + 1);
    await t.store.changePriority(id, 4, { expectedVersion: start + 1 });
    expect(await versionOf(id)).toBe(start + 2);
    await expect(
      t.store.control.changeDelay(id, 1_000, { expectedVersion: start })
    ).rejects.toBeInstanceOf(JobVersionError);
  });
});
