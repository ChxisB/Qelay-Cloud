import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { BenchmarkResults } from '../src/pages/control/benchmark/BenchmarkResults';
import { DEFAULT_CONFIG, type RunRecord } from '../src/pages/control/benchmark/engine';
import { RunHistory } from '../src/pages/control/benchmark/RunHistory';
import { EMPTY_LIVE } from '../src/pages/control/benchmark/runtimeState';
import { renderUi } from './control-dom.helpers';
import { ensureDom } from './domSetup';

// The benchmark bars fill with a transform and never by animating width, and the history rows rise in once.

let view: { host: HTMLElement; unmount: () => void } | null = null;
beforeEach(ensureDom);
afterEach(() => {
  view?.unmount();
  view = null;
});

const run = (id: number): RunRecord => ({
  id,
  at: id,
  mode: 'count',
  producers: 4,
  workers: 4,
  pushed: 100,
  completed: 100,
  pushFailed: 0,
  ackFailed: 0,
  bytes: 1000,
  durationMs: 1000,
  pushPerSec: 100,
  donePerSec: 100,
  mbPerSec: 1,
  avg: 1,
  p50: 1,
  p95: 2,
  p99: 3,
  max: 4,
  error: null,
});

describe('Benchmark progress bars', () => {
  test('fill with scaleX on a full-width bar, so no width is ever animated', () => {
    view = renderUi(
      createElement(BenchmarkResults, {
        heading: 'Producing…',
        pollBaseUrl: 'http://srv',
        etaText: '',
        shown: { ...DEFAULT_CONFIG, mode: 'count' },
        shownWorkers: 2,
        producePct: 40,
        drainPct: 10,
        durationPct: 0,
        live: EMPTY_LIVE,
        summary: null,
      })
    );
    const bars = view.host.querySelectorAll<HTMLElement>('[role="progressbar"] > .motion-fill');
    expect(bars).toHaveLength(2);
    expect(bars[0].style.transform).toBe('scaleX(0.4)');
    expect(bars[1].style.transform).toBe('scaleX(0.1)');
    for (const bar of bars) {
      expect(bar.style.width).toBe('');
      expect(bar.className).toContain('w-full');
    }
  });
});

describe('Run history', () => {
  test('the runs there when the page opens rise in turn', () => {
    const render = (history: RunRecord[]) =>
      createElement(RunHistory, { history, onClear: () => {} });
    view = renderUi(render([run(1), run(2)]));
    const rows = () => [...view!.host.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows().map((row) => row.className.includes('motion-arrive'))).toEqual([true, true]);
    expect(rows()[1].style.getPropertyValue('--i')).toBe('1');
  });
});
