import type { SpanContext } from '@opentelemetry/api';
import { isSpanContextValid, TraceFlags } from '@opentelemetry/api';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** The W3C `traceparent` of a span, or `undefined` for the all-zero context of a tracer that is not recording. */
export function formatTraceparent(span: SpanContext): string | undefined {
  if (!isSpanContextValid(span)) return undefined;
  return `00-${span.traceId}-${span.spanId}-${(span.traceFlags & TraceFlags.SAMPLED).toString(16).padStart(2, '0')}`;
}

/** A stored `traceparent` as a remote parent. Anything that is not a valid version 00 header starts a new trace instead. */
export function parseTraceparent(value: string | undefined): SpanContext | undefined {
  const match = value === undefined ? null : TRACEPARENT.exec(value);
  if (match === null) return undefined;
  const context: SpanContext = {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: Number.parseInt(match[3]!, 16) & TraceFlags.SAMPLED,
    isRemote: true,
  };
  return isSpanContextValid(context) ? context : undefined;
}
