import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_THROUGHPUT_MINUTES } from '../src/store/throughput';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const MINUTE = 60_000;
/** `START` is not on a minute boundary in general; the points are. */
const START_MINUTE = Math.floor(START / MINUTE) * MINUTE;

describeDb('throughput reads', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  async function finish(outcome: 'complete' | 'fail', queue = 'q'): Promise<void> {
    const job = await claimOne(t, { attempts: 1 }, queue);
    if (outcome === 'complete') await t.store.complete(job.lease, 'ok');
    else await t.store.fail(job.lease, { message: 'boom', unrecoverable: true });
  }

  test('the totals of the namespace sum every queue, and are zero before anything finished', async () => {
    expect(await t.store.metrics.totals()).toEqual({ completed: 0, failed: 0 });
    await finish('complete', 'q');
    await finish('complete', 'other');
    await finish('fail', 'other');
    expect(await t.store.metrics.totals()).toEqual({ completed: 2, failed: 1 });
  });

  test('a queue that never finished a job reads as zeros, one point per minute', async () => {
    const result = await t.store.metrics.throughput('q', { minutes: 3 });
    expect(result).toEqual({
      queue: 'q',
      points: [
        { minute: START_MINUTE - 2 * MINUTE, completed: 0, failed: 0 },
        { minute: START_MINUTE - MINUTE, completed: 0, failed: 0 },
        { minute: START_MINUTE, completed: 0, failed: 0 },
      ],
      totals: { completed: 0, failed: 0 },
    });
  });

  test('completed and failed line up on the minute they finished, oldest first', async () => {
    await finish('complete');
    await finish('complete');
    t.clock.advance(2 * MINUTE);
    await finish('fail');
    await finish('complete');
    const { points, totals } = await t.store.metrics.throughput('q', { minutes: 4 });
    expect(
      points.map((point) => [point.minute - START_MINUTE, point.completed, point.failed])
    ).toEqual([
      [-MINUTE, 0, 0],
      [0, 2, 0],
      [MINUTE, 0, 0],
      [2 * MINUTE, 1, 1],
    ]);
    expect(totals).toEqual({ completed: 3, failed: 1 });
  });

  test('the default range is the last hour, ending at the store’s clock', async () => {
    await finish('complete');
    const { points } = await t.store.metrics.throughput('q');
    expect(points).toHaveLength(60);
    expect(points.at(-1)).toEqual({ minute: START_MINUTE, completed: 1, failed: 0 });
    expect(points[0]!.minute).toBe(START_MINUTE - 59 * MINUTE);
  });

  test('until picks the last minute, and a range that excludes the work shows zeros but the totals', async () => {
    await finish('complete');
    const earlier = await t.store.metrics.throughput('q', {
      minutes: 2,
      until: START - 5 * MINUTE,
    });
    expect(earlier.points.every((point) => point.completed === 0)).toBe(true);
    expect(earlier.points.at(-1)!.minute).toBe(Math.floor((START - 5 * MINUTE) / MINUTE) * MINUTE);
    expect(earlier.totals.completed).toBe(1);
    const later = await t.store.metrics.throughput('q', { minutes: 1, until: START + 10 * MINUTE });
    expect(later.points).toEqual([{ minute: START_MINUTE + 10 * MINUTE, completed: 0, failed: 0 }]);
  });

  test('queues are separate', async () => {
    await finish('complete', 'a');
    await finish('fail', 'b');
    expect((await t.store.metrics.throughput('a', { minutes: 1 })).points[0]).toMatchObject({
      completed: 1,
      failed: 0,
    });
    expect((await t.store.metrics.throughput('b', { minutes: 1 })).points[0]).toMatchObject({
      completed: 0,
      failed: 1,
    });
  });

  test('namespaces are separate', async () => {
    const other = t.another({ namespace: 'other' });
    await finish('complete');
    expect((await other.metrics.throughput('q', { minutes: 1 })).totals).toEqual({
      completed: 0,
      failed: 0,
    });
  });

  test('totals outlive the buckets: with no buckets kept the points are empty and the totals are not', async () => {
    const lean = t.another({ maxMetricBuckets: 0 });
    await enqueueN(lean, 2);
    const jobs = await lean.claim('q', 'w', 2);
    for (const job of jobs) await lean.complete(job.lease, 'ok');
    const { points, totals } = await lean.metrics.throughput('q', { minutes: 2 });
    expect(points.every((point) => point.completed === 0 && point.failed === 0)).toBe(true);
    expect(totals.completed).toBe(2);
  });

  test('buckets past the retention are gone from the series but counted in the totals', async () => {
    const short = t.another({ maxMetricBuckets: 2 });
    await enqueueN(short, 1);
    const [first] = await short.claim('q', 'w', 1);
    await short.complete(first!.lease, 'ok');
    t.clock.advance(5 * MINUTE);
    await enqueueN(short, 1);
    const [second] = await short.claim('q', 'w', 1);
    await short.complete(second!.lease, 'ok');
    const { points, totals } = await short.metrics.throughput('q', { minutes: 10 });
    expect(points.reduce((sum, point) => sum + point.completed, 0)).toBe(1);
    expect(points.at(-1)!.completed).toBe(1);
    expect(totals.completed).toBe(2);
  });

  test('the longest range is a bounded read', async () => {
    const { points } = await t.store.metrics.throughput('q', { minutes: MAX_THROUGHPUT_MINUTES });
    expect(points).toHaveLength(MAX_THROUGHPUT_MINUTES);
  });

  test.each<[string, () => Promise<unknown>, string]>([
    ['0 minutes', () => t.store.metrics.throughput('q', { minutes: 0 }), 'minutes'],
    [
      'too many minutes',
      () => t.store.metrics.throughput('q', { minutes: MAX_THROUGHPUT_MINUTES + 1 }),
      'minutes',
    ],
    ['fractional minutes', () => t.store.metrics.throughput('q', { minutes: 1.5 }), 'minutes'],
    ['a fractional until', () => t.store.metrics.throughput('q', { until: 1.5 }), 'until'],
    ['an empty queue name', () => t.store.metrics.throughput(''), 'queue'],
  ])('refuses %s', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
  });
});
