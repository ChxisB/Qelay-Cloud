import { describe, expect, test } from 'bun:test';
import { otelMetrics, otelTelemetry } from '../src';
import { recordingMeter } from './support';

describe('otelMetrics', () => {
  test('increments add up per tag set, and observations are a histogram in ms', async () => {
    const { meter, points } = recordingMeter();
    const metrics = otelMetrics(meter);
    metrics.increment('qcloud.worker.claims', 1, { result: 'empty' });
    metrics.increment('qcloud.worker.claims', 1, { result: 'empty' });
    metrics.increment('qcloud.worker.claims', 1, { result: 'jobs' });
    metrics.increment('qcloud.worker.claimed', 5);
    metrics.observe!('qcloud.worker.claim_ms', 4, { queue: 'q' });
    metrics.observe!('qcloud.worker.claim_ms', 6, { queue: 'q' });
    const found = await points();
    const claims = found.filter((p) => p.name === 'qcloud.worker.claims');
    expect(claims.map((p) => [p.attributes.result, p.value]).sort()).toEqual([
      ['empty', 2],
      ['jobs', 1],
    ]);
    expect(found.find((p) => p.name === 'qcloud.worker.claimed')!.value).toBe(5);
    expect(found.find((p) => p.name === 'qcloud.worker.claim_ms')).toMatchObject({
      value: 10,
      count: 2,
      attributes: { queue: 'q' },
    });
  });
});

describe('otelTelemetry', () => {
  function tick() {
    const { meter, points } = recordingMeter();
    let clock = 1_000_000;
    const telemetry = otelTelemetry(meter, () => clock);
    const lastSuccess = async () =>
      (await points()).find((p) => p.name === 'qcloud.tick.last_success')?.value;
    return { telemetry, points, lastSuccess, at: (ms: number) => void (clock = ms) };
  }

  test('durations are one histogram by step, and counts are gauges named under qcloud.tick', async () => {
    const { telemetry, points } = tick();
    telemetry.duration('recover', 3);
    telemetry.duration('pass', 20);
    telemetry.gauge('rings.due', 4);
    telemetry.gauge('rings.due', 2);
    const found = await points();
    expect(
      found
        .filter((p) => p.name === 'qcloud.tick.duration')
        .map((p) => p.attributes.step)
        .sort()
    ).toEqual(['pass', 'recover']);
    expect(found.find((p) => p.name === 'qcloud.tick.rings.due')!.value).toBe(2);
  });

  test('last_success moves only on a pass that reported ok and had no error since the last one', async () => {
    const { telemetry, lastSuccess, at } = tick();
    expect(await lastSuccess()).toBeUndefined();
    telemetry.gauge('ok', 0);
    expect(await lastSuccess()).toBeUndefined();
    at(2_000_000);
    telemetry.error('ring', new Error('broker down'));
    telemetry.gauge('ok', 1);
    expect(await lastSuccess()).toBeUndefined();
    at(3_000_000);
    telemetry.gauge('ok', 1);
    expect(await lastSuccess()).toBe(3000);
    at(3_500_000);
    telemetry.error('totals', new Error('read failed'));
    telemetry.gauge('ok', 1);
    expect(await lastSuccess()).toBe(3500);
    at(4_000_000);
    telemetry.error('tick', new Error('store down'));
    telemetry.gauge('ok', 1);
    expect(await lastSuccess()).toBe(4000);
  });

  test('an error is counted by step and class and its message is not exported', async () => {
    const { telemetry, points } = tick();
    telemetry.error('record', new TypeError('postgres://user:hunter2@db/qcloud'));
    telemetry.error('loop', 'a string');
    const found = (await points()).filter((p) => p.name === 'qcloud.tick.errors');
    expect(
      found.map((p) => p.attributes).sort((a, b) => String(a.step).localeCompare(String(b.step)))
    ).toEqual([
      { step: 'loop', 'error.type': 'unknown' },
      { step: 'record', 'error.type': 'TypeError' },
    ]);
    expect(JSON.stringify(found)).not.toContain('hunter2');
  });
});
