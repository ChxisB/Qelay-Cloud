import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { mergeByPriority } from '../src/store/claimSelect';
import type { TestStore } from './storeHelpers';
import { openTestStore, rewind } from './storeHelpers';

describe('claim: mergeByPriority', () => {
  const lifo = (...priorities: number[]) =>
    priorities.map((priority, n) => ({ priority, tag: `L${n}` }));
  const fifo = (...priorities: number[]) =>
    priorities.map((priority, n) => ({ priority, tag: `F${n}` }));
  const tags = (items: Array<{ tag: string }>) => items.map((item) => item.tag);

  test('a higher priority comes first, whichever list holds it', () => {
    expect(tags(mergeByPriority(lifo(1, 1), fifo(3, 2)))).toEqual(['F0', 'F1', 'L0', 'L1']);
  });

  test('at equal priority every LIFO job comes before any FIFO job', () => {
    expect(tags(mergeByPriority(lifo(2, 2), fifo(2, 2)))).toEqual(['L0', 'L1', 'F0', 'F1']);
  });

  test('either list may be empty', () => {
    expect(tags(mergeByPriority(lifo(), fifo(1, 0)))).toEqual(['F0', 'F1']);
    expect(tags(mergeByPriority(lifo(1, 0), fifo()))).toEqual(['L0', 'L1']);
    expect(mergeByPriority([], [])).toEqual([]);
  });

  test('each list keeps its own order', () => {
    const merged = mergeByPriority(lifo(5, 3, 1), fifo(4, 3, 2));
    expect(tags(merged)).toEqual(['L0', 'F0', 'L1', 'F1', 'F2', 'L2']);
  });
});

describeDb('claim: order', () => {
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore();
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await t.fresh.sql`TRUNCATE qcloud_jobs, qcloud_queue_state`;
    rewind(t);
  });

  /** Enqueues each spec in turn, one millisecond apart, and returns `label -> id`. */
  async function put(specs: Record<string, object>): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const [label, options] of Object.entries(specs)) {
      const [job] = await t.store.enqueue([{ queue: 'q', data: label, options }]);
      ids.set(job!.id, label);
      t.clock.advance(1);
    }
    return ids;
  }

  const drain = async (labels: Map<string, string>, n = 1): Promise<string[]> => {
    const order: string[] = [];
    for (;;) {
      const claimed = await t.store.claim('q', 'w', n);
      if (claimed.length === 0) return order;
      order.push(...claimed.map((job) => labels.get(job.id)!));
    }
  };

  test('FIFO: oldest first', async () => {
    const labels = await put({ a: {}, b: {}, c: {} });
    expect(await drain(labels)).toEqual(['a', 'b', 'c']);
  });

  test('a higher priority first, then FIFO within it', async () => {
    const labels = await put({
      low1: { priority: 1 },
      none: {},
      high1: { priority: 9 },
      low2: { priority: 1 },
      high2: { priority: 9 },
    });
    expect(await drain(labels)).toEqual(['high1', 'high2', 'low1', 'low2', 'none']);
  });

  test('LIFO: newest first, and before FIFO jobs of the same priority', async () => {
    const labels = await put({ f1: {}, l1: { lifo: true }, f2: {}, l2: { lifo: true } });
    expect(await drain(labels)).toEqual(['l2', 'l1', 'f1', 'f2']);
  });

  test('priority beats LIFO', async () => {
    const labels = await put({ lifo: { lifo: true }, fifoHigh: { priority: 2 } });
    expect(await drain(labels)).toEqual(['fifoHigh', 'lifo']);
  });

  test('LIFO jobs of a higher priority come before LIFO jobs of a lower one', async () => {
    const labels = await put({
      lowOld: { lifo: true, priority: 1 },
      highOld: { lifo: true, priority: 3 },
      lowNew: { lifo: true, priority: 1 },
      highNew: { lifo: true, priority: 3 },
    });
    expect(await drain(labels)).toEqual(['highNew', 'highOld', 'lowNew', 'lowOld']);
  });

  test('FIFO orders by run_at, so a delayed job that became due queues behind earlier ones', async () => {
    const [delayed] = await t.store.enqueue([
      { queue: 'q', data: 'delayed', options: { delay: 10 } },
    ]);
    const labels = await put({ now1: {}, now2: {} });
    labels.set(delayed!.id, 'delayed');
    t.clock.advance(100);
    expect(await drain(labels)).toEqual(['now1', 'now2', 'delayed']);
  });

  test('the order holds across claims of several jobs at once', async () => {
    const labels = await put({
      a: {},
      b: { priority: 5 },
      c: { lifo: true },
      d: { priority: 5, lifo: true },
      e: {},
    });
    expect(await drain(labels, 2)).toEqual(['d', 'b', 'c', 'a', 'e']);
  });

  test('a mixed batch claims exactly the first n of the whole order', async () => {
    const labels = await put({
      f1: {},
      f2: {},
      l1: { lifo: true },
      l2: { lifo: true },
      l3: { lifo: true },
    });
    const claimed = await t.store.claim('q', 'w', 3);
    expect(claimed.map((job) => labels.get(job.id))).toEqual(['l3', 'l2', 'l1']);
  });
});
