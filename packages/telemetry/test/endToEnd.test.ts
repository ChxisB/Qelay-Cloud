import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { SdkFixture } from '../../sdk/test/support';
import { openFixture, resetFixture } from '../../sdk/test/support';
import { until, workerKit } from '../../sdk/test/workerSupport';
import { otelMetrics, otelTracing } from '../src';
import { recordingMeter, recordingTracer } from './support';

describeDb('telemetry: a job from add to worker', () => {
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

  const byName = (
    spans: ReturnType<ReturnType<typeof recordingTracer>['finished']>,
    name: string
  ) => spans.filter((span) => span.name === name);

  test('the worker span continues the trace of the add, and a retry adds a second span to the same trace', async () => {
    const { tracer, finished } = recordingTracer();
    const tracing = otelTracing(tracer);
    const queue = f.queue('traced', { tracing });
    let tries = 0;
    const worker = kit.worker(
      'traced',
      async () => {
        tries += 1;
        if (tries === 1) throw new Error('first try fails');
        return 'ok';
      },
      { tracing }
    );
    const done: string[] = [];
    worker.on('completed', () => done.push('completed'));
    await queue.add('charge', { n: 1 }, { attempts: 2, backoff: 10 });
    await until('the retry to complete', () => done.length > 0);
    await until('both process spans', () => byName(finished(), 'traced process').length === 2);
    const [added] = byName(finished(), 'traced publish');
    const processed = byName(finished(), 'traced process');
    expect(added).toBeDefined();
    for (const span of processed) {
      expect(span.spanContext().traceId).toBe(added!.spanContext().traceId);
      expect(span.parentSpanContext?.spanId).toBe(added!.spanContext().spanId);
    }
    expect(processed.map((span) => span.attributes['qcloud.job.attempts_made'])).toEqual([0, 1]);
    expect(processed.map((span) => span.status.code)).toEqual([2, 0]);
    expect(processed[0]!.attributes['error.type']).toBe('Error');
  });

  test('a job added without tracing gets a root span in the worker, and the job runs the same', async () => {
    const { tracer, finished } = recordingTracer();
    const queue = f.queue('plain');
    const worker = kit.worker('plain', async () => 'ok', { tracing: otelTracing(tracer) });
    const done: string[] = [];
    worker.on('completed', () => done.push('completed'));
    await queue.add('job', {});
    await until('completion', () => done.length > 0);
    await until('the span', () => finished().length === 1);
    expect(finished()[0]!.parentSpanContext).toBeUndefined();
  });

  test('the traceparent is stored with the job and comes back on the claim; a job added without tracing has none', async () => {
    const { tracer, finished } = recordingTracer();
    await f.queue('stored', { tracing: otelTracing(tracer) }).add('traced', {});
    await f.queue('stored').add('plain', {});
    const claimed = await f.store.claim('stored', 'w', 2);
    const traced = claimed.find((job) => job.name === 'traced')!;
    const [span] = finished();
    expect(traced.trace).toBe(`00-${span!.spanContext().traceId}-${span!.spanContext().spanId}-01`);
    expect(claimed.find((job) => job.name === 'plain')!.trace).toBeUndefined();
  });

  test('a worker reports claims and claim latency through the metrics adapter', async () => {
    const { meter, points } = recordingMeter();
    const metrics = otelMetrics(meter);
    const queue = f.queue('measured');
    const worker = kit.worker('measured', async () => 'ok', { metrics });
    const done: string[] = [];
    worker.on('completed', () => done.push('completed'));
    await queue.addBulk([
      { name: 'a', data: {} },
      { name: 'b', data: {} },
      { name: 'c', data: {} },
    ]);
    await until('three completions', () => {
      return done.length >= 3;
    });
    const found = await points();
    expect(found.find((p) => p.name === 'qcloud.worker.claimed')!.value).toBeGreaterThanOrEqual(3);
    expect(
      found
        .filter((p) => p.name === 'qcloud.worker.claims')
        .some((p) => p.attributes.result === 'jobs')
    ).toBe(true);
    expect(found.find((p) => p.name === 'qcloud.worker.claim_ms')!.count).toBeGreaterThanOrEqual(1);
  });
});
