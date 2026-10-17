import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { DEFAULT_DLQ_MAX_AGE_MS, DEFAULT_DLQ_MAX_ENTRIES } from '../src/store/policies';
import { claimOne, configureQueue, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { openTestStore } from './storeHelpers';

const DEFAULTS = {
  paused: false,
  rateLimit: null,
  concurrencyLimit: null,
  stall: { maxStalls: 3 },
  dlq: { maxEntries: DEFAULT_DLQ_MAX_ENTRIES, maxAge: DEFAULT_DLQ_MAX_AGE_MS },
};

describeDb('queue configuration: read and patch', () => {
  const log = recording();
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({ recorder: log.recorder, leaseMs: 30_000 });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
  });

  async function fillDlq(queue: string) {
    t.clock.advance(1_000);
    const job = await claimOne(t, { attempts: 1 }, queue);
    await t.store.fail(job.lease, { message: 'x', unrecoverable: false });
    return job.id;
  }

  test('a queue never used has the defaults, and reading it creates nothing', async () => {
    expect(await t.store.queues.config('fresh')).toEqual({ queue: 'fresh', ...DEFAULTS });
    const rows = await t.fresh.sql`SELECT 1 FROM qcloud_queue_state WHERE queue = 'fresh'`;
    expect(rows).toHaveLength(0);
  });

  test('the read puts together pause, both limits and the two settings', async () => {
    await t.store.pause('q');
    await t.store.setRateLimit('q', { max: 5, durationMs: 2_000 });
    await t.store.setConcurrencyLimit('q', 3);
    await t.store.queues.setStallConfig('q', { maxStalls: 7 });
    await t.store.queues.setDlqConfig('q', { maxEntries: 50, maxAge: 60_000 });
    expect(await t.store.queues.config('q')).toEqual({
      queue: 'q',
      paused: true,
      rateLimit: { max: 5, durationMs: 2_000, expiresAt: null },
      concurrencyLimit: 3,
      stall: { maxStalls: 7 },
      dlq: { maxEntries: 50, maxAge: 60_000 },
    });
  });

  test('a rate limit past its expiry reads as none', async () => {
    await t.store.setRateLimit('q', {
      max: 5,
      durationMs: 1_000,
      ttlMs: 5_000,
    });
    expect((await t.store.queues.config('q')).rateLimit).toMatchObject({ max: 5 });
    t.clock.advance(5_000);
    expect((await t.store.queues.config('q')).rateLimit).toBeNull();
  });

  test('a setter returns the whole configuration it produced', async () => {
    await t.store.pause('q');
    expect(await t.store.queues.setStallConfig('q', { maxStalls: 0 })).toEqual({
      queue: 'q',
      ...DEFAULTS,
      paused: true,
      stall: { maxStalls: 0 },
    });
  });

  test('a patch writes only the keys it is given', async () => {
    await t.store.queues.setDlqConfig('q', { maxEntries: 20, maxAge: 5_000 });
    expect((await t.store.queues.setDlqConfig('q', { maxEntries: 30 })).dlq).toEqual({
      maxEntries: 30,
      maxAge: 5_000,
    });
    expect((await t.store.queues.setDlqConfig('q', { maxAge: null })).dlq).toEqual({
      maxEntries: 30,
      maxAge: null,
    });
    // An undefined key is not set.
    expect((await t.store.queues.setDlqConfig('q', { maxEntries: undefined })).dlq).toEqual({
      maxEntries: 30,
      maxAge: null,
    });
  });

  test('an empty patch changes nothing', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 9 });
    expect((await t.store.queues.setStallConfig('q', {})).stall).toEqual({ maxStalls: 9 });
    expect((await t.store.queues.setDlqConfig('q', {})).dlq).toEqual(DEFAULTS.dlq);
  });

  test('the stall and DLQ settings do not disturb each other, or pause and the limits', async () => {
    await t.store.setConcurrencyLimit('q', 2);
    await t.store.queues.setStallConfig('q', { maxStalls: 1 });
    await t.store.queues.setDlqConfig('q', { maxEntries: 4 });
    const config = await t.store.queues.config('q');
    expect(config).toMatchObject({
      concurrencyLimit: 2,
      stall: { maxStalls: 1 },
      dlq: { maxEntries: 4, maxAge: DEFAULT_DLQ_MAX_AGE_MS },
    });
  });

  test('keys the store does not read are kept when a patch is laid over them', async () => {
    await configureQueue(t, 'q', { dlq: { maxEntries: 5, maxAge: 1_000, autoRetry: { max: 3 } } });
    await t.store.queues.setDlqConfig('q', { maxEntries: 6 });
    const [row] = await t.fresh.sql<{ dlq_config: Uint8Array }[]>`
      SELECT dlq_config FROM qcloud_queue_state WHERE namespace = 'test' AND queue = 'q'`;
    expect(new TextDecoder().decode(row!.dlq_config)).toContain('autoRetry');
    expect((await t.store.queues.config('q')).dlq).toEqual({ maxEntries: 6, maxAge: 1_000 });
  });

  test('a corrupt stored value reads as its default, and a patch of another key leaves it alone', async () => {
    await configureQueue(t, 'q', { dlq: { maxEntries: 'lots', maxAge: 'long' } });
    expect((await t.store.queues.config('q')).dlq).toEqual(DEFAULTS.dlq);
    expect((await t.store.queues.setDlqConfig('q', { maxEntries: 8 })).dlq).toEqual({
      maxEntries: 8,
      maxAge: DEFAULT_DLQ_MAX_AGE_MS,
    });
  });

  test.each<[string, () => Promise<unknown>, string]>([
    [
      'a negative maxStalls',
      () => t.store.queues.setStallConfig('q', { maxStalls: -1 }),
      'stall.maxStalls',
    ],
    [
      'a fractional maxStalls',
      () => t.store.queues.setStallConfig('q', { maxStalls: 1.5 }),
      'stall.maxStalls',
    ],
    [
      'a text maxStalls',
      () => t.store.queues.setStallConfig('q', { maxStalls: '2' as never }),
      'stall.maxStalls',
    ],
    [
      'an unknown stall key',
      () => t.store.queues.setStallConfig('q', { enabled: true } as never),
      'stall.enabled',
    ],
    [
      'a maxEntries of 0',
      () => t.store.queues.setDlqConfig('q', { maxEntries: 0 }),
      'dlq.maxEntries',
    ],
    [
      'a fractional maxEntries',
      () => t.store.queues.setDlqConfig('q', { maxEntries: 2.5 }),
      'dlq.maxEntries',
    ],
    ['a maxAge of 0', () => t.store.queues.setDlqConfig('q', { maxAge: 0 }), 'dlq.maxAge'],
    [
      'a text maxAge',
      () => t.store.queues.setDlqConfig('q', { maxAge: 'week' as never }),
      'dlq.maxAge',
    ],
    [
      'autoRetry',
      () => t.store.queues.setDlqConfig('q', { autoRetry: {} } as never),
      'dlq.autoRetry',
    ],
    ['a patch that is not an object', () => t.store.queues.setDlqConfig('q', null as never), 'dlq'],
    ['a blank queue name', () => t.store.queues.setDlqConfig('', { maxEntries: 1 }), 'queue'],
  ])('refuses %s, and writes nothing', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
    const rows = await t.fresh.sql`SELECT stall_config, dlq_config FROM qcloud_queue_state`;
    expect(
      rows.every(
        (row: Record<string, unknown>) => row.stall_config === null && row.dlq_config === null
      )
    ).toBe(true);
  });

  test('lowering maxEntries trims the DLQ at once, oldest first, and journals each removal', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await fillDlq('q'));
    log.events.length = 0;
    await t.store.queues.setDlqConfig('q', { maxEntries: 2 });
    expect((await t.store.listDlq('q')).map((entry) => entry.jobId)).toEqual(ids.slice(3));
    expect(await readJob(t, ids[0]!)).toBeUndefined();
    expect(
      log.events.filter((event) => event.type === 'removed').map((event) => event.jobId)
    ).toEqual(ids.slice(0, 3));
  });

  test('raising maxEntries or changing maxAge deletes nothing', async () => {
    for (let n = 0; n < 3; n++) await fillDlq('q');
    await t.store.queues.setDlqConfig('q', { maxEntries: 2 });
    await t.store.queues.setDlqConfig('q', { maxEntries: 100, maxAge: 1 });
    expect(await t.store.listDlq('q')).toHaveLength(2);
  });

  test('a new maxAge applies to entries already there, at the next purge', async () => {
    await fillDlq('q');
    await t.store.queues.setDlqConfig('q', { maxAge: 10_000 });
    t.clock.advance(10_000);
    expect(await t.store.purgeExpiredDlq(100)).toBe(1);
  });

  test('a new stall limit applies to the next recovery', async () => {
    await t.store.queues.setStallConfig('q', { maxStalls: 1 });
    const job = await claimOne(t, { attempts: 5, backoff: 0 });
    t.clock.advance(60_000);
    await t.store.recoverExpired();
    expect((await readJob(t, job.id))!.state).toBe('failed');
  });

  test('configuration is per queue and per namespace', async () => {
    const other = t.another({ namespace: 'other' });
    await t.store.queues.setStallConfig('q', { maxStalls: 1 });
    expect((await t.store.queues.config('r')).stall.maxStalls).toBe(3);
    expect((await other.queues.config('q')).stall.maxStalls).toBe(3);
  });

  test('concurrent patches of different keys both land', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        n % 2 === 0
          ? t.store.queues.setDlqConfig('q', { maxEntries: 10 + n })
          : t.store.queues.setDlqConfig('q', { maxAge: 1_000 * (n + 1) })
      )
    );
    const { dlq } = await t.store.queues.config('q');
    expect(dlq.maxEntries).toBeGreaterThanOrEqual(10);
    expect(dlq.maxAge).toBeLessThan(DEFAULT_DLQ_MAX_AGE_MS);
  });
});
