import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobState } from '@qelay-cloud/core';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { claimOne, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('operator actions: promote, change priority, cancel', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, ringWindowMs: 60_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  const delayed = async (delay = 60_000, priority = 0): Promise<string> =>
    (await enqueueN(t.store, 1, { delay, priority }))[0]!;

  describe('promote', () => {
    test('makes a delayed job due now, clears its bell and returns a new one', async () => {
      const id = await delayed();
      await t.store.markRung([{ jobId: id, deliverAfterMs: 60_000 }]);
      expect((await readJob(t, id))?.rung_at).toBe(String(START + 60_000));
      t.clock.advance(5_000);
      log.events.length = 0;
      const outcome = await t.store.promote(id);
      expect(outcome).toEqual({
        ok: true,
        rings: [{ bell: { namespace: 'test', queue: 'q', jobId: id }, dueInMs: 0 }],
      });
      expect(await readJob(t, id)).toMatchObject({
        state: 'waiting',
        run_at: String(START + 5_000),
        rung_at: null,
        version: '1',
      });
      expect(log.events).toEqual([{ type: 'promoted', queue: 'q', jobId: id, state: 'waiting' }]);
      expect((await t.store.claim('q', 'w', 1)).map((job) => job.id)).toEqual([id]);
    });

    test('a delayed job with a priority becomes prioritized', async () => {
      const id = await delayed(60_000, 3);
      expect((await t.store.promote(id)).ok).toBe(true);
      expect(await readJob(t, id)).toMatchObject({ state: 'prioritized' });
    });

    test.each([
      ['waiting', async () => (await enqueueN(t.store, 1))[0]!],
      ['prioritized', async () => (await enqueueN(t.store, 1, { priority: 2 }))[0]!],
      ['active', async () => (await claimOne(t)).id],
    ])('is refused for a %s job, which is left as it was', async (_state, make) => {
      const id = await make();
      const before = await readJob(t, id);
      log.events.length = 0;
      expect(await t.store.promote(id)).toEqual({ ok: false, rings: [] });
      expect(await readJob(t, id)).toEqual(before!);
      expect(log.events).toEqual([]);
    });

    test('is refused for a delayed job whose time has already come', async () => {
      const id = await delayed(1_000);
      t.clock.advance(1_000);
      // Stored as delayed, but already claimable: promotion would change nothing a reader can see.
      expect((await readJob(t, id))?.state).toBe('delayed');
      expect(await t.store.promote(id)).toEqual({ ok: false, rings: [] });
      expect((await readJob(t, id))?.version).toBe('0');
    });

    test('is refused for a job that does not exist, a finished one and a failed one', async () => {
      expect(await t.store.promote('missing')).toEqual({ ok: false, rings: [] });
      const job = await claimOne(t);
      await t.store.complete(job.lease, 'done');
      expect((await t.store.promote(job.id)).ok).toBe(false);
    });
  });

  describe('changePriority', () => {
    const cases: Array<[string, { delay?: number; priority?: number }, number, JobState]> = [
      ['waiting to prioritized', {}, 4, 'prioritized'],
      ['prioritized to waiting', { priority: 4 }, 0, 'waiting'],
      ['prioritized to a different priority', { priority: 4 }, 9, 'prioritized'],
      ['delayed stays delayed', { delay: 60_000 }, 4, 'delayed'],
      ['delayed with a priority stays delayed at 0', { delay: 60_000, priority: 2 }, 0, 'delayed'],
    ];
    test.each(cases)('%s', async (_name, options, priority, state) => {
      const [id] = await enqueueN(t.store, 1, options);
      log.events.length = 0;
      expect(await t.store.changePriority(id!, priority)).toBe(true);
      expect(await readJob(t, id!)).toMatchObject({ state, version: '1' });
      expect((await t.store.getJob(id!))?.priority).toBe(priority);
      expect(log.events).toEqual([{ type: 'priority', queue: 'q', jobId: id!, state }]);
    });

    test('keeps the bell: the job is no more or less claimable than before', async () => {
      const [id] = await enqueueN(t.store, 1);
      await t.store.markRung([{ jobId: id!, deliverAfterMs: 0 }]);
      await t.store.changePriority(id!, 7);
      expect((await readJob(t, id!))?.rung_at).toBe(String(START));
    });

    test('a raised priority is claimed before an older job of lower priority', async () => {
      const [first, second] = await enqueueN(t.store, 2);
      await t.store.changePriority(second!, 1);
      expect((await t.store.claim('q', 'w', 2)).map((job) => job.id)).toEqual([second!, first!]);
    });

    test('is refused, without a change, for active, finished and missing jobs', async () => {
      const job = await claimOne(t);
      log.events.length = 0;
      expect(await t.store.changePriority(job.id, 3)).toBe(false);
      expect(await t.store.changePriority('missing', 3)).toBe(false);
      await t.store.complete(job.lease, null);
      expect(await t.store.changePriority(job.id, 3)).toBe(false);
      expect(log.events.filter((event) => event.type === 'priority')).toEqual([]);
    });

    test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects the priority %p, whatever the job',
      async (priority) => {
        const [id] = await enqueueN(t.store, 1);
        await expect(t.store.changePriority(id!, priority)).rejects.toBeInstanceOf(
          UnsupportedOptionError
        );
        await expect(t.store.changePriority('missing', priority)).rejects.toBeInstanceOf(
          UnsupportedOptionError
        );
        expect((await readJob(t, id!))?.version).toBe('0');
      }
    );

    test('clamps a priority beyond INTEGER, as enqueue does', async () => {
      const [id] = await enqueueN(t.store, 1);
      expect(await t.store.changePriority(id!, 2 ** 40)).toBe(true);
      expect((await t.store.getJob(id!))?.priority).toBe(2 ** 31 - 1);
    });
  });

  describe('cancel', () => {
    const states: Array<[JobState, { delay?: number; priority?: number }]> = [
      ['waiting', {}],
      ['prioritized', { priority: 3 }],
      ['delayed', { delay: 60_000 }],
    ];
    test.each(states)('deletes a %s job and journals it as removed', async (state, options) => {
      const [id] = await enqueueN(t.store, 1, options);
      await t.fresh.sql`INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
        VALUES ('test', ${id!}, ${START}, 'info', 'a line')`;
      log.events.length = 0;
      expect(await t.store.cancel(id!)).toBe(true);
      expect(await readJob(t, id!)).toBeUndefined();
      const logs = await t.fresh.sql`SELECT 1 FROM qcloud_job_logs WHERE job_id = ${id!}`;
      expect(logs).toHaveLength(0);
      expect(log.events).toEqual([
        { type: 'removed', queue: 'q', jobId: id!, state, removed: true },
      ]);
      expect(await t.store.claim('q', 'w', 1)).toEqual([]);
    });

    test('is refused for an active, a completed and a missing job', async () => {
      const job = await claimOne(t);
      log.events.length = 0;
      expect(await t.store.cancel(job.id)).toBe(false);
      expect((await readJob(t, job.id))?.state).toBe('active');
      await t.store.complete(job.lease, 'ok');
      expect(await t.store.cancel(job.id)).toBe(false);
      expect(await t.store.cancel('missing')).toBe(false);
      expect(log.events.filter((event) => event.type === 'removed')).toEqual([]);
    });

    test('a failed event recorder rolls the cancel back', async () => {
      const [id] = await enqueueN(t.store, 1);
      log.failWith(new Error('journal down'));
      await expect(t.store.cancel(id!)).rejects.toThrow('journal down');
      log.failWith(null);
      expect((await readJob(t, id!))?.state).toBe('waiting');
    });
  });

  test('two callers racing to promote one job: exactly one wins', async () => {
    const id = await delayed();
    const other = t.another();
    const results = await Promise.all([t.store.promote(id), other.promote(id)]);
    expect(results.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await readJob(t, id))?.version).toBe('1');
  });

  test('a cancel and a claim racing for one job: one of them wins and the job is never both', async () => {
    const [id] = await enqueueN(t.store, 1);
    const other = t.another();
    const [cancelled, claimed] = await Promise.all([t.store.cancel(id!), other.claim('q', 'w', 1)]);
    const row = await readJob(t, id!);
    if (cancelled) {
      expect(row).toBeUndefined();
      expect(claimed).toEqual([]);
    } else {
      expect(row?.state).toBe('active');
      expect(claimed.map((job) => job.id)).toEqual([id!]);
    }
  });
});
