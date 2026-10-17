import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { MAX_LOG_MESSAGE_CHARS } from '../src/store/logs';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const CAP = 5;

describeDb('job logs', () => {
  let t: TestStore;
  let store: ReturnType<TestStore['another']>;
  beforeAll(async () => {
    t = await openTestStore();
    store = t.another({ maxJobLogs: CAP });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
  });

  const job = async (queue = 'q') => (await enqueueN(store, 1, {}, queue))[0]!;
  const messages = async (id: string) => (await store.logs.list(id)).map((line) => line.message);

  test('lines come back oldest first with their level and the store clock', async () => {
    const id = await job();
    expect(await store.logs.add(id, 'one')).toBe(true);
    t.clock.advance(1_500);
    expect(await store.logs.add(id, 'two', 'warn')).toBe(true);
    expect(await store.logs.add(id, 'three', 'error')).toBe(true);
    expect(await store.logs.list(id)).toEqual([
      { timestamp: START, level: 'info', message: 'one' },
      { timestamp: START + 1_500, level: 'warn', message: 'two' },
      { timestamp: START + 1_500, level: 'error', message: 'three' },
    ]);
  });

  test('a job with no lines, or no job at all, lists nothing', async () => {
    expect(await store.logs.list(await job())).toEqual([]);
    expect(await store.logs.list('no-such-job')).toEqual([]);
  });

  test('a line for a job that does not exist is refused, not stored', async () => {
    expect(await store.logs.add('no-such-job', 'orphan')).toBe(false);
    const [{ n }] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_job_logs`;
    expect(n).toBe(0);
  });

  test('a job keeps its newest lines and loses the oldest past the cap', async () => {
    const id = await job();
    for (let i = 1; i <= CAP + 3; i++) await store.logs.add(id, `line ${i}`);
    expect(await messages(id)).toEqual(['line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
  });

  test('the cap is per job', async () => {
    const [a, b] = await enqueueN(store, 2);
    for (let i = 0; i < CAP + 2; i++) await store.logs.add(a!, `a${i}`);
    await store.logs.add(b!, 'b0');
    expect(await store.logs.list(a!)).toHaveLength(CAP);
    expect(await messages(b!)).toEqual(['b0']);
  });

  test('concurrent writers of one job cannot push it past the cap', async () => {
    const id = await job();
    const writers = [store, t.another({ maxJobLogs: CAP }), t.another({ maxJobLogs: CAP })];
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => writers[i % writers.length]!.logs.add(id, `c${i}`))
    );
    expect(await store.logs.list(id)).toHaveLength(CAP);
    const [{ n }] = await t.fresh.sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM qcloud_job_logs WHERE job_id = ${id}`;
    expect(n).toBe(CAP);
  });

  test('clear deletes all of a job’s lines and says how many', async () => {
    const [a, b] = await enqueueN(store, 2);
    for (let i = 0; i < 3; i++) await store.logs.add(a!, `a${i}`);
    await store.logs.add(b!, 'b');
    expect(await store.logs.clear(a!)).toBe(3);
    expect(await store.logs.list(a!)).toEqual([]);
    expect(await messages(b!)).toEqual(['b']);
    expect(await store.logs.clear(a!)).toBe(0);
  });

  test('clear can keep the newest lines', async () => {
    const id = await job();
    for (let i = 1; i <= 4; i++) await store.logs.add(id, `line ${i}`);
    expect(await store.logs.clear(id, 2)).toBe(2);
    expect(await messages(id)).toEqual(['line 3', 'line 4']);
    expect(await store.logs.clear(id, 10)).toBe(0);
  });

  test('the lines go with the job, and no line can be added once it is gone', async () => {
    const job = await claimOne(t, { removeOnComplete: true });
    await store.logs.add(job.id, 'while it ran');
    expect(await messages(job.id)).toEqual(['while it ran']);
    await t.store.complete(job.lease, 'ok');
    expect(await store.logs.list(job.id)).toEqual([]);
    expect(await store.logs.add(job.id, 'too late')).toBe(false);
  });

  test('a namespace does not see another’s lines', async () => {
    const other = t.another({ namespace: 'other' });
    const id = await job();
    await store.logs.add(id, 'mine');
    expect(await other.logs.list(id)).toEqual([]);
    expect(await other.logs.add(id, 'not yours')).toBe(false);
    expect(await other.logs.clear(id)).toBe(0);
    expect(await messages(id)).toEqual(['mine']);
  });

  test.each<[string, () => Promise<unknown>, string]>([
    ['an empty message', () => store.logs.add('j', ''), 'message'],
    ['a message with NUL', () => store.logs.add('j', 'a\0b'), 'message'],
    [
      'a message over the limit',
      () => store.logs.add('j', 'x'.repeat(MAX_LOG_MESSAGE_CHARS + 1)),
      'message',
    ],
    ['an unknown level', () => store.logs.add('j', 'm', 'debug' as never), 'level'],
    ['an empty job id', () => store.logs.add('', 'm'), 'jobId'],
    ['a negative keep', () => store.logs.clear('j', -1), 'keep'],
    ['a fractional keep', () => store.logs.clear('j', 1.5), 'keep'],
  ])('refuses %s', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
  });

  test('a message at the limit is kept whole', async () => {
    const id = await job();
    const longest = 'é'.repeat(MAX_LOG_MESSAGE_CHARS);
    expect(await store.logs.add(id, longest)).toBe(true);
    expect(await messages(id)).toEqual([longest]);
  });
});
