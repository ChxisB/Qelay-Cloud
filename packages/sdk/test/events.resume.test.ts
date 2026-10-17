import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { EventCursor } from '@qelay-cloud/store-postgres';
import { describeDb, testDatabaseUrl } from '../../../test/support/db';
import { QueueEvents } from '../src';
import type { QueueEventsOptions } from '../src';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';
import { pause, until } from './workerSupport';

const WRITERS = 4;
const PER_WRITER = 25;
const TOTAL = WRITERS * PER_WRITER;
const STOP_AFTER = 31;

describeDb('QueueEvents: resuming from a stored cursor', () => {
  let f: SdkFixture;
  const open: QueueEvents[] = [];
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
    await Promise.all(open.splice(0).map((reader) => reader.close()));
  });

  function reader(queue: string, extra: Partial<QueueEventsOptions>): QueueEvents {
    const events = new QueueEvents(queue, {
      databaseUrl: testDatabaseUrl(),
      database: { schema: f.fresh.name, poolSize: 2 },
      namespace: NAMESPACE,
      pollInterval: 10,
      batchSize: 7,
      ...extra,
    });
    open.push(events);
    return events;
  }

  /** Four writers each add `PER_WRITER` jobs one after another, so the writers' commits overlap in time. */
  async function write(queue: string): Promise<string[]> {
    const q = f.queue(queue);
    const ids = Array.from({ length: WRITERS }, (_, w) =>
      Array.from({ length: PER_WRITER }, (_, n) => `w${w}-${n}`)
    );
    await Promise.all(
      ids.map(async (mine) => {
        for (const id of mine) await q.add('x', {}, { jobId: id });
      })
    );
    return ids.flat();
  }

  test('a reader stopped mid-stream and a second one started from its cursor see every event once, in order', async () => {
    const first = reader('resume', { start: 'beginning' });
    const heardFirst: string[] = [];
    first.on('waiting', (event) => {
      heardFirst.push(event.jobId);
      if (heardFirst.length === STOP_AFTER) void first.close();
    });
    const writing = write('resume');
    await until('the first reader to stop', () => heardFirst.length === STOP_AFTER);
    await first.close();
    const written = await writing;
    // The cursor is stored the way a consumer stores it: as JSON, then read back.
    const stored = JSON.parse(JSON.stringify(first.cursor)) as EventCursor;
    const second = reader('resume', { start: stored });
    const heardSecond: string[] = [];
    second.on('waiting', (event) => void heardSecond.push(event.jobId));
    await until('the rest', () => heardFirst.length + heardSecond.length >= TOTAL);
    await pause(100);

    const all = [...heardFirst, ...heardSecond];
    expect(heardFirst).toHaveLength(STOP_AFTER);
    expect(all).toHaveLength(TOTAL);
    expect(new Set(all)).toEqual(new Set(written));
    // A writer that adds one job after another has its jobs journaled in that order.
    for (let w = 0; w < WRITERS; w += 1) {
      const mine = all
        .filter((id) => id.startsWith(`w${w}-`))
        .map((id) => Number(id.split('-')[1]));
      expect(mine).toEqual(Array.from({ length: PER_WRITER }, (_, n) => n));
    }
  });

  test('a reader resumed from a cursor reads the events written while it was away', async () => {
    const q = f.queue('away');
    const a = reader('away', { start: 'beginning' });
    const seenA: string[] = [];
    a.on('waiting', (event) => void seenA.push(event.jobId));
    await q.add('x', {}, { jobId: 'one' });
    await until('one', () => seenA.length === 1);
    await a.close();
    const cursor = a.cursor!;
    await q.add('x', {}, { jobId: 'two' });
    await q.add('x', {}, { jobId: 'three' });
    const b = reader('away', { start: cursor });
    const seenB: string[] = [];
    b.on('waiting', (event) => void seenB.push(event.jobId));
    await until('two and three', () => seenB.length === 2);
    expect(seenB).toEqual(['two', 'three']);
    expect(b.cursor!.commitSeq).toBeGreaterThan(cursor.commitSeq);
  });
});
