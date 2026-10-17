import { context, trace } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** A tracer provider that keeps finished spans in memory. It is not registered globally. */
export function recordingTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), finished: () => exporter.getFinishedSpans() };
}

/** A tracer that records nothing, as the API gives before any SDK is registered. */
export const silentTracer = () => trace.getTracerProvider().getTracer('silent');
export const activeContext = () => context.active();

interface Point {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  /** A counter's or gauge's value, a histogram's sum. */
  readonly value: number;
  /** A histogram's count. */
  readonly count?: number;
}

/** A meter provider whose current readings can be listed. */
export function recordingMeter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('test'),
    async points(): Promise<Point[]> {
      exporter.reset();
      await provider.forceFlush();
      const found: Point[] = [];
      for (const resource of exporter.getMetrics()) {
        for (const scope of resource.scopeMetrics) {
          for (const metric of scope.metrics) {
            for (const dataPoint of metric.dataPoints) {
              const data = dataPoint.value;
              const histogram = typeof data === 'object' ? data : undefined;
              found.push({
                name: metric.descriptor.name,
                attributes: { ...dataPoint.attributes },
                value: histogram ? (histogram.sum ?? 0) : (data as number),
                ...(histogram ? { count: histogram.count } : {}),
              });
            }
          }
        }
      }
      return found;
    },
  };
}
