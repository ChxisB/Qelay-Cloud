import { describe, expect, test } from 'bun:test';
import type { WorkflowStep } from '../src/features/workflows/domain/workflowWire';
import { PayloadView } from '../src/features/workflows/ui/PayloadView';
import { StepTimeline } from '../src/features/workflows/ui/StepTimeline';
import { formatNumber } from '../src/lib/format';
import { button, click } from './control-dom.helpers';
import { mountFlows } from './flow.helpers';
import { demoRepository, flush, installWorkflowHooks, openWorkflows } from './workflow.helpers';

installWorkflowHooks();

const ORDER_STEPS = '/workflows?execution=wf-order-2026-0804&tab=steps';
const SHOW = `Show iterations (${formatNumber(10_000)})`;
const text = (host: ParentNode) => host.textContent ?? '';
const rows = (host: ParentNode, label: string) =>
  host.querySelectorAll(`ul[aria-label^="${label}"] > li`);

describe('workflow steps: a fan-out over ten thousand items', () => {
  test('is one entry with counts, and reads no iteration until asked', async () => {
    const { host, repository } = await openWorkflows(ORDER_STEPS);
    const counts = host.querySelector('dl[aria-label="Iterations of notify-warehouse"]');
    expect(counts?.textContent).toContain(`Iterations${formatNumber(10_000)}`);
    expect(counts?.textContent).toContain(`Completed${formatNumber(9_862)}`);
    expect(counts?.textContent).toContain('Running8');
    expect(counts?.textContent).toContain('Pending120');
    expect(counts?.textContent).toContain('Failed10');
    expect(host.querySelectorAll('ol[aria-label^="Steps"] > li').length).toBeLessThan(20);
    expect(host.querySelector('ul[aria-label^="Iterations of notify-warehouse"]')).toBeNull();
    expect(repository.calls.steps.filter((query) => query.includes('iterationOf'))).toEqual([]);
  });

  test('shows a page of iterations at a time, with the total of all of them', async () => {
    const { host, repository } = await openWorkflows(ORDER_STEPS);
    click(button(host, SHOW));
    await flush();
    expect(repository.calls.steps.at(-1)).toContain('iterationOf=notify-warehouse');
    expect(repository.calls.steps.at(-1)).toContain('limit=25');
    expect(rows(host, 'Iterations of notify-warehouse, page 1')).toHaveLength(25);
    expect(text(host)).toContain(`1–25 of ${formatNumber(10_000)} iterations`);

    click(button(host, 'Next'));
    await flush();
    expect(repository.calls.steps.at(-1)).toContain('offset=25');
    expect(rows(host, 'Iterations of notify-warehouse, page 2')).toHaveLength(25);
    expect(text(host)).toContain(`26–50 of ${formatNumber(10_000)} iterations`);
  });

  test('a status narrows the iterations to the failed ones, from the first page', async () => {
    const { host, repository } = await openWorkflows(ORDER_STEPS);
    click(button(host, SHOW));
    await flush();
    click(button(host, 'Next'));
    await flush();
    click(button(host, 'failed'));
    await flush();
    expect(repository.calls.steps.at(-1)).toContain('status=failed');
    expect(repository.calls.steps.at(-1)).toContain('offset=0');
    expect(rows(host, 'Iterations of notify-warehouse, page 1')).toHaveLength(10);
    expect(text(host)).not.toContain(`of ${formatNumber(10_000)} iterations`);
  });

  test('hiding the iterations leaves the counts', async () => {
    const { host } = await openWorkflows(ORDER_STEPS);
    click(button(host, SHOW));
    await flush();
    click(button(host, 'Hide iterations'));
    await flush();
    expect(host.querySelector('ul[aria-label^="Iterations of notify-warehouse"]')).toBeNull();
    expect(text(host)).toContain(`Completed${formatNumber(9_862)}`);
  });
});

describe('workflow payloads: what the server cut', () => {
  const marker = { $type: 'truncated', kind: 'string', length: 900_000, maxBytes: 65_536 };

  test('a value with a marker in it says it was cut, at any depth', () => {
    const cut = mountFlows(<PayloadView value={{ lines: [{ note: marker }] }} />);
    expect(cut.host.querySelector('[role="note"]')?.textContent).toContain('cut');
    const whole = mountFlows(<PayloadView value={{ lines: [{ note: 'ok' }] }} />);
    expect(whole.host.querySelector('[role="note"]')).toBeNull();
  });

  test('a value the server flagged is cut even without a marker, and nothing says "None"', () => {
    const { host } = mountFlows(<PayloadView value={{ a: 1 }} truncated />);
    expect(host.querySelector('[role="note"]')).not.toBeNull();
    expect(mountFlows(<PayloadView value={null} />).host.textContent).toBe('None');
    expect(mountFlows(<PayloadView value={{}} empty="No data" />).host.textContent).toBe('No data');
  });

  test('a step result and error that were cut say so beside them', async () => {
    const step: WorkflowStep = {
      name: 'charge',
      status: 'failed',
      attempts: 3,
      startedAt: 1_800_000_000_000,
      completedAt: null,
      durationMs: 1_200,
      compensatable: true,
      error: 'upstream said: xxxxxxxx',
      errorTruncated: true,
      result: { receipt: marker },
      resultTruncated: true,
      childExecutionId: null,
      compensation: null,
      loopIndex: null,
    };
    const { host } = mountFlows(
      <StepTimeline
        repository={demoRepository()}
        executionId="wf-order-2026-0804"
        first={{ items: [step], total: 1, limit: 50, offset: 0, hasMore: false }}
      />
    );
    await flush();
    expect(text(host)).toContain('(cut at the size limit)');
    expect(host.querySelector('details [role="note"]')?.textContent).toContain('cut');
  });
});
