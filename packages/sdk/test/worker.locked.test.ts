import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from './support';
import { NAMESPACE, openFixture, resetFixture } from './support';
import { pause, until, workerKit } from './workerSupport';

describeDb('worker: a bell whose job another transaction holds', () => {
  let f: SdkFixture;
  const kit = workerKit(() => f);
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
  });

  /** Adds a job without ringing it, so the test rings the bell itself. */
  async function addQuietly(queue: string, jobId: string): Promise<void> {
    await f.store.enqueue([{ queue, data: {}, options: { jobId } }]);
  }

  const ring = (queue: string, jobId: string) =>
    f.transport.ring([{ bell: { namespace: NAMESPACE, queue, jobId } }]);

  /** Counts the claims the worker makes on the shared store. Returns the counter and an undo. */
  function countClaims(): { count: () => number; undo: () => void } {
    const original = f.store.claim.bind(f.store);
    let calls = 0;
    f.store.claim = (...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    };
    return {
      count: () => calls,
      undo: () => {
        f.store.claim = original;
      },
    };
  }

  /** Holds `UPDATE rung_at` (what `markRung` does right after a ring) on the job until released. */
  async function holdRow(jobId: string): Promise<() => Promise<void>> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = f.fresh.sql.begin(async (tx) => {
      await tx`UPDATE qcloud_jobs SET rung_at = 1 WHERE id = ${jobId}`;
      locked();
      await held;
    });
    await acquired;
    return async () => {
      release();
      await holder;
    };
  }

  test('the claim that found it locked is tried once more, so the job does not wait for the tick', async () => {
    const queue = f.queue('locked');
    const seen: string[] = [];
    kit.worker('locked', (job) => void seen.push(job.id), { store: f.store });
    await addQuietly('locked', 'held');
    const release = await holdRow('held');
    await ring('locked', 'held');
    // The first claim skips the locked row and comes back empty; the writer commits during the pause before the second.
    await pause(10);
    await release();
    await until(
      'the job to complete',
      async () => (await queue.getJobState('held')) === 'completed'
    );
    expect(seen).toEqual(['held']);
  });

  test('a bell is fungible: when another claim took its job and a different one is locked, it still tries again', async () => {
    const queue = f.queue('fungible');
    kit.worker('fungible', () => {}, { store: f.store });
    await addQuietly('fungible', 'free');
    await addQuietly('fungible', 'held');
    const release = await holdRow('held');
    // The first bell names `free` and takes it. The second also names `free`, which is gone, and
    // finds `held` locked by the writer that is recording its own bell. A bell does not own its job,
    // so what decides the second try is whether the queue still has a job waiting, not this bell's.
    await ring('fungible', 'free');
    await until(
      'the free job to complete',
      async () => (await queue.getJobState('free')) === 'completed'
    );
    await ring('fungible', 'free');
    await pause(10);
    await release();
    await until(
      'the locked job to complete without a tick',
      async () => (await queue.getJobState('held')) === 'completed'
    );
  });

  test('a bell whose job another worker already finished is acknowledged after one claim', async () => {
    const claims = countClaims();
    try {
      await addQuietly('gone', 'done');
      const [job] = await f.store.claim('gone', 'someone-else', 1);
      await f.store.complete(job!.lease, 'ok');
      kit.worker('gone', () => {}, { store: f.store });
      const before = claims.count();
      await ring('gone', 'done');
      await until('the bell to be acknowledged', () => f.transport.buffered('gone').ready === 0);
      await pause(100);
      expect(claims.count() - before).toBe(1);
    } finally {
      claims.undo();
    }
  });

  test('a waiting job nothing can claim (its queue is paused) costs one retry per bell, not a loop', async () => {
    const claims = countClaims();
    try {
      const queue = f.queue('stopped');
      await addQuietly('stopped', 'blocked');
      await queue.pause();
      kit.worker('stopped', () => {}, { store: f.store });
      const before = claims.count();
      await ring('stopped', 'blocked');
      await until('the bell to be acknowledged', () => claims.count() - before >= 2);
      await pause(150);
      expect(claims.count() - before).toBe(2);
      expect(f.transport.buffered('stopped')).toMatchObject({ ready: 0, inFlight: 0 });
      expect(await queue.getJobState('blocked')).toBe('waiting');
    } finally {
      claims.undo();
    }
  });
});
