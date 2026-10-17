import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { UnsupportedOptionError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { createMsgpackCodec } from '../src/codec';
import type { EventCursor, JournalEvent } from '../src/store/journal';
import { JOURNAL_START, journalRecorder, MAX_EVENT_PAGE } from '../src/store/journal';
import { claimOne, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore, START } from './storeHelpers';

const recorder = journalRecorder({ namespace: 'test', codec: createMsgpackCodec() });

describeDb('event journal: recording and reading', () => {
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

  /** Everything after `cursor`, page by page, so the test sees what a follower would. */
  async function drain(from: EventCursor = JOURNAL_START, limit = 1000, queue?: string) {
    const events: JournalEvent[] = [];
    let cursor = from;
    for (;;) {
      const page = await t.store.events.read(cursor, { limit, ...(queue && { queue }) });
      expect(page.gap).toBe(false);
      events.push(...page.events);
      cursor = page.cursor;
      if (!page.more) return { events, cursor };
    }
  }

  test('every operation records its events in its own transaction, in operation order', async () => {
    const [a, b] = await enqueueN(t.store, 2, {}, 'q');
    const [job] = await t.store.claim('q', 'w', 1);
    await t.store.complete(job!.lease, 'ok');
    const { events } = await drain();
    expect(events.map((event) => [event.type, event.jobId, event.state])).toEqual([
      ['pushed', a!, 'waiting'],
      ['pushed', b!, 'waiting'],
      ['pulled', a!, 'active'],
      ['completed', a!, 'completed'],
    ]);
    expect(events.every((event) => event.queue === 'q' && event.occurredAt === START)).toBe(true);
  });

  test('a failure carries its message, and a removal says so', async () => {
    const job = await claimOne(t, { attempts: 1 });
    await t.store.fail(job.lease, { message: 'boom', unrecoverable: true });
    const { events } = await drain();
    expect(events.at(-1)).toMatchObject({ type: 'failed', state: 'failed', error: 'boom' });
  });

  test('events of a transaction that rolled back are never visible', async () => {
    const before = await t.store.events.baseline();
    await t.fresh.sql
      .begin(async (tx) => {
        await recorder.record(
          tx,
          [{ type: 'pushed', queue: 'q', jobId: 'ghost', state: 'waiting' }],
          START
        );
        throw new Error('rolled back');
      })
      .catch(() => {});
    expect(await drain(before)).toMatchObject({ events: [] });
    const [{ n }] = await t.fresh.sql<
      [{ n: number }]
    >`SELECT count(*)::int AS n FROM qcloud_events`;
    expect(n).toBe(0);
  });

  test('an operation that fails after recording leaves neither job nor event', async () => {
    const hooked = t.another({
      onTerminal: async () => {
        throw new Error('hook failed');
      },
    });
    const job = await claimOne(t);
    await expect(hooked.complete(job.lease, 'ok')).rejects.toThrow('hook failed');
    expect((await drain()).events.map((event) => event.type)).toEqual(['pushed', 'pulled']);
    expect(await t.store.getJob(job.id)).toMatchObject({ state: 'active' });
  });

  test('a recorder that throws rolls the whole operation back', async () => {
    const broken = t.another({
      recorder: {
        async record() {
          throw new Error('no journal');
        },
      },
    });
    await expect(broken.enqueue([{ queue: 'q', data: 1 }])).rejects.toThrow('no journal');
    expect(await t.store.counts('q')).toMatchObject({ waiting: 0 });
  });

  test('a reader follows commit order, not id order, when transactions commit out of order', async () => {
    const event = (jobId: string) => [
      { type: 'pushed' as const, queue: 'q', jobId, state: 'waiting' as const },
    ];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    // The first transaction takes the lower ids and commits last.
    const first = t.fresh.sql.begin(async (tx) => {
      await recorder.record(tx, event('first-a'), START);
      await recorder.record(tx, event('first-b'), START);
      firstInserted();
      await held;
    });
    await inserted;
    await t.fresh.sql.begin((tx) => recorder.record(tx, event('second'), START));

    const early = await drain();
    expect(early.events.map((e) => e.jobId)).toEqual(['second']);

    releaseFirst();
    await first;
    const late = await drain(early.cursor);
    expect(late.events.map((e) => e.jobId)).toEqual(['first-a', 'first-b']);
    // The ids run the other way: a reader that followed ids would have lost both.
    expect(late.events[0]!.id).toBeLessThan(early.events[0]!.id);
    expect((await drain()).events.map((e) => e.jobId)).toEqual(['second', 'first-a', 'first-b']);
  });

  test('pages split a commit and the cursor resumes exactly, with nothing repeated or skipped', async () => {
    const ids = await enqueueN(t.store, 7, {}, 'q');
    for (const limit of [1, 2, 3, 7, 8]) {
      const { events } = await drain(JOURNAL_START, limit);
      expect(events.map((event) => event.jobId)).toEqual(ids);
    }
    const page = await t.store.events.read(JOURNAL_START, { limit: 3 });
    expect(page).toMatchObject({ more: true, gap: false });
    expect(page.events).toHaveLength(3);
    const rest = await t.store.events.read(page.cursor, { limit: 100 });
    expect(rest.more).toBe(false);
    expect(rest.events.map((event) => event.jobId)).toEqual(ids.slice(3));
  });

  test('a cursor at the end gets an empty page and keeps its place', async () => {
    await enqueueN(t.store, 2, {}, 'q');
    const end = await t.store.events.baseline();
    const page = await t.store.events.read(end);
    expect(page).toEqual({ events: [], cursor: end, more: false, gap: false });
    await enqueueN(t.store, 1, {}, 'q');
    expect((await drain(end)).events).toHaveLength(1);
  });

  test('a reader may follow one queue', async () => {
    const a = await enqueueN(t.store, 2, {}, 'a');
    await enqueueN(t.store, 3, {}, 'b');
    expect((await drain(JOURNAL_START, 1000, 'a')).events.map((event) => event.jobId)).toEqual(a);
    expect((await drain(JOURNAL_START, 2, 'b')).events).toHaveLength(3);
  });

  test('journals are separate per namespace', async () => {
    const other = t.another({ namespace: 'other' });
    await enqueueN(t.store, 1, {}, 'q');
    await enqueueN(other, 2, {}, 'q');
    expect((await other.events.read(JOURNAL_START)).events).toHaveLength(2);
    expect((await drain()).events).toHaveLength(1);
  });

  test.each<[string, () => Promise<unknown>, string]>([
    [
      'a negative commit',
      () => t.store.events.read({ commitSeq: -1, eventId: 0 }),
      'cursor.commitSeq',
    ],
    [
      'a fractional event id',
      () => t.store.events.read({ commitSeq: 0, eventId: 1.5 }),
      'cursor.eventId',
    ],
    ['a limit of 0', () => t.store.events.read(JOURNAL_START, { limit: 0 }), 'limit'],
    [
      'a limit over the cap',
      () => t.store.events.read(JOURNAL_START, { limit: MAX_EVENT_PAGE + 1 }),
      'limit',
    ],
  ])('refuses %s', async (_label, run, mention) => {
    const error = (await run().catch((caught) => caught)) as Error;
    expect(error).toBeInstanceOf(UnsupportedOptionError);
    expect(error.message).toContain(mention);
  });
});
