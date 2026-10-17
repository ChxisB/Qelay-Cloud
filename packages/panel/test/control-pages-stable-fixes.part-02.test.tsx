import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import type { QueueOperationsRepository } from '../src/features/queue-operations/application/QueueOperationsRepository';
import { QueueOperationsPanel } from '../src/features/queue-operations/ui/QueueOperationsPanel';
import { RowDetailDrawer } from '../src/pages/control/database/RowDetailDrawer';
import { useQueueDepth } from '../src/pages/control/queueDetail/useQueueDepth';
import { UsagePro } from '../src/pages/control/UsagePro';
import {
  button,
  byLabel,
  change,
  click,
  json,
  render,
  settle,
  installStableFixHooks,
} from './control-pages-stable-fixes.helpers';
import { renderHook } from './domSetup';
import { repositoryOf } from './queue-operations-ui.repository';

// Regression tests for stable control-page fixes (items 6, 8, 9, 10).

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

installStableFixHooks();

beforeEach(() => {
  useConnectionStore.setState({
    baseUrl: 'http://server-a.test',
    agentBaseUrl: 'http://agent-a.test',
    token: '',
    agentToken: '',
    refreshMs: 60_000,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

const fullOverview = {
  ok: true,
  stats: { waiting: 1, active: 0, completed: 3, dlq: 0, totalPushed: 4, totalPulled: 3, uptime: 1 },
  throughput: { pushPerSec: 0, pullPerSec: 0 },
  memory: { heapUsed: 12, rss: 40 },
  crons: { total: 0 },
};

function usageFetch(overview: unknown): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/storage'))
      return Promise.resolve(json({ ok: true, data: { diskFull: false } }));
    if (url.endsWith('/queues/summary')) return Promise.resolve(json([]));
    if (url.endsWith('/dashboard')) return Promise.resolve(json(overview));
    return Promise.resolve(json({ ok: false, error: `Unexpected ${url}` }, 500));
  }) as typeof fetch;
}

describe('UsagePro malformed /dashboard body', () => {
  test('an {ok:true} body without stats renders an error instead of crashing', async () => {
    globalThis.fetch = usageFetch({ ok: true });
    const view = render(createElement(UsagePro));
    await settle(15);
    expect(view.host.textContent).toContain('Malformed /dashboard response');
    expect(view.host.textContent).not.toContain('Heap used');
  });

  test('a body without memory.heapUsed is rejected rather than rendered as NaN', async () => {
    globalThis.fetch = usageFetch({ ...fullOverview, memory: { rss: 40 } });
    const view = render(createElement(UsagePro));
    await settle(15);
    expect(view.host.textContent).toContain('memory.heapUsed is missing');
  });

  test('a complete body still renders the usage page', async () => {
    globalThis.fetch = usageFetch(fullOverview);
    const view = render(createElement(UsagePro));
    await settle(15);
    expect(view.host.textContent).toContain('Heap used');
  });
});

describe('row detail drawer on a WITHOUT ROWID table', () => {
  test('explains that a truncated value is unavailable instead of loading forever', async () => {
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      return Promise.resolve(json({ ok: true, value: 'full' }));
    }) as typeof fetch;
    const view = render(
      createElement(RowDetailDrawer, {
        table: 'kv',
        columns: ['key', 'payload'],
        row: ['k1', 'preview…'],
        rowid: null,
        truncated: [false, true],
        onClose: () => undefined,
      })
    );
    await settle(10);
    expect(view.host.textContent).not.toContain('loading full value');
    expect(view.host.textContent).toContain('this table has no rowid');
    expect(view.host.textContent).toContain('preview…');
    expect(requests).toBe(0);
  });
});

describe('queue group console', () => {
  function renderPanel(repository: QueueOperationsRepository) {
    return render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueueOperationsPanel, { queue: 'orders', repository })
      )
    );
  }

  test('editing Group ID drops the previous group readback that gated Pause/Resume', async () => {
    const view = renderPanel(repositoryOf([]));
    await settle(10);
    click(button(view.host, 'Pause group'));
    await settle(5);
    expect(view.host.textContent).toContain('PausedYes');
    expect(button(view.host, 'Pause group').disabled).toBe(true);

    change(byLabel(view.host, 'Group ID'), 'tenant-b');
    expect(view.host.textContent).not.toContain('PausedYes');
    expect(button(view.host, 'Pause group').disabled).toBe(false);
    expect(button(view.host, 'Resume group').disabled).toBe(false);
  });

  test('invalid rate and concurrency inputs disable their Set buttons with a message', async () => {
    const calls: string[] = [];
    const view = renderPanel(repositoryOf(calls));
    await settle(10);
    change(byLabel(view.host, 'Rate max'), '');
    change(byLabel(view.host, 'Concurrency'), '0');
    expect(button(view.host, 'Set rate limit').disabled).toBe(true);
    expect(button(view.host, 'Set concurrency').disabled).toBe(true);
    expect(view.host.textContent).toContain('Rate max and duration must be positive whole numbers');
    expect(view.host.textContent).toContain('Concurrency must be a positive whole number');
    click(button(view.host, 'Set rate limit'));
    click(button(view.host, 'Set concurrency'));
    await settle(5);
    expect(calls.some((call) => call.startsWith('group-rate:'))).toBe(false);
    expect(calls.some((call) => call.startsWith('group-concurrency:'))).toBe(false);

    change(byLabel(view.host, 'Rate max'), '5');
    expect(button(view.host, 'Set rate limit').disabled).toBe(false);
  });
});

describe('queue depth trend sample period', () => {
  test('reports jobs/sec over the 2 s depth sample period, not per sample', () => {
    const intervals: Array<() => void> = [];
    globalThis.setInterval = ((handler: TimerHandler) => {
      if (typeof handler !== 'function') throw new Error('Expected an interval callback');
      intervals.push(handler as () => void);
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = (() => undefined) as typeof clearInterval;

    const hook = renderHook(
      ({ counts }: { counts: { waiting: number } }) => useQueueDepth('orders', counts),
      { counts: { waiting: 0 } }
    );
    for (const waiting of [0, 4, 8]) {
      hook.rerender({ counts: { waiting } });
      act(() => intervals.at(-1)?.());
    }
    expect(hook.result.current.depth).toEqual([0, 4, 8]);
    // +4 jobs per 2 s sample is +2 jobs/sec (pre-fix: 4, read as 1 Hz samples).
    expect(hook.result.current.trend.slope).toBeCloseTo(2);
    expect(hook.result.current.trend.label).toBe('accumulating');
    hook.unmount();
  });
});
