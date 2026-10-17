import type { Attributes, Span, Tracer } from '@opentelemetry/api';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { TraceHandle, TraceSpan, Tracing } from 'qelay-cloud';
import { formatTraceparent, parseTraceparent } from './traceparent';

/** Identifiers and counts only. A payload, a result and an error message are never span attributes. */
function attributesOf(span: TraceSpan): Attributes {
  return {
    'messaging.system': 'qelay-cloud',
    'messaging.destination.name': span.queue,
    'messaging.operation.type': span.operation === 'add' ? 'publish' : 'process',
    ...(span.jobId === undefined ? {} : { 'qcloud.job.id': span.jobId }),
    ...(span.jobName === undefined ? {} : { 'qcloud.job.name': span.jobName }),
    ...(span.attempt === undefined ? {} : { 'qcloud.job.attempts_made': span.attempt }),
    ...(span.count === undefined ? {} : { 'messaging.batch.message_count': span.count }),
  };
}

function fail(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');
}

/**
 * Tracing for a `Queue` and a `Worker` over an OpenTelemetry tracer: `Queue.add` is a producer span
 * whose `traceparent` the store keeps with the job, and the worker's processing span (which includes
 * the complete or fail write) is its child, on every attempt. A tracer that is not recording stores
 * no `traceparent`. `tracestate` and baggage are not carried.
 */
export function otelTracing(tracer: Tracer): Tracing {
  const run = async <T>(
    span: Span,
    work: () => Promise<T>,
    onError: (error: unknown) => void
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      onError(error);
      throw error;
    } finally {
      span.end();
    }
  };
  return {
    produce(span, work) {
      return tracer.startActiveSpan(
        `${span.queue} publish`,
        { kind: SpanKind.PRODUCER, attributes: attributesOf(span) },
        (started) =>
          run(
            started,
            () => work(formatTraceparent(started.spanContext())),
            (error) => fail(started, error)
          )
      );
    },
    consume(span, traceparent, work) {
      const parent = parseTraceparent(traceparent);
      const context =
        parent === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, parent);
      return tracer.startActiveSpan(
        `${span.queue} process`,
        { kind: SpanKind.CONSUMER, attributes: attributesOf(span) },
        context,
        (started) => {
          const handle: TraceHandle = {
            event: (name) => void started.addEvent(name),
            fail: (error) => fail(started, error),
          };
          return run(
            started,
            () => work(handle),
            (error) => fail(started, error)
          );
        }
      );
    },
  };
}
