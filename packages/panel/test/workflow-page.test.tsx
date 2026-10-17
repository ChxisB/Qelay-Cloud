import { describe, expect, test } from 'bun:test';
import { button, changeControl, click } from './control-dom.helpers';
import { flush, installWorkflowHooks, openWorkflows } from './workflow.helpers';

installWorkflowHooks();

describe('workflows page: list', () => {
  test('lists the executions with their state, and the workflows with counts', async () => {
    const { host } = await openWorkflows();
    const ids = [...host.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('td')?.textContent
    );
    expect(ids).toHaveLength(5);
    expect(host.textContent).toContain('order-fulfillment');
    expect(host.textContent).toContain('Waiting for email-verified');
    expect(host.querySelector('[aria-label="order-fulfillment runs by state"]')).not.toBeNull();
  });

  test('choosing a state narrows the list and the address, and the address restores it', async () => {
    const { host, search } = await openWorkflows();
    changeControl(
      host.querySelector<HTMLSelectElement>('select[name="state"]')!,
      'compensation-stuck'
    );
    await flush();
    expect(search()).toBe('?state=compensation-stuck');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);

    const reopened = await openWorkflows('/workflows?workflow=legacy-import');
    expect(reopened.host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(reopened.repository.calls.lists[0]).toContain('name=legacy-import');
  });

  test('an unknown execution says so and leads back to the list', async () => {
    const { host, search } = await openWorkflows('/workflows?execution=nope');
    expect(host.textContent).toContain('This execution does not exist');
    click(button(host, 'Back to the list'));
    await flush();
    expect(search()).toBe('');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
  });
});
