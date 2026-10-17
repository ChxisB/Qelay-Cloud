import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { StoreError, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { PayloadTooLargeError } from '../src/errors';
import { claimOne, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

describeDb('control: update data, change delay, update progress', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({
      recorder: log.recorder,
      ringWindowMs: 60_000,
      maxPayloadBytes: 2_000,
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  const one = async (options = {}): Promise<string> => (await enqueueN(t.store, 1, options))[0]!;

  describe('updateData', () => {
    test('replaces the data of a pending job and keeps its name and retry settings', async () => {
      const [job] = await t.store.enqueue([
        { queue: 'q', name: 'send', data: { n: 1 }, options: { backoff: 2_500, attempts: 4 } },
      ]);
      log.events.length = 0;
      expect(await t.store.control.updateData(job!.id, { n: 2, extra: [1, 2] })).toBe(true);
      expect(await t.store.getJob(job!.id)).toMatchObject({
        name: 'send',
        data: { n: 2, extra: [1, 2] },
        state: 'waiting',
        maxAttempts: 4,
      });
      expect((await t.store.control.details(job!.id))?.options.backoff).toEqual({
        type: 'fixed',
        delay: 2_500,
      });
      expect(await readJob(t, job!.id)).toMatchObject({ version: '1' });
      expect(log.events).toEqual([
        { type: 'updated', queue: 'q', jobId: job!.id, state: 'waiting' },
      ]);
    });

    test.each([
      ['delayed', () => one({ delay: 60_000 }), 'delayed'],
      ['prioritized', () => one({ priority: 3 }), 'prioritized'],
    ])('works on a %s job, which keeps its state', async (_name, make, state) => {
      const id = await make();
      expect(await t.store.control.updateData(id, 'new')).toBe(true);
      expect(await t.store.getJob(id)).toMatchObject({ data: 'new', state });
    });

    test('works on an active job without touching its lease', async () => {
      const job = await claimOne(t);
      const before = await readJob(t, job.id);
      expect(await t.store.control.updateData(job.id, { retryState: 7 })).toBe(true);
      const after = await readJob(t, job.id);
      expect(after).toMatchObject({
        state: 'active',
        lease_token: before!.lease_token,
        lease_until: before!.lease_until,
      });
      expect(await t.store.getJob(job.id)).toMatchObject({ data: { retryState: 7 } });
      expect((await t.store.complete(job.lease, null)).ok).toBe(true);
    });

    test('is false for a finished job and an unknown id, and changes nothing', async () => {
      const job = await claimOne(t);
      await t.store.complete(job.lease, 'done');
      log.events.length = 0;
      expect(await t.store.control.updateData(job.id, 'late')).toBe(false);
      expect(await t.store.control.updateData('missing', 'x')).toBe(false);
      expect(await t.store.getJob(job.id)).toMatchObject({ data: 0 });
      expect(log.events).toEqual([]);
    });

    test('data over the payload limit is refused and the job keeps its data', async () => {
      const id = await one();
      await expect(t.store.control.updateData(id, 'x'.repeat(5_000))).rejects.toBeInstanceOf(
        PayloadTooLargeError
      );
      expect(await t.store.getJob(id)).toMatchObject({ data: 0 });
      expect(await readJob(t, id)).toMatchObject({ version: '0' });
    });

    test('data the codec cannot encode is a StoreError and the job keeps its data', async () => {
      const id = await one();
      await expect(t.store.control.updateData(id, Symbol('x'))).rejects.toBeInstanceOf(StoreError);
      expect(await t.store.getJob(id)).toMatchObject({ data: 0 });
    });
  });

  describe('changeDelay', () => {
    test('moves a delayed job to a new time, clears its bell and returns a new one', async () => {
      const id = await one({ delay: 60_000 });
      await t.store.markRung([{ jobId: id, deliverAfterMs: 60_000 }]);
      t.clock.advance(1_000);
      log.events.length = 0;
      const outcome = await t.store.control.changeDelay(id, 30_000);
      expect(outcome).toEqual({
        ok: true,
        rings: [{ bell: { namespace: 'test', queue: 'q', jobId: id }, dueInMs: 30_000 }],
      });
      expect(await readJob(t, id)).toMatchObject({
        state: 'delayed',
        run_at: String(START + 31_000),
        rung_at: null,
        version: '1',
      });
      expect(log.events).toEqual([{ type: 'updated', queue: 'q', jobId: id, state: 'delayed' }]);
    });

    test('a delay beyond the ring window returns no bell: the tick rings it nearer its time', async () => {
      const id = await one({ delay: 1_000 });
      expect(await t.store.control.changeDelay(id, 3_600_000)).toEqual({ ok: true, rings: [] });
      expect((await readJob(t, id))?.rung_at).toBeNull();
    });

    test('a delay of 0 makes the job claimable now, as promote does', async () => {
      const id = await one({ delay: 60_000, priority: 2 });
      log.events.length = 0;
      expect(await t.store.control.changeDelay(id, 0)).toEqual({
        ok: true,
        rings: [{ bell: { namespace: 'test', queue: 'q', jobId: id }, dueInMs: 0 }],
      });
      expect(await readJob(t, id)).toMatchObject({ state: 'prioritized', run_at: String(START) });
      expect(log.events).toEqual([
        { type: 'promoted', queue: 'q', jobId: id, state: 'prioritized' },
      ]);
      expect((await t.store.claim('q', 'w', 1)).map((job) => job.id)).toEqual([id]);
    });

    test('a fractional delay is rounded down', async () => {
      const id = await one({ delay: 60_000 });
      await t.store.control.changeDelay(id, 1_500.9);
      expect((await readJob(t, id))?.run_at).toBe(String(START + 1_500));
    });

    test.each([
      ['waiting', () => one()],
      ['prioritized', () => one({ priority: 2 })],
      ['active', async () => (await claimOne(t)).id],
    ])('is refused for a %s job, which is left as it was', async (_name, make) => {
      const id = await make();
      const before = await readJob(t, id);
      log.events.length = 0;
      expect(await t.store.control.changeDelay(id, 5_000)).toEqual({ ok: false, rings: [] });
      expect(await readJob(t, id)).toEqual(before!);
      expect(log.events).toEqual([]);
    });

    test('is refused for a delayed job whose time has already come, a finished job and an unknown id', async () => {
      const due = await one({ delay: 1_000 });
      t.clock.advance(1_000);
      expect(await t.store.control.changeDelay(due, 5_000)).toEqual({ ok: false, rings: [] });
      const job = await claimOne(t);
      await t.store.complete(job.lease, null);
      expect((await t.store.control.changeDelay(job.id, 5_000)).ok).toBe(false);
      expect((await t.store.control.changeDelay('missing', 5_000)).ok).toBe(false);
    });

    test.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['5' as unknown as number]])(
      'a delay of %p is an UnsupportedOptionError, whatever the job',
      async (delay) => {
        const id = await one({ delay: 60_000 });
        await expect(t.store.control.changeDelay(id, delay)).rejects.toBeInstanceOf(
          UnsupportedOptionError
        );
        expect(await readJob(t, id)).toMatchObject({ version: '0' });
      }
    );
  });

  describe('updateProgress', () => {
    test('stores the number on an active job and journals it', async () => {
      const job = await claimOne(t);
      log.events.length = 0;
      expect(await t.store.control.updateProgress(job.id, 40)).toBe(true);
      expect(await t.store.control.details(job.id)).toMatchObject({
        progress: 40,
        progressMessage: null,
      });
      expect(log.events).toEqual([
        { type: 'progress', queue: 'q', jobId: job.id, state: 'active', progress: 40 },
      ]);
    });

    test('an object or a text is stored as 0 with its text, and a number is clamped', async () => {
      const job = await claimOne(t);
      await t.store.control.updateProgress(job.id, { step: 2 });
      expect(await t.store.control.details(job.id)).toMatchObject({
        progress: 0,
        progressMessage: '{"step":2}',
      });
      await t.store.control.updateProgress(job.id, 250, 'over');
      expect(await t.store.control.details(job.id)).toMatchObject({
        progress: 100,
        progressMessage: 'over',
      });
      // A later number without a message clears the old message.
      await t.store.control.updateProgress(job.id, 5);
      expect(await t.store.control.details(job.id)).toMatchObject({
        progress: 5,
        progressMessage: null,
      });
    });

    test('is false, and changes nothing, for a pending job, a finished job and an unknown id', async () => {
      const waiting = await one();
      expect(await t.store.control.updateProgress(waiting, 10)).toBe(false);
      const job = await claimOne(t);
      await t.store.complete(job.lease, null);
      log.events.length = 0;
      expect(await t.store.control.updateProgress(job.id, 10)).toBe(false);
      expect(await t.store.control.updateProgress('missing', 10)).toBe(false);
      expect(log.events).toEqual([]);
      expect(await t.store.control.details(waiting)).toMatchObject({ progress: 0 });
    });

    test('does not bump the version: a progress update never fences a worker or an operator', async () => {
      const job = await claimOne(t);
      const before = await readJob(t, job.id);
      await t.store.control.updateProgress(job.id, 70);
      expect((await readJob(t, job.id))?.version).toBe(before!.version);
    });
  });
});
