import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { JobNotFoundError, JobStateError, UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture, rungOf } from './support';

describeDb('queue: one job', () => {
  let f: SdkFixture;
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });

  /** Adds a job and claims it as a worker would; returns the job id and the lease. */
  async function active(queue = 'q') {
    const job = await f.queue(queue).add('a', { n: 1 });
    const [claimed] = await f.store.claim(queue, 'w', 1);
    return { id: job.id, lease: claimed!.lease };
  }

  describe('reading', () => {
    test("getJob returns the stored job, null for an unknown id and null for another queue's job", async () => {
      const queue = f.queue('one');
      const added = await queue.add('a', { n: 1 }, { priority: 3, jobId: 'x' });
      const read = await queue.getJob<{ n: number }>('x');
      expect(read).toMatchObject({
        id: 'x',
        name: 'a',
        data: { n: 1 },
        priority: 3,
        queueName: 'one',
      });
      expect(read!.timestamp).toBeGreaterThan(0);
      expect(added.id).toBe(read!.id);
      expect(await queue.getJob('nope')).toBeNull();
      expect(await f.queue('two').getJob('x')).toBeNull();
      expect(await queue.getJobByCustomId('x')).toMatchObject({ id: 'x' });
    });

    test("getJobState is unknown for a missing job and for another queue's job", async () => {
      const queue = f.queue('one');
      const job = await queue.add('a', 1);
      expect(await queue.getJobState(job.id)).toBe('waiting');
      expect(await queue.getJobState('nope')).toBe('unknown');
      expect(await f.queue('two').getJobState(job.id)).toBe('unknown');
    });

    test('the state helpers follow the job through claim and completion', async () => {
      const { id, lease } = await active();
      const job = (await f.queue().getJob(id))!;
      expect(await job.isActive()).toBe(true);
      expect(await job.isWaiting()).toBe(false);
      expect(job.attemptsMade).toBe(0);
      expect(job.processedOn).toBeGreaterThan(0);
      await f.store.complete(lease, { ok: true });
      const done = (await f.queue().getJob(id))!;
      expect(await done.isCompleted()).toBe(true);
      expect(done).toMatchObject({ returnvalue: { ok: true } });
      expect(done.finishedOn).toBeGreaterThan(0);
      expect(await done.getState()).toBe('completed');
    });

    test('isDelayed, isFailed and isWaitingChildren answer from the stored state', async () => {
      const queue = f.queue();
      const later = await queue.add('a', 1, { delay: 60_000 });
      expect(await later.isDelayed()).toBe(true);
      expect(await later.isFailed()).toBe(false);
      expect(await later.isWaitingChildren()).toBe(false);
    });
  });

  describe('progress and logs', () => {
    test('updateProgress is stored for an active job and ignored for any other', async () => {
      const { id } = await active();
      const queue = f.queue();
      await queue.updateJobProgress(id, 40);
      expect((await queue.getJob(id))!.progress).toBe(40);
      const waiting = await queue.add('b', 1);
      await waiting.updateProgress(80);
      expect((await queue.getJob(waiting.id))!.progress).toBe(0);
      await f.queue('two').updateJobProgress(id, 99);
      expect((await queue.getJob(id))!.progress).toBe(40);
    });

    test('job.log and addJobLog append lines that getJobLogs returns oldest first', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1);
      await job.log('first');
      expect(await queue.addJobLog(job.id, 'second')).toBe(2);
      await job.log('careful', 'warn');
      expect(await queue.getJobLogs(job.id)).toEqual({
        logs: ['[info] first', '[info] second', '[warn] careful'],
        count: 3,
      });
      expect((await queue.getJobLogs(job.id, 1, 1)).logs).toEqual(['[info] second']);
      expect((await queue.getJobLogs(job.id, 1)).count).toBe(3);
    });

    test('addJobLog with keepLogs trims to the newest lines, clearJobLogs removes them', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1);
      for (const line of ['a', 'b', 'c', 'd']) await queue.addJobLog(job.id, line);
      expect(await queue.addJobLog(job.id, 'e', 2)).toBe(2);
      expect((await queue.getJobLogs(job.id)).logs).toEqual(['[info] d', '[info] e']);
      await queue.clearJobLogs(job.id);
      expect(await queue.getJobLogs(job.id)).toEqual({ logs: [], count: 0 });
    });

    test("logging to a missing job, or to another queue's job, rejects with JobNotFoundError", async () => {
      const job = await f.queue('one').add('a', 1);
      await expect(f.queue('one').addJobLog('nope', 'x')).rejects.toBeInstanceOf(JobNotFoundError);
      await expect(f.queue('two').addJobLog(job.id, 'x')).rejects.toBeInstanceOf(JobNotFoundError);
      await expect(job.log('ok')).resolves.toBeUndefined();
      expect(await f.queue('two').getJobLogs(job.id)).toEqual({ logs: [], count: 0 });
    });

    test('getJobLogs refuses a window that is not made of integers', async () => {
      const queue = f.queue();
      await expect(queue.getJobLogs('x', -1)).rejects.toBeInstanceOf(UnsupportedOptionError);
      await expect(queue.getJobLogs('x', 0, 1.5)).rejects.toBeInstanceOf(UnsupportedOptionError);
    });
  });

  describe('changes', () => {
    test('updateData replaces the data of a pending job and of the job object', async () => {
      const queue = f.queue();
      const job = await queue.add('a', { n: 1 });
      await job.updateData({ n: 2 });
      expect(job.data).toEqual({ n: 2 });
      expect((await queue.getJob(job.id))!.data).toEqual({ n: 2 });
    });

    test('updateData rejects for a finished, missing or foreign job and leaves the object as it was', async () => {
      const { id, lease } = await active();
      await f.store.complete(lease, 1);
      const queue = f.queue();
      const finished = (await queue.getJob(id))!;
      await expect(finished.updateData({ n: 9 })).rejects.toBeInstanceOf(JobStateError);
      expect(finished.data).toEqual({ n: 1 });
      await expect(queue.updateJobData('nope', 1)).rejects.toBeInstanceOf(JobStateError);
      await expect(f.queue('two').updateJobData(id, 1)).rejects.toBeInstanceOf(JobStateError);
    });

    test('changeDelay moves a delayed job and 0 makes it due and rings it', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1, { delay: 60_000 });
      await queue.changeJobDelay(job.id, 120_000);
      expect(await job.getState()).toBe('delayed');
      await job.changeDelay(0);
      expect(await job.getState()).toBe('waiting');
      expect(f.transport.buffered('q').ready).toBe(1);
      expect(await rungOf(f, [job.id])).toEqual({ [job.id]: true });
    });

    test("changeDelay on a job that is not delayed, or is not this queue's, changes nothing", async () => {
      const waiting = await f.queue('one').add('a', 1);
      await f.queue('one').changeJobDelay(waiting.id, 60_000);
      expect(await waiting.getState()).toBe('waiting');
      const later = await f.queue('one').add('a', 1, { delay: 60_000 });
      await f.queue('two').changeJobDelay(later.id, 0);
      expect(await later.getState()).toBe('delayed');
      await expect(f.queue('one').changeJobDelay(later.id, -1)).resolves.toBeUndefined();
      await expect(
        f.queue('one').changeJobDelay(later.id, 400 * 86_400_000)
      ).rejects.toBeInstanceOf(UnsupportedOptionError);
    });

    test('promote makes a delayed job due now and rings it', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1, { delay: 60_000 });
      await queue.promoteJob(job.id);
      expect(await job.getState()).toBe('waiting');
      expect(f.transport.buffered('q').ready).toBe(1);
      await f.queue('two').promoteJob('nope');
    });

    test('changePriority re-ranks a pending job; lifo and a bad priority are refused', async () => {
      const queue = f.queue();
      const job = await queue.add('a', 1);
      await job.changePriority({ priority: 5 });
      expect((await queue.getJob(job.id))!.priority).toBe(5);
      await expect(job.changePriority({ priority: 1, lifo: true })).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      await expect(queue.changeJobPriority(job.id, { priority: -1 })).rejects.toBeInstanceOf(
        UnsupportedOptionError
      );
      await f.queue('two').changeJobPriority(job.id, { priority: 9 });
      expect((await queue.getJob(job.id))!.priority).toBe(5);
    });
  });

  describe('removal', () => {
    test("remove deletes a pending job, resolves for a missing one, and leaves another queue's job", async () => {
      const job = await f.queue('one').add('a', 1);
      await f.queue('two').remove(job.id);
      expect(await f.queue('one').getJob(job.id)).not.toBeNull();
      await f.queue('one').removeAsync('nope');
      await job.remove();
      expect(await f.queue('one').getJob(job.id)).toBeNull();
    });

    test('remove rejects for an active job, which stays', async () => {
      const { id } = await active();
      const queue = f.queue();
      await expect(queue.remove(id)).rejects.toBeInstanceOf(JobStateError);
      expect(await queue.getJobState(id)).toBe('active');
    });
  });
});
