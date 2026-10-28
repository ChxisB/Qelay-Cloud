import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';

describeDb('queue: retrying the dead-letter queue', () => {
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

  /** Fails `count` jobs of `queue` for good, one after another, and returns their ids oldest first. */
  async function fail(count: number, queue = 'q'): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      ids.push((await f.queue(queue).add('n', n)).id);
      const [claimed] = await f.store.claim(queue, 'w', 1);
      await f.store.fail(claimed!.lease, { message: `no ${n}`, unrecoverable: true });
    }
    return ids;
  }

  test('a retried job leaves the DLQ, is waiting with a bell, and a worker can finish it', async () => {
    const [id] = await fail(1);
    const queue = f.queue();
    expect(await queue.retryDlq(id!)).toEqual({ ok: true });
    expect(await queue.getDlq()).toEqual([]);
    const job = await queue.getJob(id!);
    expect(await job?.getState()).toBe('waiting');
    const [claimed] = await f.store.claim('q', 'w', 1);
    expect(claimed).toMatchObject({ id, attempts: 0 });
  });

  test('a refusal is an answer, not an error, and changes nothing', async () => {
    const [id] = await fail(1);
    const queue = f.queue();
    expect(await queue.retryDlq('missing')).toEqual({ ok: false, reason: 'not_found' });
    expect(await queue.retryDlq(id!, { expectedVersion: 0 })).toEqual({
      ok: false,
      reason: 'version',
    });
    expect((await queue.getDlq()).map((entry) => entry.jobId)).toEqual([id!]);
    expect(await f.queue('other').retryDlq(id!)).toEqual({ ok: false, reason: 'not_found' });
  });

  test('retryDlqMany takes the oldest first, stops at the limit and reports what is left', async () => {
    const ids = await fail(5);
    const queue = f.queue();
    expect(await queue.retryDlqMany({ limit: 2 })).toEqual({
      retried: ids.slice(0, 2),
      remaining: 3,
    });
    expect(await queue.retryDlqMany({ limit: 500 })).toEqual({
      retried: ids.slice(2),
      remaining: 0,
    });
    expect(await queue.retryDlqMany({ limit: 500 })).toEqual({ retried: [], remaining: 0 });
  });

  test('retryDlqMany checks its limit', async () => {
    await expect(f.queue().retryDlqMany({ limit: 501 })).rejects.toBeInstanceOf(
      UnsupportedOptionError
    );
  });
});
