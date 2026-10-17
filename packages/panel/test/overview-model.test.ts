import { describe, expect, test } from 'bun:test';
import { attentionFor } from '../src/pages/control/overview/attention';
import { EMPTY_OVERVIEW, type QueueHealth } from '../src/pages/control/overview/model';
import {
  appendSample,
  axisLabels,
  gapLimitMs,
  THROUGHPUT_WINDOW_MS,
  windowTitle,
} from '../src/pages/control/overview/throughputHistory';

function snapshot(
  over: Partial<typeof EMPTY_OVERVIEW> & { dlq?: number } = {}
): typeof EMPTY_OVERVIEW {
  const { dlq = 0, ...rest } = over;
  return {
    ...EMPTY_OVERVIEW,
    overview: {
      ...EMPTY_OVERVIEW.overview,
      stats: { ...EMPTY_OVERVIEW.overview.stats, dlq },
    },
    ...rest,
  };
}

const row = (name: string, failed = 0): QueueHealth => ({
  name,
  paused: false,
  dlq: 0,
  counts: { waiting: 0, prioritized: 0, active: 0, completed: 0, failed, delayed: 0 },
});

describe('attentionFor (needs-attention rule)', () => {
  test('hidden when nothing is dead-lettered and nothing failed', () => {
    expect(attentionFor(snapshot())).toBeNull();
  });

  test('one queue holding every dead-lettered job is named and deep-linked', () => {
    const a = attentionFor(snapshot({ dlq: 2, dlqQueues: [{ name: 'emails', dlq: 2 }] }));
    expect(a?.headline).toBe('2 jobs are in the emails dead letter queue');
    expect(a?.detail).toBe('They stopped retrying and are waiting for a decision.');
    expect(a?.reviewLabel).toBe('Review DLQ');
    expect(a?.reviewTo).toBe('/dlq?queue=emails');
  });

  test('singular grammar, and a queue name is URL-encoded in the link', () => {
    const a = attentionFor(snapshot({ dlq: 1, dlqQueues: [{ name: 'a b/c', dlq: 1 }] }));
    expect(a?.headline).toBe('1 job is in the a b/c dead letter queue');
    expect(a?.reviewTo).toBe('/dlq?queue=a%20b%2Fc');
  });

  test('several queues, or an unreadable queue list, fall back to the plain DLQ page', () => {
    const many = attentionFor(
      snapshot({
        dlq: 5,
        dlqQueues: [
          { name: 'a', dlq: 3 },
          { name: 'b', dlq: 2 },
        ],
      })
    );
    expect(many?.headline).toBe('5 jobs are in dead letter queues across 2 queues');
    expect(many?.reviewTo).toBe('/dlq');
    const unknown = attentionFor(snapshot({ dlq: 5, dlqQueues: null }));
    expect(unknown?.headline).toBe('5 jobs are in the dead letter queue');
    expect(unknown?.reviewTo).toBe('/dlq');
  });

  test('failed jobs alone raise the banner and link to the worst queue', () => {
    const a = attentionFor(snapshot({ failedTotal: 4, details: [row('quiet'), row('noisy', 4)] }));
    expect(a?.headline).toBe('4 failed jobs recorded across your queues');
    expect(a?.reviewLabel).toBe('Review failed jobs');
    expect(a?.reviewTo).toBe('/jobs?queue=noisy&status=failed');
  });

  test('dead-lettered jobs win over failed jobs', () => {
    const a = attentionFor(
      snapshot({
        dlq: 1,
        dlqQueues: [{ name: 'q', dlq: 1 }],
        failedTotal: 9,
        details: [row('q', 9)],
      })
    );
    expect(a?.reviewLabel).toBe('Review DLQ');
  });
});

describe('throughput history', () => {
  const at = (s: number) => ({ at: s * 1000, push: s, pull: 0 });

  test('keeps samples inside the five-minute window and drops older ones', () => {
    let pts = [at(0)];
    for (let s = 3; s <= 330; s += 3) pts = appendSample(pts, at(s), 10_000);
    const last = pts[pts.length - 1].at;
    expect(pts.every((p) => last - p.at <= THROUGHPUT_WINDOW_MS)).toBe(true);
    expect(pts[0].at).toBe(30_000);
  });

  test('a poll gap restarts the window instead of drawing a line across it', () => {
    const pts = appendSample([at(0), at(3)], at(60), gapLimitMs(3000));
    expect(pts).toEqual([at(60)]);
  });

  test('the gap limit scales with the refresh interval but never drops below 10s', () => {
    expect(gapLimitMs(1000)).toBe(10_000);
    expect(gapLimitMs(5000)).toBe(20_000);
  });

  test('axis labels run oldest to now, in seconds then minutes', () => {
    expect(axisLabels(0)).toEqual([]);
    expect(axisLabels(400)).toEqual([]);
    expect(axisLabels(100_000)).toEqual(['−100s', '−80s', '−60s', '−40s', '−20s', 'now']);
    expect(axisLabels(300_000)).toEqual(['−5m', '−4m', '−3m', '−2m', '−1m', 'now']);
  });

  test('a short span collapses to its two ends so no label repeats', () => {
    expect(axisLabels(3000)).toEqual(['−3s', 'now']);
    for (const span of [1000, 3000, 4000, 7000, 12_000, 45_000, 130_000, 300_000]) {
      const labels = axisLabels(span);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  test('window title rounds up to whole minutes, capped at five', () => {
    expect(windowTitle(0)).toBe('last minute');
    expect(windowTitle(61_000)).toBe('last 2 minutes');
    expect(windowTitle(900_000)).toBe('last 5 minutes');
  });
});
