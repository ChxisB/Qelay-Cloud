import { describe, expect, test } from 'bun:test';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { BqError } from '../src/lib/bq';
import { button, click, deferred } from './control-dom.helpers';
import { installPageHooks, flush, openStuck } from './flow-page.helpers';
import {
  fakeRepository,
  flowView,
  mountFlows,
  node,
  stuckFlow,
  treeRow,
  treeRows,
} from './flow.helpers';

installPageHooks();

describe('flow page: retry', () => {
  test('retries one failed job at the version shown, then reads the flow again', async () => {
    let calls = 0;
    const { host, repository } = await openStuck({
      view: () => {
        calls += 1;
        if (calls === 1) return stuckFlow();
        return flowView([
          node('root', { state: 'waiting-children', version: 6, attempts: 0 }),
          node('ok', { parentId: 'root', depth: 1 }),
          node('bad', { parentId: 'root', depth: 1, state: 'waiting', version: 6 }),
        ]);
      },
      act: () => ({
        action: 'retry-failed',
        changes: [{ id: 'bad', queue: 'orders', from: 'failed', to: 'waiting' }],
      }),
    });
    click(treeRow(host, 'bad'));
    await flush();
    click(button(host, 'Retry this job'));
    await flush();
    expect(repository.calls.acts).toEqual([
      {
        root: 'root',
        body: { action: 'retry-failed', jobs: [{ id: 'bad', expectedVersion: 5 }] },
      },
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      '1 job was put back on its queue'
    );
    expect(repository.calls.views).toHaveLength(2);
    expect(treeRows(host)).toContainEqual(['bad', 'waiting']);
  });

  test('retry all failed sends every job that holds a parent', async () => {
    const repository = fakeRepository({
      view: () =>
        flowView([
          node('r', { state: 'waiting-children', version: 2 }),
          node('f1', { parentId: 'r', depth: 1, state: 'failed', blocking: true, version: 7 }),
          node('f2', { parentId: 'r', depth: 1, state: 'failed', blocking: true, version: 9 }),
        ]),
      act: () => ({ action: 'retry-failed', changes: [] }),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r');
    await flush();
    click(button(host, 'Retry all failed (2)'));
    await flush();
    expect(repository.calls.acts[0]?.body).toEqual({
      action: 'retry-failed',
      jobs: [
        { id: 'f1', expectedVersion: 7 },
        { id: 'f2', expectedVersion: 9 },
      ],
    });
  });

  test('offers no retry when nothing holds a parent, and says why for a job', async () => {
    const repository = fakeRepository({
      view: () =>
        flowView([
          node('r', { state: 'waiting-children' }),
          node('f', { parentId: 'r', depth: 1, state: 'failed', mode: 'ignore' }),
        ]),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r&node=f');
    await flush();
    expect(button(host, 'Retry all failed (0)').disabled).toBe(true);
    expect(button(host, 'Retry this job').disabled).toBe(true);
    expect(host.textContent).toContain('does not hold its parent back');
  });

  test('a flow that changed since it was read is refused, said so, and read again', async () => {
    const { host, repository } = await openStuck({
      act: () => {
        throw new BqError('stale', 409, 'flow_changed');
      },
    });
    click(treeRow(host, 'bad'));
    await flush();
    click(button(host, 'Retry this job'));
    await flush();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(
      'The flow changed since it was loaded, so nothing was changed.'
    );
    expect(alert.textContent).toContain('The flow was reloaded.');
    expect(repository.calls.views).toHaveLength(2);
    // The refusal is dismissed with its button.
    click(button(alert as HTMLElement, 'Dismiss'));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test('an error that is not about staleness is shown without reloading', async () => {
    const { host, repository } = await openStuck({
      act: () => {
        throw new BqError('Database is busy', 503, 'unavailable');
      },
    });
    click(treeRow(host, 'bad'));
    await flush();
    click(button(host, 'Retry this job'));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Database is busy');
    expect(repository.calls.views).toHaveLength(1);
  });

  test('a second click while one action runs does nothing', async () => {
    const gate = deferred<{ action: 'retry-failed'; changes: [] }>();
    const { host, repository } = await openStuck({ act: () => gate.promise });
    click(treeRow(host, 'bad'));
    await flush();
    click(button(host, 'Retry this job'));
    expect(button(host, 'Retrying…').disabled).toBe(true);
    click(button(host, 'Retrying…'));
    gate.resolve({ action: 'retry-failed', changes: [] });
    await flush();
    expect(repository.calls.acts).toHaveLength(1);
  });
});
