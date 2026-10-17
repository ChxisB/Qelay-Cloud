import type { Attributes, Counter, Gauge, Histogram, Meter } from '@opentelemetry/api';
import type { Telemetry } from '@qelay-cloud/maintenance';
import type { Metrics } from 'qelay-cloud';

/** Instruments are created on first use and kept: a meter hands back the same one for a name, but not for free. */
function cache<I>(make: (name: string) => I): (name: string) => I {
  const made = new Map<string, I>();
  return (name) => {
    let instrument = made.get(name);
    if (instrument === undefined) {
      instrument = make(name);
      made.set(name, instrument);
    }
    return instrument;
  };
}

const attributesOf = (tags: Readonly<Record<string, string>> | undefined): Attributes => ({
  ...tags,
});

/**
 * The SDK's metrics sink over an OpenTelemetry meter: `increment` is a counter, `observe` a histogram
 * (`qcloud.worker.claim_ms` is in milliseconds). Names and tags are the SDK's own, listed in `docs/observability.md`.
 */
export function otelMetrics(meter: Meter): Metrics {
  const counter = cache<Counter>((name) => meter.createCounter(name));
  const histogram = cache<Histogram>((name) =>
    meter.createHistogram(name, name.endsWith('_ms') ? { unit: 'ms' } : {})
  );
  return {
    increment: (name, value, tags) => counter(name).add(value ?? 1, attributesOf(tags)),
    observe: (name, value, tags) => histogram(name).record(value, attributesOf(tags)),
  };
}

/**
 * The maintenance tick's telemetry over an OpenTelemetry meter. Step durations are one histogram
 * (`qcloud.tick.duration`, attribute `step`), each count is a gauge named `qcloud.tick.<name>`, and
 * errors are a counter by step and error class (never the message). `qcloud.tick.last_success` is the
 * epoch seconds of the last pass that reported `ok` and had no error, so "tick age" is `now - last_success`.
 */
export function otelTelemetry(meter: Meter, now: () => number = Date.now): Telemetry {
  const duration = meter.createHistogram('qcloud.tick.duration', { unit: 'ms' });
  const errors = meter.createCounter('qcloud.tick.errors');
  const lastSuccess = meter.createGauge('qcloud.tick.last_success', { unit: 's' });
  const gauge = cache<Gauge>((name) => meter.createGauge(`qcloud.tick.${name}`));
  let failedSincePass = false;
  return {
    duration: (step, ms) => duration.record(ms, { step }),
    gauge(name, value) {
      gauge(name).record(value);
      if (name !== 'ok') return;
      if (value === 1 && !failedSincePass) lastSuccess.record(Math.floor(now() / 1000));
      failedSincePass = false;
    },
    error(step, error) {
      // A tick that threw never reached its gauges, so the next pass starts clean; a failed totals read costs the pass nothing.
      if (step !== 'tick' && step !== 'totals') failedSincePass = true;
      errors.add(1, { step, 'error.type': error instanceof Error ? error.name : 'unknown' });
    },
  };
}
