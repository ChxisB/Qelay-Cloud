import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeDb } from '../../../test/support/db';
import type { StoreEvent } from '../src/store/events';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind, START } from './storeHelpers';

interface Call {
  events: readonly StoreEvent[];
  now: number;
}

describeDb('enqueue: event recorder', () => {
  let t: TestStore;
  let calls: Call[];
  let failWith: Error | null;
  let store: ReturnType<TestStore['another']>;
  beforeAll(async () => {
    t = await openTestStore();
    store = t.another({
      recorder: {
        async record(tx, events, now) {
          calls.push({ events, now });
          // The transaction is live: a write made here commits or rolls back with the enqueue.
          await tx`INSERT INTO qcloud_job_logs (namespace, job_id, timestamp, level, message)
                   VALUES ('test', ${events[0]?.jobId ?? 'none'}, ${now}, 'info', 'recorded')`;
          if (failWith) throw failWith;
        },
      },
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_job_logs, qcloud_queue_state`;
    calls = [];
    failWith = null;
    rewind(t);
  });

  const logged = async () =>
    (await t.fresh.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_job_logs`)[0]!.n;
  const jobs = async () =>
    (await t.fresh.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM qcloud_jobs`)[0]!.n;

  test('is called once per enqueue with an event per created job, and the database time', async () => {
    t.clock.advance(42);
    const results = await store.enqueue([
      { queue: 'a', data: 1 },
      { queue: 'b', data: 2, options: { priority: 1 } },
      { queue: 'a', data: 3, options: { delay: 100 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.now).toBe(START + 42);
    expect(calls[0]!.events).toEqual([
      { type: 'pushed', queue: 'a', jobId: results[0]!.id, state: 'waiting' },
      { type: 'pushed', queue: 'b', jobId: results[1]!.id, state: 'prioritized' },
      { type: 'pushed', queue: 'a', jobId: results[2]!.id, state: 'delayed' },
    ]);
  });

  test('reports a duplicate, a release and a replace as what they are', async () => {
    const [held] = await store.enqueue([
      { queue: 'q', data: 1, options: { jobId: 'a', deduplication: { id: 'k', ttl: 100 } } },
    ]);
    calls = [];
    t.clock.advance(100);
    await store.enqueue([
      { queue: 'q', data: 1, options: { jobId: 'a' } },
      { queue: 'q', data: 2, options: { deduplication: { id: 'k' } } },
    ]);
    expect(calls[0]!.events.map((e) => [e.type, e.jobId === held!.id])).toEqual([
      ['duplicated', true],
      ['updated', true],
      ['pushed', false],
    ]);
    calls = [];
    const [kept] = await store.enqueue([
      { queue: 'q', data: 3, options: { deduplication: { id: 'k' } } },
    ]);
    expect(kept!.created).toBe(false);
    calls = [];
    await store.enqueue([
      { queue: 'q', data: 4, options: { deduplication: { id: 'k', replace: true } } },
    ]);
    expect(calls[0]!.events.map((e) => e.type)).toEqual(['removed', 'pushed']);
  });

  test('is not called for an empty batch or for input that fails validation', async () => {
    await store.enqueue([]);
    await store.enqueue([{ queue: '', data: 1 }]).catch(() => undefined);
    expect(calls).toEqual([]);
  });

  test('is not called for a refused group, and is called for an all-duplicate batch', async () => {
    await store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'x' } }]);
    calls = [];
    await store.enqueue([{ queue: 'q', data: 1, options: { jobId: 'x' } }]);
    expect(calls[0]!.events.map((e) => e.type)).toEqual(['duplicated']);
    calls = [];
    await store
      .enqueue([
        { queue: 'q', data: 1, options: { group: { id: 'g', maxSize: 1 } } },
        { queue: 'q', data: 2, options: { group: { id: 'g', maxSize: 1 } } },
      ])
      .catch(() => undefined);
    expect(calls).toEqual([]);
  });

  test('a write the recorder makes commits with the enqueue', async () => {
    await store.enqueue([{ queue: 'q', data: 1 }]);
    expect(await logged()).toBe(1);
    expect(await jobs()).toBe(1);
  });

  test('a recorder that throws rolls the whole enqueue back, and its own write with it', async () => {
    failWith = new Error('journal is down');
    const error = await store
      .enqueue([
        { queue: 'q', data: 1, options: { deduplication: { id: 'k' } } },
        { queue: 'q', data: 2 },
      ])
      .catch((caught) => caught);
    expect(error).toBe(failWith);
    expect(calls).toHaveLength(1);
    expect(await jobs()).toBe(0);
    expect(await logged()).toBe(0);
    const queues = await t.fresh.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM qcloud_queue_state`;
    expect(queues[0]!.n).toBe(0);

    // The locks went with the transaction: the same key is admitted at once.
    failWith = null;
    const [again] = await store.enqueue([
      { queue: 'q', data: 1, options: { deduplication: { id: 'k' } } },
    ]);
    expect(again!.created).toBe(true);
  });

  test('a replace that is rolled back leaves the replaced job in place', async () => {
    const [old] = await store.enqueue([
      { queue: 'q', data: 'old', options: { deduplication: { id: 'k' } } },
    ]);
    failWith = new Error('nope');
    await store
      .enqueue([
        { queue: 'q', data: 'new', options: { deduplication: { id: 'k', replace: true } } },
      ])
      .catch(() => undefined);
    expect((await t.store.getJob(old!.id))!.data).toBe('old');
    expect(await jobs()).toBe(1);
  });
});

describeDb('enqueue: ported code carries no broker identifier', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });

  test('no table or column of the schema is named for a broker', async () => {
    const found = await t.fresh.sql<Array<{ name: string }>>`
      SELECT table_name || '.' || column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (table_name ILIKE '%broker%' OR column_name ILIKE '%broker%')`;
    expect(found).toEqual([]);
  });
});

describe('enqueue: ported code carries no broker identifier (source)', () => {
  /** Code with its comments and string literals removed: what is left is identifiers. */
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');

  const root = join(import.meta.dir, '..', 'src');
  const files = [
    ...readdirSync(join(root, 'store')).map((name) => join(root, 'store', name)),
    join(root, 'postgresStore.ts'),
    join(root, 'codec.ts'),
    join(root, 'ids.ts'),
  ];

  test.each(files.map((file) => [file.slice(root.length + 1), file] as const))(
    '%s',
    (_name, file) => {
      expect(code(readFileSync(file, 'utf8'))).not.toMatch(/broker/i);
    }
  );
});
