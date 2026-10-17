import { describe, expect, test } from 'bun:test';
import { FlowPage } from '../src/features/flows/ui/FlowPage';
import { BqError } from '../src/lib/bq';
import { button, changeControl, click, field } from './control-dom.helpers';
import { installPageHooks, flush, openStuck } from './flow-page.helpers';
import { fakeRepository, flowView, mountFlows, node, treeRow } from './flow.helpers';

installPageHooks();

describe('flow page: release a parent', () => {
  test('asks first, then releases the parent with its failed children at the versions shown', async () => {
    const { host, repository } = await openStuck({
      act: () => ({
        action: 'promote',
        changes: [{ id: 'root', queue: 'orders', from: 'waiting-children', to: 'waiting' }],
      }),
    });
    click(treeRow(host, 'root'));
    await flush();
    click(button(host, 'Release this parent'));
    expect(host.querySelector('[aria-label="Confirm release"]')?.textContent).toContain(
      'Its failed children stay failed'
    );
    expect(repository.calls.acts).toHaveLength(0);
    click(button(host, 'Release parent'));
    await flush();
    expect(repository.calls.acts).toEqual([
      {
        root: 'root',
        body: {
          action: 'promote',
          parent: 'root',
          jobs: [
            { id: 'root', expectedVersion: 4 },
            { id: 'bad', expectedVersion: 5 },
          ],
        },
      },
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'The parent was released.'
    );
    expect(repository.calls.views).toHaveLength(2);
  });

  test('cancelling the question sends nothing', async () => {
    const { host, repository } = await openStuck();
    click(treeRow(host, 'root'));
    await flush();
    click(button(host, 'Release this parent'));
    click(button(host, 'Cancel'));
    expect(host.querySelector('[aria-label="Confirm release"]')).toBeNull();
    expect(repository.calls.acts).toHaveLength(0);
  });

  test('a parent still waiting on running children cannot be released, and says why', async () => {
    const repository = fakeRepository({
      view: () =>
        flowView([
          node('r', { state: 'waiting-children', version: 2 }),
          node('f', { parentId: 'r', depth: 1, state: 'failed', blocking: true, version: 3 }),
          node('a', { parentId: 'r', depth: 1, state: 'active', version: 1 }),
        ]),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r&node=r');
    await flush();
    expect(button(host, 'Release this parent').disabled).toBe(true);
    expect(host.textContent).toContain('1 child has not finished');
  });
});

describe('flow page: remove', () => {
  test('is confirmed by typing the root id, then removes the flow and goes back to the list', async () => {
    const { host, repository, search } = await openStuck({
      act: () => ({
        action: 'remove',
        changes: [
          { id: 'root', queue: 'orders', from: 'waiting-children', to: 'removed' },
          { id: 'ok', queue: 'orders', from: 'completed', to: 'removed' },
          { id: 'bad', queue: 'orders', from: 'failed', to: 'removed' },
        ],
      }),
    });
    click(button(host, 'Remove flow…'));
    const form = host.querySelector('form[aria-label="Confirm removal of the flow"]')!;
    const input = field<HTMLInputElement>(host, 'Type the root job ID to confirm');
    const submit = button(form as HTMLElement, 'Remove flow');
    expect(form.textContent).toContain('This deletes all 3 jobs of the flow');
    expect(submit.disabled).toBe(true);
    changeControl(input, 'roo');
    expect(submit.disabled).toBe(true);
    changeControl(input, 'root');
    expect(submit.disabled).toBe(false);
    click(submit);
    await flush();
    expect(repository.calls.acts).toEqual([
      {
        root: 'root',
        body: {
          action: 'remove',
          confirm: 'root',
          jobs: [
            { id: 'root', expectedVersion: 4 },
            { id: 'ok', expectedVersion: 3 },
            { id: 'bad', expectedVersion: 5 },
          ],
        },
      },
    ]);
    expect(search()).toBe('');
    expect(repository.calls.lists).toHaveLength(2);
    expect(host.querySelector('tbody tr')?.textContent).toContain('process-order');
  });

  test('cancelling the confirmation sends nothing and clears what was typed', async () => {
    const { host, repository } = await openStuck();
    click(button(host, 'Remove flow…'));
    changeControl(field<HTMLInputElement>(host, 'Type the root job ID to confirm'), 'root');
    click(button(host, 'Cancel'));
    expect(host.querySelector('form[aria-label="Confirm removal of the flow"]')).toBeNull();
    click(button(host, 'Remove flow…'));
    expect(field<HTMLInputElement>(host, 'Type the root job ID to confirm').value).toBe('');
    expect(repository.calls.acts).toHaveLength(0);
  });

  test('a flow with a running job cannot be removed, and says how many are running', async () => {
    const repository = fakeRepository({
      view: () =>
        flowView([
          node('r', { state: 'waiting-children' }),
          node('a', { parentId: 'r', depth: 1, state: 'active' }),
          node('b', { parentId: 'r', depth: 1, state: 'active' }),
        ]),
    });
    const { host } = mountFlows(<FlowPage repository={repository} />, '/flows?root=r');
    await flush();
    expect(button(host, 'Remove flow…').disabled).toBe(true);
    expect(host.textContent).toContain('2 jobs are running. Wait for them to finish.');
  });

  test('a refusal because jobs run keeps the flow in view and reloads it', async () => {
    const { host, repository, search } = await openStuck({
      act: () => {
        throw new BqError('active', 409, 'flow_active');
      },
    });
    click(button(host, 'Remove flow…'));
    changeControl(field<HTMLInputElement>(host, 'Type the root job ID to confirm'), 'root');
    click(button(host, 'Remove flow'));
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Jobs of the flow are running'
    );
    expect(search()).toBe('?root=root');
    expect(repository.calls.views).toHaveLength(2);
  });
});
