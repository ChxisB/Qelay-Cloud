import { describe, expect, test } from 'bun:test';
import type { ServerTargetClient } from '../src/lib/bq';
import { createBenchmarkCompensationQueue } from '../src/pages/control/benchmark/compensationQueue';
import { DEFAULT_CONFIG } from '../src/pages/control/benchmark/engine';
import { type BenchmarkLoopContext, createConsumer } from '../src/pages/control/benchmark/runLoops';
import { freshBenchmarkStats } from '../src/pages/control/benchmark/runtimeState';

describe('benchmark count-mode drain termination', () => {
  test('idle workers with slow pulls still report a lost job instead of waiting on each other', async () => {
    let pulls = 0;
    const client = {
      // Slow, always-empty pulls: at any instant most idle siblings are
      // mid-pull, which must not keep the run alive forever.
      pullBatch: async () => {
        pulls += 1;
        await Bun.sleep(90 + ((pulls * 37) % 80));
        return { ok: true, jobs: [], tokens: [] };
      },
      heartbeatBatch: async () => ({ ok: true, data: { ok: true, count: 0 } }),
      ackBatch: async () => ({ ok: true }),
      retryJob: async () => ({ ok: true }),
    } as unknown as ServerTargetClient;
    const stats = freshBenchmarkStats();
    let running = true;
    const context: BenchmarkLoopContext = {
      batch: 1,
      blob: '',
      client,
      compensationQueue: createBenchmarkCompensationQueue(),
      deadline: Number.POSITIVE_INFINITY,
      isCurrent: () => true,
      ownJobIds: new Set(['lost-job']),
      payload: 0,
      pendingPushes: new Set(),
      processMs: 0,
      producersDone: () => true,
      queue: 'benchmark',
      runId: 'run-lost',
      runConfig: { ...DEFAULT_CONFIG, total: 1, workers: 6, workerBatch: 1 },
      shouldContinue: () => running,
      stats,
      stop: () => {
        running = false;
      },
      total: 1,
      workerBatch: 1,
    };

    const started = performance.now();
    const consumers = Promise.all(Array.from({ length: 6 }, createConsumer(context)));
    const finished = await Promise.race([
      consumers.then(() => true),
      Bun.sleep(2_000).then(() => false),
    ]);
    running = false;
    await consumers;

    expect(finished).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Each worker needs one empty pull; a ping-pong re-pulls many times.
    expect(pulls).toBeLessThanOrEqual(12);
    expect(stats.error).toBe('1 benchmark job(s) could not be drained.');
  });
});
