import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { WorkflowRepository } from '../src/features/workflows/application/WorkflowRepository';
import { controlWorkflowRepository } from '../src/features/workflows/infrastructure/controlWorkflowRepository';
import { assertCurrentServerRequestTarget, captureServerRequestTarget } from '../src/lib/bq';
import { button, click } from './control-dom.helpers';
import { connectTo } from './flow.helpers';
import { demoRepository, flush, installWorkflowHooks, openWorkflows } from './workflow.helpers';

installWorkflowHooks();

const SIGNUP = '/workflows?execution=wf-signup-2026-0802';

/** Reads from the demo's runs; an action first checks the connection it was read from, as the real repository does. */
function guarded(): WorkflowRepository & { sent: number } {
  const inner = demoRepository();
  const repository = {
    ...inner,
    sent: 0,
    async act(...args: Parameters<WorkflowRepository['act']>) {
      assertCurrentServerRequestTarget(args[0]);
      repository.sent += 1;
      return inner.act(...args);
    },
  };
  return repository;
}

describe('workflow actions across a change of connection', () => {
  // The page's own guard drops the action; the repository's check is the second line of defence.
  test('are not sent when the connection changed after the run was read', async () => {
    const repository = guarded();
    const { host } = await openWorkflows(SIGNUP, repository);
    click(button(host, 'Send signal'));
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Send a signal"]')!;
    // The connection changes between the form opening and it being sent, before the page has read again.
    act(() => connectTo('http://server-b.test'));
    act(() => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(repository.sent).toBe(0);
    expect(host.textContent).not.toContain('The signal was recorded');
  });

  test('the real repository checks the connection before it calls the server', async () => {
    const target = captureServerRequestTarget();
    connectTo('http://server-b.test');
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return Promise.reject(new Error('no network in this test'));
    }) as typeof fetch;
    try {
      await expect(
        controlWorkflowRepository.act(target, 'wf-1', { action: 'recover', expectedVersion: 1 })
      ).rejects.toThrow('Server connection changed');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
  });
});
