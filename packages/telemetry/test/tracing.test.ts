import { describe, expect, test } from 'bun:test';
import { formatTraceparent, otelTracing, parseTraceparent } from '../src';
import { recordingTracer, silentTracer } from './support';

const ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('traceparent', () => {
  test('a header round-trips, and only the sampled flag is kept', () => {
    const parsed = parseTraceparent(`00-${ID}-${SPAN}-03`)!;
    expect(parsed).toMatchObject({ traceId: ID, spanId: SPAN, traceFlags: 1, isRemote: true });
    expect(formatTraceparent(parsed)).toBe(`00-${ID}-${SPAN}-01`);
  });

  test.each([
    ['nothing', undefined],
    ['the wrong version', `01-${ID}-${SPAN}-01`],
    ['upper case', `00-${ID.toUpperCase()}-${SPAN}-01`],
    ['a short trace id', `00-${ID.slice(2)}-${SPAN}-01`],
    ['all-zero ids', `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['trailing text', `00-${ID}-${SPAN}-01-extra`],
  ])('%s is not a parent', (_, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });
});

describe('otelTracing', () => {
  const span = { operation: 'add', queue: 'orders' } as const;
  const process = {
    operation: 'process',
    queue: 'orders',
    jobId: 'j1',
    jobName: 'charge',
    attempt: 2,
  } as const;

  test('the consumer span is a child of the producer span, in one trace', async () => {
    const { tracer, finished } = recordingTracer();
    const tracing = otelTracing(tracer);
    let carrier: string | undefined;
    await tracing.produce(
      { ...span, count: 3 },
      async (traceparent) => void (carrier = traceparent)
    );
    await tracing.consume(process, carrier, async (handle) => handle.event('completed'));
    const [produced, consumed] = finished();
    expect(carrier).toBe(
      `00-${produced!.spanContext().traceId}-${produced!.spanContext().spanId}-01`
    );
    expect(consumed!.spanContext().traceId).toBe(produced!.spanContext().traceId);
    expect(consumed!.parentSpanContext?.spanId).toBe(produced!.spanContext().spanId);
    expect(produced!.name).toBe('orders publish');
    expect(consumed!.name).toBe('orders process');
    expect(consumed!.events.map((event) => event.name)).toEqual(['completed']);
    expect(consumed!.attributes).toMatchObject({
      'messaging.destination.name': 'orders',
      'qcloud.job.id': 'j1',
      'qcloud.job.name': 'charge',
      'qcloud.job.attempts_made': 2,
    });
    expect(produced!.attributes['messaging.batch.message_count']).toBe(3);
  });

  test('a job without a stored trace, or with a damaged one, starts a trace of its own', async () => {
    const { tracer, finished } = recordingTracer();
    const tracing = otelTracing(tracer);
    await tracing.consume(process, undefined, async () => {});
    await tracing.consume(process, 'not a header', async () => {});
    for (const started of finished()) expect(started.parentSpanContext).toBeUndefined();
    expect(new Set(finished().map((s) => s.spanContext().traceId)).size).toBe(2);
  });

  test('a failure marks the span with the error class and exports neither message nor stack', async () => {
    const { tracer, finished } = recordingTracer();
    const tracing = otelTracing(tracer);
    class ChargeError extends Error {}
    ChargeError.prototype.name = 'ChargeError';
    const secret = new ChargeError('card 4242 4242 4242 4242 declined');
    await expect(
      tracing.consume(process, undefined, async (handle) => {
        handle.fail(secret);
        throw secret;
      })
    ).rejects.toBe(secret);
    const [consumed] = finished();
    expect(consumed!.status.code).toBe(2);
    expect(consumed!.attributes['error.type']).toBe('ChargeError');
    expect(
      JSON.stringify([consumed!.attributes, consumed!.events, consumed!.status])
    ).not.toContain('4242');
  });

  test('a tracer that is not recording stores no trace context and the work still runs', async () => {
    const tracing = otelTracing(silentTracer());
    let seen: string | undefined = 'unset';
    const value = await tracing.produce(span, async (traceparent) => {
      seen = traceparent;
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).toBeUndefined();
  });

  test('the work that throws is rethrown and its span still ends', async () => {
    const { tracer, finished } = recordingTracer();
    await expect(
      otelTracing(tracer).produce(span, async () => {
        throw new Error('store down');
      })
    ).rejects.toThrow('store down');
    expect(finished()).toHaveLength(1);
    expect(finished()[0]!.status.code).toBe(2);
  });
});
