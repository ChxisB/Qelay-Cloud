import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

describeDb('worker: claiming without a bell', () => {
  let f: SdkFixture;
  let ring: ReturnType<typeof spyOn<typeof f.transport, 'ring'>>;
  const kit = workerKit(() => f);

  beforeAll(async () => {
    f = await openFixture();
  });
  afterAll(async () => {
    await f.drop();
  });
  beforeEach(async () => {
    await resetFixture(f);
    ring = spyOn(f.transport, 'ring');
  });
  afterEach(async () => {
    await kit.closeAll();
    ring.mockRestore();
  });

  test('one bell drains a backlog: a full claim is followed by more claims as slots free up', async () => {
    await f.store.enqueue(Array.from({ length: 30 }, (_, n) => ({ queue: 'p', data: n })));
    const [first] = await f.store.dueForRing({ graceMs: 0 });
    await f.transport.ring([{ bell: first!.bell }]);
    const done: number[] = [];
    kit.worker<number>(
      'p',
      async (job) => {
        done.push(job.data);
      },
      { store: f.store, concurrency: 2 }
    );
    await until('all 30 done', () => done.length === 30);
    expect(ring).toHaveBeenCalledTimes(1);
  });

  test('claimAgain: false leaves the rest of a backlog to the bells', async () => {
    await f.store.enqueue(Array.from({ length: 6 }, (_, n) => ({ queue: 'p', data: n })));
    const [first] = await f.store.dueForRing({ graceMs: 0 });
    await f.transport.ring([{ bell: first!.bell }]);
    const done: number[] = [];
    kit.worker<number>(
      'p',
      async (job) => {
        done.push(job.data);
      },
      { store: f.store, concurrency: 2, claimAgain: false }
    );
    await until('the first claim', () => done.length === 2);
    await pause(200);
    expect(done).toHaveLength(2);
  });

  test('ringCoverMs: a standing backlog is rung once, and the worker still drains all of it', async () => {
    const queue = f.queue<number>('c', { ringCoverMs: 60_000 });
    for (let n = 0; n < 20; n++) await queue.add('x', n);
    expect(ring).toHaveBeenCalledTimes(1);
    const done: number[] = [];
    kit.worker<number>(
      'c',
      async (job) => {
        done.push(job.data);
      },
      { store: f.store, concurrency: 2 }
    );
    await until('all 20 done', () => done.length === 20);
    expect(ring).toHaveBeenCalledTimes(1);
  });
});
