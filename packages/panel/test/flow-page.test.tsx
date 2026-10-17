import { describe, expect, test } from 'bun:test';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { BqError } from '../src/lib/bq';
import { button, changeControl, click, field } from './control-dom.helpers';
import { installPageHooks, flush, stuckRepo, openStuck } from './flow-page.helpers';
import {
  fakeRepository,
  flowList,
  flowView,
  mountFlows,
  node,
  stuckFlow,
  syntheticFlow,
  treeRow,
  treeRows,
} from './flow.helpers';

installPageHooks();

describe('flow page: the list', () => {
  test('lists the flows and says which is stuck, then opens one into the address', async () => {
    const repository = fakeRepository({ view: () => stuckFlow() });
    const { host, search } = mountFlows(<FlowPage repository={repository} />);
    await flush();
    expect(host.querySelector('h1')?.textContent).toBe('Job Flows');
    const row = host.querySelector('tbody tr')!;
    expect(row.textContent).toContain('process-order');
    expect(row.textContent).toContain('1 stuck');
    expect(repository.calls.lists).toEqual([{ limit: 25, offset: 0 }]);

    click(row.querySelector('button')!);
    await flush();
    expect(search()).toBe('?root=root');
    expect(repository.calls.views).toEqual([{ root: 'root', limit: 1000 }]);
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'ok', 'bad']);
  });

  test('says there are no flows when the namespace has none', async () => {
    const repository = fakeRepository({ list: () => flowList({ flows: [], total: 0 }) });
    const { host } = mountFlows(<FlowPage repository={repository} />);
    await flush();
    expect(host.textContent).toContain('No flows yet');
    expect(host.querySelector('table')).toBeNull();
  });

  test('shows a list that failed to load with a way to try again', async () => {
    let fail = true;
    const repository = fakeRepository({
      list: () => {
        if (fail) throw new BqError('Database is down', 503, 'unavailable');
        return flowList();
      },
    });
    const { host } = mountFlows(<FlowPage repository={repository} />);
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Database is down');
    expect(host.querySelector('table')).toBeNull();
    fail = false;
    click(button(host.querySelector('[role="alert"]') as HTMLElement, 'Retry'));
    await flush();
    expect(host.querySelector('tbody tr')?.textContent).toContain('process-order');
  });

  test('pages through the flows', async () => {
    const repository = fakeRepository({ list: () => flowList({ total: 60 }) });
    const { host } = mountFlows(<FlowPage repository={repository} />);
    await flush();
    click(button(host, 'Next'));
    await flush();
    expect(repository.calls.lists.at(-1)).toEqual({ limit: 25, offset: 25 });
  });

  test('asks for a job id before it opens anything, and refuses an id that cannot be a path', async () => {
    const repository = stuckRepo();
    const { host, search } = mountFlows(<FlowPage repository={repository} />);
    await flush();
    const input = field<HTMLInputElement>(host, 'Job ID');
    expect(button(host, 'Open flow').disabled).toBe(true);
    changeControl(input, '..');
    expect(button(host, 'Open flow').disabled).toBe(false);
    click(button(host, 'Open flow'));
    await flush();
    expect(host.textContent).toContain('path traversal');
    expect(search()).toBe('');
    changeControl(input, ' root ');
    click(button(host, 'Open flow'));
    await flush();
    expect(search()).toBe('?root=root');
    expect(repository.calls.views[0]).toEqual({ root: 'root', limit: 1000 });
  });
});

