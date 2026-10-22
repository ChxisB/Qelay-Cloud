import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Th } from '../src/components/ui/Table';
import { FlowList } from '../src/features/flows/ui/FlowList';
import { ExecutionList } from '../src/features/workflows/ui/ExecutionList';
import { JobStateTabs } from '../src/pages/control/jobsPro/JobStateTabs';
import { ensureDom } from './domSetup';
import { flowList } from './flow.helpers';

const mounted: Array<() => void> = [];

function render(element: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, {}, element)));
  mounted.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

// Assembled from parts: Tailwind scans test/ too, and a literal would emit a dead utility.
const bar = (v: string) => ['[--rc:var(--', v, ')]'].join('');
const align = (side: string) => ['text', side].join('-');

beforeEach(() => ensureDom());
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

describe('Th alignment', () => {
  test('a header carries one alignment: left by default, right for a numeric column', () => {
    const host = render(
      createElement(
        'table',
        {},
        createElement(
          'thead',
          {},
          createElement('tr', {}, [
            createElement(Th, { key: 'a' }, 'Name'),
            createElement(Th, { key: 'b', right: true }, 'Runs'),
          ])
        )
      )
    );
    const [name, runs] = [...host.querySelectorAll('th')];
    expect(name?.classList.contains(align('left'))).toBe(true);
    expect(name?.classList.contains(align('right'))).toBe(false);
    expect(runs?.classList.contains(align('right'))).toBe(true);
    expect(runs?.classList.contains(align('left'))).toBe(false);
  });
});

describe('Jobs state tiles', () => {
  const counts = { waiting: 4, prioritized: 0, active: 2, delayed: 0, completed: 9, failed: 3 };

  test('each tile names its state, shows its count, and the chosen one is pressed', () => {
    const picked: string[] = [];
    const host = render(
      createElement(JobStateTabs, {
        status: 'failed',
        counts,
        onStatus: (s: string) => picked.push(s),
      })
    );
    const tiles = [...host.querySelectorAll('button')];
    const failed = tiles.find((b) => b.textContent?.startsWith('Failed'));
    expect(failed?.getAttribute('aria-pressed')).toBe('true');
    expect(failed?.textContent).toContain('3');
    expect(tiles.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    act(() => tiles.find((b) => b.textContent?.startsWith('Active'))?.click());
    expect(picked).toEqual(['active']);
  });

  test('a state the server does not count shows no number, not a zero', () => {
    const host = render(createElement(JobStateTabs, { status: 'all', counts, onStatus: () => {} }));
    const paused = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Paused');
    expect(paused).toBeDefined();
    expect(paused?.querySelector('b')).toBeNull();
  });
});

describe('Flow list', () => {
  test('a flow with a stuck child has a bar, a state word and the stuck count', () => {
    const host = render(
      createElement(FlowList, { list: flowList(), page: 0, onPage: () => {}, onOpen: () => {} })
    );
    const row = host.querySelector('tbody tr') as HTMLElement;
    expect(row.className).toContain(bar('bad'));
    expect(row.textContent).toContain('waiting-children');
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).toContain('1 stuck');
  });
});

describe('Workflow executions', () => {
  const run = (id: string, state: string) => ({
    id,
    workflowName: 'checkout',
    state,
    currentNodeIndex: 0,
    parentExecutionId: null,
    wait: null,
    failureReason: null,
    updatedAt: 1_800_000_000_000,
  });

  test('a stuck rollback has the failed bar, a running one does not', () => {
    const list = {
      executions: [run('r1', 'compensation-stuck'), run('r2', 'running')],
      total: 2,
      limit: 25,
      offset: 0,
      workflows: [],
    };
    const host = render(
      createElement(ExecutionList, {
        list: list as never,
        filtered: false,
        onPage: () => {},
        onOpen: () => {},
      })
    );
    const [stuck, running] = [...host.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(stuck?.className).toContain(bar('bad'));
    expect(stuck?.textContent).toContain('compensation-stuck');
    expect(running?.className).not.toContain(bar('bad'));
  });
});
