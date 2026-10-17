import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { PostgresStore } from '@qelay-cloud/store-postgres';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { QueueEvents } from '../src';
import type { QueueEventsOptions } from '../src';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, recorded, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

const NAMES = [
  'waiting',
  'active',
  'completed',
  'failed',
  'progress',
  'stalled',
  'removed',
  'delayed',
  'duplicated',
  'waiting-children',
  'obliterated',
] as const;

describeDb('QueueEvents: the journal as events', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
  const readers: QueueEvents[] = [];
  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
  });
  afterEach(async () => {
    await kit.closeAll();
    await Promise.all(readers.splice(0).map((reader) => reader.close()));
  });

  function reader(queue: string, extra: Partial<QueueEventsOptions> = {}): QueueEvents {
    const own: Partial<QueueEventsOptions> =
      extra.store === undefined
        ? {
            databaseUrl: testDatabaseUrl(),
            database: { schema: f.fresh.name, poolSize: 2 },
            namespace: NAMESPACE,
          }
        : {};
    const events = new QueueEvents(queue, { pollInterval: 20, ...own, ...extra });
    readers.push(events);
    return events;
  }

  /** Everything a reader emits, as `name:jobId` strings, in order. */
  function listen(events: QueueEvents): string[] {
    const heard: string[] = [];
    for (const name of NAMES) {
      events.on(
        name,
        ((event: { jobId?: string; queue?: string }) =>
          void heard.push(`${name}:${event.jobId ?? event.queue}`)) as never
      );
    }
    return heard;
  }

  test('a job through add, claim, progress and completion is waiting, active, progress, completed', async () => {
    const queue = f.queue('life');
    const events = reader('life');
    const heard = listen(events);
    const progress: unknown[] = [];
    events.on('progress', (event) => progress.push(event));
    await events.waitUntilReady();
    kit.worker('life', async (job) => {
      await job.updateProgress(40);
      return 'ok';
    });
    await queue.add('x', {}, { jobId: 'j' });
    await until('completed', () => heard.includes('completed:j'));
    expect(heard).toEqual(['waiting:j', 'active:j', 'progress:j', 'completed:j']);
    expect(progress).toEqual([{ jobId: 'j', data: 40 }]);
  });

  test('a failed attempt with a retry pending is a non-terminal failed, and the last one is terminal', async () => {
    const queue = f.queue('fail');
    const events = reader('fail');
    const failures: unknown[] = [];
    events.on('failed', (event) => failures.push(event));
    await events.waitUntilReady();
    kit.worker('fail', () => {
      throw new Error('nope');
    });
    await queue.add('x', {}, { jobId: 'j', attempts: 2, backoff: { type: 'fixed', delay: 50 } });
    await until('two failures', () => failures.length === 2);
    expect(failures).toEqual([
      { jobId: 'j', failedReason: 'nope', terminal: false },
      { jobId: 'j', failedReason: 'nope', terminal: true },
    ]);
  });

  test('delayed, removed, stalled and duplicated jobs are named as Qelay names them', async () => {
    const queue = f.queue('misc');
    const events = reader('misc');
    const heard = listen(events);
    const removed: unknown[] = [];
    events.on('removed', (event) => removed.push(event));
    await events.waitUntilReady();
    await queue.add('x', {}, { jobId: 'later', delay: 60_000 });
    await queue.add('x', {}, { jobId: 'gone' });
    await (await queue.getJob('gone'))!.remove();
    await queue.add('x', {}, { jobId: 'held', attempts: 2 });
    await queue.add('x', {}, { jobId: 'held' });
    await queue.add('x', {}, { jobId: 'spent' });
    const failures: unknown[] = [];
    events.on('failed', (event) => failures.push(event));
    await f.store.claim('misc', 'dead-worker', 2);
    await f.fresh.sql`UPDATE qcloud_jobs SET lease_until = 1 WHERE state = 'active'`;
    await f.store.recoverExpired();
    await until('the stall', () => heard.includes('stalled:held') && failures.length === 1);
    // A stall with attempts left is `stalled`; one that used the last attempt is a terminal `failed`.
    expect(failures).toEqual([
      { jobId: 'spent', failedReason: 'Job lease expired', terminal: true },
    ]);
    expect(heard).toContain('delayed:later');
    expect(heard).toContain('duplicated:held');
    expect(heard).toContain('waiting:gone');
    expect(removed).toEqual([{ jobId: 'gone', prev: 'waiting' }]);
  });

  test('only the queue asked for is streamed', async () => {
    const events = reader('mine');
    const heard = listen(events);
    await events.waitUntilReady();
    await f.queue('theirs').add('x', {}, { jobId: 'other' });
    await f.queue('mine').add('x', {}, { jobId: 'own' });
    await until('own', () => heard.length > 0);
    await pause(100);
    expect(heard).toEqual(['waiting:own']);
  });

  test("start 'now' sees nothing from before, and 'beginning' sees everything the journal holds", async () => {
    const queue = f.queue('start');
    await queue.add('x', {}, { jobId: 'old' });
    const now = reader('start');
    const fromNow = listen(now);
    await now.waitUntilReady();
    const all = reader('start', { start: 'beginning' });
    const fromStart = listen(all);
    await queue.add('x', {}, { jobId: 'new' });
    await until('both read new', () => fromNow.length === 1 && fromStart.length === 2);
    expect(fromNow).toEqual(['waiting:new']);
    expect(fromStart).toEqual(['waiting:old', 'waiting:new']);
  });

  test('a listener that throws neither stops the stream nor reaches the caller', async () => {
    const { logger, warnings } = recorded();
    const events = reader('throws', { logger });
    const heard: string[] = [];
    events.on('waiting', () => {
      throw new Error('listener bug');
    });
    events.on('waiting', (event) => void heard.push(event.jobId));
    await events.waitUntilReady();
    await f.queue('throws').add('x', {}, { jobId: 'a' });
    await f.queue('throws').add('x', {}, { jobId: 'b' });
    await until('both', () => heard.length === 2);
    expect(warnings.some((warning) => warning.includes('listener threw'))).toBe(true);
  });

  test('a database that cannot be reached is an error event and a rejected waitUntilReady, and the reader keeps trying', async () => {
    const events = new QueueEvents('down', {
      databaseUrl: 'postgres://qcloud:qcloud@127.0.0.1:1/none',
      pollInterval: 20,
    });
    readers.push(events);
    const errors: Error[] = [];
    events.on('error', (error) => errors.push(error));
    await expect(events.waitUntilReady()).rejects.toBeInstanceOf(Error);
    await until('a second attempt', () => errors.length >= 2, 6000);
    await events.close();
  });

  test('a borrowed store is left open, close is idempotent and a closed reader emits nothing', async () => {
    const events = reader('borrowed', { store: f.store });
    const heard = listen(events);
    await events.waitUntilReady();
    const first = events.close();
    expect(events.disconnect()).toBe(first);
    await first;
    await f.queue('borrowed').add('x', {}, { jobId: 'after' });
    await pause(100);
    expect(heard).toEqual([]);
    expect(await f.store.counts('borrowed')).toMatchObject({ waiting: 1 });
  });

  test('a store that deleted unread events makes the reader emit gap and go on from what is left', async () => {
    const capped = new PostgresStore({ db: f.fresh.db, namespace: NAMESPACE, maxQueueEvents: 5 });
    const queue = f.queue('gap', { store: capped });
    for (let n = 0; n < 20; n += 1) await queue.add('x', { n }, { jobId: `j${n}` });
    await capped.events.trim();
    const events = reader('gap', { store: capped, start: 'beginning' });
    const heard = listen(events);
    let gaps = 0;
    events.on('gap', () => (gaps += 1));
    await until('the gap', () => gaps === 1);
    await queue.add('x', {}, { jobId: 'live' });
    await until('the live event', () => heard.includes('waiting:live'));
    expect(gaps).toBe(1);
    expect(heard.filter((entry) => entry.startsWith('waiting:j')).length).toBeLessThanOrEqual(5);
  });

  test('options are checked before anything opens', () => {
    const open = (extra: Record<string, unknown>) => () =>
      new QueueEvents('q', { databaseUrl: 'postgres://x/y', autorun: false, ...extra });
    expect(open({ start: 'yesterday' })).toThrow(UnsupportedOptionError);
    expect(open({ start: { commitSeq: -1, eventId: 0 } })).toThrow(UnsupportedOptionError);
    expect(open({ pollInterval: 0 })).toThrow(UnsupportedOptionError);
    expect(open({ batchSize: 5001 })).toThrow(UnsupportedOptionError);
    expect(open({ host: 'x' })).toThrow(UnsupportedOptionError);
    expect(() => new QueueEvents('', { databaseUrl: 'postgres://x/y' })).toThrow(
      UnsupportedOptionError
    );
    expect(() => new QueueEvents('q', {})).toThrow(UnsupportedOptionError);
  });
});