describe('flow page: the tree', () => {
  test('shows each job with its state, and the one that holds its parent back', async () => {
    const { host } = await openStuck();
    expect(treeRows(host)).toEqual([
      ['root', 'waiting-children'],
      ['ok', 'completed'],
      ['bad', 'failed'],
    ]);
    expect(treeRow(host, 'bad').textContent).toContain('holds parent');
    expect(host.textContent).toContain('3 jobs');
    expect(host.textContent).toContain('1 failed');
    expect(host.textContent).toContain('Needs attention (1)');
    // Nothing is selected in the address, so the panel shows the root.
    const panel = host.querySelector('aside[aria-label="Selected job"]')!;
    expect(panel.textContent).toContain('waiting-children');
    expect(panel.textContent).toContain('2 children');
    expect(treeRow(host, 'root').getAttribute('aria-selected')).toBe('true');
  });

  test('selecting a job puts it in the address and shows what is known of it', async () => {
    const { host, search } = await openStuck();
    click(treeRow(host, 'bad'));
    await flush();
    expect(search()).toBe('?root=root&node=bad');
    const panel = host.querySelector('aside[aria-label="Selected job"]')!;
    expect(panel.textContent).toContain('SMTP 550: mailbox unavailable');
    expect(panel.textContent).toContain('It failed and holds its parent back');
    expect(panel.textContent).toContain('Attempts3');
    expect(panel.querySelector('a')?.getAttribute('href')).toBe('/job?id=bad');
    expect(treeRow(host, 'bad').getAttribute('aria-selected')).toBe('true');
  });

  test('selecting jobs does not read the flow again', async () => {
    const { host, repository } = await openStuck();
    click(treeRow(host, 'ok'));
    await flush();
    click(treeRow(host, 'bad'));
    await flush();
    click(treeRow(host, 'root'));
    await flush();
    expect(repository.calls.views).toHaveLength(1);
  });

  test('a job named in the address is selected when the flow opens', async () => {
    const repository = stuckRepo();
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=root&node=ok');
    await flush();
    expect(treeRow(host, 'ok').getAttribute('aria-selected')).toBe('true');
  });

  test('a job that is not in the flow is dropped from the address', async () => {
    const repository = stuckRepo();
    const { host, search } = mountFlows(
      <FlowPage repository={repository} />,
      '/flows?root=root&node=ghost'
    );
    await flush();
    expect(search()).toBe('?root=root');
    expect(treeRow(host, 'root').getAttribute('aria-selected')).toBe('true');
  });

  test('the attention filter keeps the jobs that need it, and shows them all again', async () => {
    const { host } = await openStuck();
    click(button(host, 'Needs attention'));
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'bad']);
    expect(button(host, 'Show all jobs').getAttribute('aria-pressed')).toBe('true');
    click(button(host, 'Show all jobs'));
    expect(treeRows(host)).toHaveLength(3);
  });

  test('a filter with nothing to show says so', async () => {
    const repository = fakeRepository({
      view: () => flowView([node('r'), node('c', { parentId: 'r', depth: 1 })]),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r');
    await flush();
    click(button(host, 'Needs attention (0)'));
    expect(host.textContent).toContain('No job of this flow needs attention.');
  });

  test('collapse all and expand all shut and open every parent', async () => {
    const { host } = await openStuck();
    click(button(host, 'Collapse all'));
    expect(treeRows(host).map(([id]) => id)).toEqual(['root']);
    click(button(host, 'Expand all'));
    expect(treeRows(host)).toHaveLength(3);
  });

  test('going back to all flows clears the address', async () => {
    const { host, search } = await openStuck();
    click(button(host, 'All flows'));
    await flush();
    expect(search()).toBe('');
    expect(host.querySelector('tbody tr')?.textContent).toContain('process-order');
  });

  test('refresh reads the flow again and keeps what was open and selected', async () => {
    const { host, repository } = await openStuck();
    click(treeRow(host, 'bad'));
    click(button(host, 'Collapse all'));
    await flush();
    click(button(host, 'Refresh'));
    await flush();
    expect(repository.calls.views).toHaveLength(2);
    expect(treeRows(host).map(([id]) => id)).toEqual(['root', 'ok', 'bad']);
    expect(treeRow(host, 'bad').getAttribute('aria-selected')).toBe('true');
  });

  test('a 5,000 job flow opens without drawing 5,000 lines', async () => {
    const repository = fakeRepository({ view: () => syntheticFlow(5_000) });
    const started = performance.now();
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=n0');
    await flush();
    click(button(host, 'Expand all'));
    const elapsed = performance.now() - started;
    expect(host.textContent).toMatch(/5[.,\u00a0\u202f]?000 jobs/);
    expect(treeRows(host).length).toBeLessThanOrEqual(30);
    expect(host.textContent).toContain('Needs attention (1)');
    expect(elapsed).toBeLessThan(5_000);
  });
});
