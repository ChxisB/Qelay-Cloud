import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { ClaimedJob, Ring } from '@qelay-cloud/core';
import { StoreError } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import { codec, metric, readJob, recording, resetTables } from './finishHelpers';
import type { TestStore } from './storeHelpers';
import { enqueueN, openTestStore } from './storeHelpers';

describeDb('completeMany: one transaction for a batch', () => {
  const log = recording();
  let hookRings: Ring[] = [];
  let t: TestStore;
  beforeAll(async () => {
    t = await openTestStore({
      recorder: log.recorder,
      leaseMs: 30_000,
      onTerminal: async () => hookRings,
    });
  });
  afterAll(async () => {
    await t.drop();
  });
  beforeEach(async () => {
    await resetTables(t);
    log.events.length = 0;
    hookRings = [];
  });

  const completedEvents = () => log.events.filter((e) => e.type === 'completed');

  async function claimed(count: number, queue = 'q', options = {}): Promise<ClaimedJob[]> {
    await enqueueN(t.store, count, options, queue);
    return t.store.claim(queue, 'w', count);
  }

  test('completes every job with its own result, one event each and one summed metric per queue', async () => {
    const [a, b] = await claimed(2, 'one');
    const [c] = await claimed(1, 'two');
    const outcomes = await t.store.completeMany([
      { lease: a!.lease, result: 'a' },
      { lease: b!.lease, result: { b: 2 } },
      { lease: c!.lease, result: undefined },
    ]);
    expect(outcomes.map((o) => (o instanceof Error ? 'error' : o.ok))).toEqual([true, true, true]);
    expect(codec.decode((await readJob(t, a!.id))!.result!)).toBe('a');
    expect(codec.decode((await readJob(t, b!.id))!.result!)).toEqual({ b: 2 });
    expect(await readJob(t, c!.id)).toMatchObject({ state: 'completed', version: '2' });
    const [records] = await t.fresh.sql<Array<{ n: string }>>`
      SELECT count(*) AS n FROM qcloud_completions`;
    expect(Number(records!.n)).toBe(3);
    expect(completedEvents().map((e) => [e.type, e.jobId])).toEqual([
      ['completed', a!.id],
      ['completed', b!.id],
      ['completed', c!.id],
    ]);
    expect((await metric(t, 'one', 'completed')).total).toBe(2);
    expect((await metric(t, 'two', 'completed')).total).toBe(1);
  });

  test('a lost lease, a repeat and a result the store refuses fail alone; the rest are completed', async () => {
    const [good, stale, repeat, huge, last] = await claimed(5);
    const outcomes = await t.store.completeMany([
      { lease: good!.lease, result: 1 },
      { lease: { ...stale!.lease, token: 'not-the-token' }, result: 2 },
      { lease: repeat!.lease, result: 3 },
      { lease: repeat!.lease, result: 4 },
      { lease: huge!.lease, result: 'x'.repeat(1024 * 1024 + 1) },
      { lease: last!.lease, result: 5 },
    ]);
    expect(outcomes.map((o) => (o instanceof StoreError ? 'refused' : o.ok))).toEqual([
      true,
      false,
      true,
      false,
      'refused',
      true,
    ]);
    const states = await Promise.all(
      [good, stale, repeat, huge, last].map((j) => readJob(t, j!.id))
    );
    expect(states.map((row) => row!.state)).toEqual([
      'completed',
      'active',
      'completed',
      'active',
      'completed',
    ]);
    expect(codec.decode(states[2]!.result!)).toBe(3);
    expect((await metric(t, 'q', 'completed')).total).toBe(3);
    expect(await t.store.completeMany([])).toEqual([]);
  });

  test('removeOnComplete rows are deleted and keep their completion record', async () => {
    const [keep] = await claimed(1);
    const [gone] = await claimed(1, 'q', { removeOnComplete: true });
    await t.store.completeMany([
      { lease: keep!.lease, result: 'k' },
      { lease: gone!.lease, result: 'g' },
    ]);
    expect(await readJob(t, gone!.id)).toBeUndefined();
    expect(await readJob(t, keep!.id)).toMatchObject({ state: 'completed' });
    const [records] = await t.fresh.sql<Array<{ n: string }>>`
      SELECT count(*) AS n FROM qcloud_completions`;
    expect(Number(records!.n)).toBe(2);
    expect(completedEvents().find((e) => e.jobId === gone!.id)).toMatchObject({ removed: true });
  });

  test('the batch rings are on the first ok outcome, and a throwing hook writes nothing', async () => {
    const [x, y] = await claimed(2);
    hookRings = [{ bell: { namespace: 'test', queue: 'q', jobId: 'parent' }, dueInMs: 0 }];
    const outcomes = await t.store.completeMany([
      { lease: { ...x!.lease, token: 'wrong' }, result: 1 },
      { lease: y!.lease, result: 2 },
    ]);
    expect(outcomes).toEqual([
      { ok: false, rings: [] },
      { ok: true, rings: hookRings },
    ]);
    const [z] = await claimed(1);
    log.failWith(new Error('journal down'));
    await expect(t.store.completeMany([{ lease: z!.lease, result: 3 }])).rejects.toThrow(
      'journal down'
    );
    expect(await readJob(t, z!.id)).toMatchObject({ state: 'active' });
  });

  test('refuses a batch over the store limit', async () => {
    const lease = { jobId: 'x', token: 't', owner: 'w' };
    const items = Array.from({ length: 1001 }, () => ({ lease, result: null }));
    await expect(t.store.completeMany(items)).rejects.toThrow(StoreError);
  });
});
