import { describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import type { WorkflowExecution } from '../src/features/workflows/domain/workflowWire';
import { ExecutionActions } from '../src/features/workflows/ui/ExecutionActions';
import { demoWorkflowReply } from '../src/lib/demo/workflows';
import { button, changeControl, click, field } from './control-dom.helpers';
import { mountFlows, serveRole } from './flow.helpers';
import { demoRepository, flush, installWorkflowHooks, openWorkflows } from './workflow.helpers';

installWorkflowHooks();

const ORDER = '/workflows?execution=wf-order-2026-0804';
const SIGNUP = '/workflows?execution=wf-signup-2026-0802';
const REFUND = '/workflows?execution=wf-refund-2026-0803';

const buttonTexts = (host: ParentNode) =>
  [...host.querySelectorAll('section[aria-label="Execution actions"] button')].map(
    (item) => item.textContent
  );
const form = (host: ParentNode, label: string) => {
  const found = host.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`);
  if (!found) throw new Error(`No form ${label}`);
  return found;
};
const submit = (formElement: HTMLFormElement) =>
  act(() => {
    formElement.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
const text = (host: ParentNode) => host.textContent ?? '';

describe('workflow actions: who gets buttons', () => {
  test('an operator is offered the actions the server lists for the state', async () => {
    expect(buttonTexts((await openWorkflows(ORDER)).host)).toEqual(['Send signal…', 'Cancel run…']);
    expect(buttonTexts((await openWorkflows(REFUND)).host)).toEqual([
      'Retry rollback',
      'Abandon rollback…',
    ]);
  });

  test('a finished run offers nothing and says why', async () => {
    const { host } = await openWorkflows('/workflows?execution=wf-month-close-2026-07');
    expect(buttonTexts(host)).toEqual([]);
    expect(text(host)).toContain('Nothing can be done to this run in its state (completed).');
  });

  test('a viewer sees the run and no buttons', async () => {
    serveRole('viewer');
    const { host } = await openWorkflows(ORDER);
    expect(text(host)).toContain('wf-order-2026-0804');
    expect(buttonTexts(host)).toEqual([]);
    expect(text(host)).toContain('Your role can look at workflow executions but not change them.');
  });
});

describe('workflow actions: signal', () => {
  test('sends the awaited event at the version shown, then shows the run moving on', async () => {
    const { host, repository } = await openWorkflows(SIGNUP);
    click(button(host, 'Send signal'));
    const signal = form(host, 'Send a signal');
    expect(signal.querySelector<HTMLInputElement>('input[name="signal-event"]')!.value).toBe(
      'email-verified'
    );
    submit(signal);
    await flush();
    expect(repository.calls.acts).toEqual([
      {
        id: 'wf-signup-2026-0802',
        body: { action: 'signal', expectedVersion: 3, event: 'email-verified' },
      },
    ]);
    expect(text(host)).toContain('The signal was recorded');
    expect(repository.calls.details.length).toBeGreaterThan(1);
  });

  test('a payload that is not JSON is refused before anything is sent', async () => {
    const { host, repository } = await openWorkflows(SIGNUP);
    click(button(host, 'Send signal'));
    const signal = form(host, 'Send a signal');
    changeControl(signal.querySelector('textarea')!, '{ nope');
    submit(signal);
    await flush();
    expect(signal.querySelector('[role="alert"]')?.textContent).toContain('JSON');
    expect(repository.calls.acts).toEqual([]);
  });
});

describe('workflow actions: destructive ones', () => {
  test('cancel waits for the run id to be typed, then sends it as the confirmation', async () => {
    const { host, repository } = await openWorkflows(ORDER);
    click(button(host, 'Cancel run'));
    const confirm = form(host, 'Confirm: Cancel run');
    const send = confirm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(send.disabled).toBe(true);
    submit(confirm);
    await flush();
    expect(repository.calls.acts).toEqual([]);

    changeControl(
      field<HTMLInputElement>(confirm, 'Type the execution id to confirm'),
      'wf-order-2026-0804'
    );
    expect(send.disabled).toBe(false);
    submit(confirm);
    await flush();
    expect(repository.calls.acts).toEqual([
      {
        id: 'wf-order-2026-0804',
        body: { action: 'cancel', expectedVersion: 7, confirm: 'wf-order-2026-0804' },
      },
    ]);
    expect(text(host)).toContain('The run was cancelled');
    expect(text(host)).toContain('Cancelled by an operator');
  });

  test('retrying a rollback needs no typing and sends the version shown', async () => {
    const { host, repository } = await openWorkflows(REFUND);
    click(button(host, 'Retry rollback'));
    await flush();
    expect(repository.calls.acts[0]?.body).toEqual({
      action: 'retry-compensation',
      expectedVersion: 9,
    });
  });
});

describe('workflow actions: a run that moved', () => {
  test('is refused, nothing changes, and the run is read again', async () => {
    const { host, repository } = await openWorkflows(ORDER);
    click(button(host, 'Cancel run'));
    // Someone else signals the run after this operator read it.
    demoWorkflowReply(['workflows', 'executions', 'wf-order-2026-0804', 'actions'], 'POST', '', {
      action: 'signal',
      expectedVersion: 7,
      event: 'note',
    });
    const confirm = form(host, 'Confirm: Cancel run');
    changeControl(
      field<HTMLInputElement>(confirm, 'Type the execution id to confirm'),
      'wf-order-2026-0804'
    );
    submit(confirm);
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'changed while you were looking'
    );
    const run = (await repository.detail('wf-order-2026-0804', 10)).execution;
    expect(run.state).toBe('running');
    expect(run.version).toBe(8);
  });

  test('an open form keeps the version it was opened at, whatever the page reads meanwhile', async () => {
    const execution = (await demoRepository().detail('wf-order-2026-0804', 10)).execution;
    const sent: unknown[] = [];
    let bump = () => {};
    function Harness() {
      const [current, setCurrent] = useState<WorkflowExecution>(execution);
      bump = () => setCurrent((previous) => ({ ...previous, version: previous.version + 1 }));
      return (
        <ExecutionActions
          execution={current}
          pending={null}
          notice={null}
          onAction={async (body) => {
            sent.push(body);
            return true;
          }}
          onDismissNotice={() => {}}
        />
      );
    }
    const { host } = mountFlows(<Harness />);
    click(button(host, 'Cancel run'));
    act(() => bump());
    const confirm = form(host, 'Confirm: Cancel run');
    changeControl(
      field<HTMLInputElement>(confirm, 'Type the execution id to confirm'),
      execution.id
    );
    submit(confirm);
    await flush();
    expect(sent).toEqual([
      { action: 'cancel', expectedVersion: execution.version, confirm: execution.id },
    ]);
  });
});
