import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { DEFAULT_DLQ_MAX_AGE_MS } from '../src/store/policies';
import { claimOne, configureQueue, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore, START } from './storeHelpers';

const DAY = 86_400_000;

describeDb('dlq: limit, page, stats, purge and age', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000, poolSize: 8 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  /** Fails one new job of the queue for good, one second after the last; returns its id. */
  async function fillDlq(
    queue: string,
    reason: 'explicit_fail' | 'max_attempts_exceeded' = 'max_attempts_exceeded'
  ) {
    t.clock.advance(1_000);
    const job = await claimOne(t, { attempts: 1 }, queue);
    await t.store.fail(job.lease, { message: 'x', unrecoverable: reason === 'explicit_fail' });
    return job.id;
  }

  test('a queue with no configuration keeps up to 10,000 entries', async () => {
    const ids = [await fillDlq('q'), await fillDlq('q')];
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual(ids);
  });

  test('over maxEntries the oldest failures are deleted, in the transaction that added the newest', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 3 });
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await fillDlq('q'));
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual(ids.slice(2));
    expect(await readJob(t, ids[0]!)).toBeUndefined();
  });

  test('an evicted entry is journaled as removed from failed', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 1 });
    const first = await fillDlq('q');
    log.events.length = 0;
    await fillDlq('q');
    expect(log.events.filter((event) => event.type === 'removed')).toEqual([
      {
        type: 'removed',
        queue: 'q',
        jobId: first,
        state: 'failed',
        error: 'DLQ limit reached',
        removed: true,
      },
    ]);
  });

  test('the limit is per queue', async () => {
    await t.store.queues.setDlqConfig('a', { maxEntries: 1 });
    await fillDlq('a');
    await fillDlq('a');
    await fillDlq('b');
    await fillDlq('b');
    expect(await t.store.listDlq('a')).toHaveLength(1);
    expect(await t.store.listDlq('b')).toHaveLength(2);
  });

  test('a limit below 1 or not a number is the default', async () => {
    await configureQueue(t, 'q', { dlq: { maxEntries: 0 } });
    await fillDlq('q');
    await fillDlq('q');
    expect(await t.store.listDlq('q')).toHaveLength(2);
  });

  test('a burst of concurrent last failures may overshoot the limit by the burst, and the next failure trims it back', async () => {
    // Each failure counts the rows committed when it runs, so transactions that overlap do not see
    // one another's entries. Every failure trims, so the overshoot cannot grow past one burst.
    await t.store.queues.setDlqConfig('q', { maxEntries: 3 });
    const jobs = [];
    for (let n = 0; n < 6; n++) jobs.push(await claimOne(t, { attempts: 1 }));
    await Promise.all(
      jobs.map((job) => t.store.fail(job.lease, { message: 'x', unrecoverable: false }))
    );
    expect((await t.store.listDlq('q')).length).toBeLessThanOrEqual(6);
    await fillDlq('q');
    expect(await t.store.listDlq('q')).toHaveLength(3);
  });

  test('listDlqPage pages through the entries, oldest failure first, with the total', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await fillDlq('q'));
    const first = await t.store.listDlqPage('q', { limit: 2 });
    expect(first.total).toBe(5);
    expect(first.items.map((entry) => entry.jobId)).toEqual(ids.slice(0, 2));
    const last = await t.store.listDlqPage('q', { limit: 2, offset: 4 });
    expect(last.items.map((entry) => entry.jobId)).toEqual(ids.slice(4));
    expect((await t.store.listDlqPage('q', { limit: 2, offset: 50 })).items).toEqual([]);
    expect(await t.store.listDlqPage('empty', { limit: 5 })).toEqual({ items: [], total: 0 });
  });

  test('dlqStats counts the entries, their span and the reasons', async () => {
    await fillDlq('q');
    await fillDlq('q', 'explicit_fail');
    await fillDlq('q', 'explicit_fail');
    const stats = await t.store.dlqStats('q');
    expect(stats).toEqual({
      total: 3,
      oldestFailedAt: START + 1_000,
      newestFailedAt: START + 3_000,
      byReason: { max_attempts_exceeded: 1, explicit_fail: 2 },
    });
    expect(await t.store.dlqStats('empty')).toEqual({
      total: 0,
      oldestFailedAt: null,
      newestFailedAt: null,
      byReason: {},
    });
  });

  test('purgeDlq deletes the named entries of the queue, and ignores the rest', async () => {
    const [a, b, c] = [await fillDlq('q'), await fillDlq('q'), await fillDlq('q')];
    const other = await fillDlq('other');
    log.events.length = 0;
    expect(await t.store.purgeDlq('q', [a, other, 'no-such-job', a])).toBe(1);
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual([b, c]);
    expect(await t.store.listDlq('other')).toHaveLength(1);
    expect(log.events).toEqual([
      {
        type: 'removed',
        queue: 'q',
        jobId: a,
        state: 'failed',
        error: 'purged from the DLQ',
        removed: true,
      },
    ]);
  });

  test('purgeDlq with no ids empties the queue only', async () => {
    await fillDlq('q');
    await fillDlq('q');
    await fillDlq('other');
    expect(await t.store.purgeDlq('q')).toBe(2);
    expect(await t.store.listDlq('q')).toEqual([]);
    expect(await t.store.listDlq('other')).toHaveLength(1);
    expect(await t.store.purgeDlq('q', [])).toBe(0);
  });

  test('purgeDlq never touches a job that is not failed', async () => {
    const live = await claimOne(t, { attempts: 1 });
    expect(await t.store.purgeDlq('q', [live.id])).toBe(0);
    expect((await readJob(t, live.id))!.state).toBe('active');
  });

  test('entries older than the queue maxAge are purged, newer ones kept', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 100, maxAge: 5_000 });
    const old = await fillDlq('q');
    t.clock.advance(4_000);
    const fresh = await fillDlq('q');
    t.clock.advance(1_000);
    // old failed 5,000 ms ago (at the boundary: purged), fresh 1,000 ms ago.
    expect(await t.store.purgeExpiredDlq(100)).toBe(1);
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual([fresh]);
    expect(await readJob(t, old)).toBeUndefined();
  });

  test('a queue with no configuration keeps entries for seven days', async () => {
    const id = await fillDlq('q');
    t.clock.advance(DEFAULT_DLQ_MAX_AGE_MS - 1);
    expect(await t.store.purgeExpiredDlq(100)).toBe(0);
    t.clock.advance(1);
    expect(await t.store.purgeExpiredDlq(100)).toBe(1);
    expect(await readJob(t, id)).toBeUndefined();
  });

  test('a maxAge of null keeps entries for ever', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 100, maxAge: null });
    await fillDlq('q');
    t.clock.advance(400 * DAY);
    expect(await t.store.purgeExpiredDlq(100)).toBe(0);
    expect(await t.store.listDlq('q')).toHaveLength(1);
  });

  test('purgeExpiredDlq stops at its limit and the next pass continues', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 100, maxAge: 1_000 });
    for (let n = 0; n < 5; n++) await fillDlq('q');
    t.clock.advance(10_000);
    expect(await t.store.purgeExpiredDlq(3)).toBe(3);
    expect(await t.store.purgeExpiredDlq(3)).toBe(2);
    expect(await t.store.purgeExpiredDlq(3)).toBe(0);
  });

  test('a queue name that is not a valid identifier is refused', async () => {
    await expect(t.store.purgeDlq('')).rejects.toThrow();
  });
});
