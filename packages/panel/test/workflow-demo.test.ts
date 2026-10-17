import { beforeEach, describe, expect, test } from 'bun:test';
import {
  parseWorkflowActionResult,
  parseWorkflowDetail,
  parseWorkflowList,
  parseWorkflowSteps,
} from '../src/features/workflows/domain/workflowWire';
import { demoWorkflowReply, resetDemoWorkflows } from '../src/lib/demo/workflows';

const get = (path: string, search = '') =>
  demoWorkflowReply(['workflows', ...path.split('/').filter(Boolean)], 'GET', search);
const post = (id: string, body: unknown) =>
  demoWorkflowReply(['workflows', 'executions', id, 'actions'], 'POST', '', body);

beforeEach(resetDemoWorkflows);

describe('demo workflows speak the Control API wire', () => {
  test('the list, a detail and a page of steps all parse with the panel parsers', () => {
    const list = parseWorkflowList(get('').body);
    expect(list.total).toBe(5);
    expect(list.workflows.map((w) => w.name)).toEqual([
      'customer-onboarding',
      'legacy-import',
      'month-end-close',
      'order-fulfillment',
      'refund-order',
    ]);
    const detail = parseWorkflowDetail(get('executions/wf-order-2026-0804').body);
    expect(detail.execution.actions).toEqual(['signal', 'cancel']);
    expect(detail.definition?.graph.length).toBeGreaterThan(0);
    expect(parseWorkflowSteps(get('executions/wf-order-2026-0804/steps').body).items).toHaveLength(
      4
    );
  });

  test('filters by workflow and state, and pages', () => {
    const stuck = parseWorkflowList(get('', '?state=compensation-stuck').body);
    expect(stuck.executions.map((e) => e.id)).toEqual(['wf-refund-2026-0803']);
    const named = parseWorkflowList(get('', '?name=legacy-import').body);
    expect(named.total).toBe(1);
    const first = parseWorkflowList(get('', '?limit=2&offset=0').body);
    expect(first.executions).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const last = parseWorkflowList(get('', '?limit=2&offset=4').body);
    expect(last.executions).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  test('a 10,000-item for-each is one step with counts, and its iterations come a page at a time', () => {
    const detail = parseWorkflowDetail(get('executions/wf-order-2026-0804').body);
    const fan = detail.steps.items.find((step) => step.fanOut);
    expect(fan?.fanOut?.iterations).toBe(10_000);
    expect(detail.steps.total).toBeLessThan(10);
    const page = parseWorkflowSteps(
      get(
        'executions/wf-order-2026-0804/steps',
        '?iterationOf=notify-warehouse&limit=25&offset=9975'
      ).body
    );
    expect(page.total).toBe(10_000);
    expect(page.items).toHaveLength(25);
    expect(page.hasMore).toBe(false);
    const failed = parseWorkflowSteps(
      get('executions/wf-order-2026-0804/steps', '?iterationOf=notify-warehouse&status=failed').body
    );
    expect(failed.total).toBe(fan?.fanOut?.byStatus.failed);
  });
});

describe('demo workflow actions', () => {
  test('a stale version is refused with the actual one and nothing changes', () => {
    const reply = post('wf-signup-2026-0802', {
      action: 'signal',
      expectedVersion: 1,
      event: 'email-verified',
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'version_conflict', details: { actualVersion: 3 } });
    expect(parseWorkflowDetail(get('executions/wf-signup-2026-0802').body).execution.state).toBe(
      'waiting'
    );
  });

  test('a signal that is awaited resumes the run and moves its version', () => {
    const reply = post('wf-signup-2026-0802', {
      action: 'signal',
      expectedVersion: 3,
      event: 'email-verified',
    });
    expect(parseWorkflowActionResult(reply.body).version).toBe(4);
    const run = parseWorkflowDetail(get('executions/wf-signup-2026-0802').body).execution;
    expect(run.state).toBe('running');
    expect(run.wait).toBeNull();
    expect(run.signals.total).toBe(1);
  });

  test('cancel needs the id typed back, then ends the run', () => {
    const body = { action: 'cancel', expectedVersion: 7 };
    expect(post('wf-order-2026-0804', body).body).toMatchObject({ code: 'confirmation_required' });
    expect(post('wf-order-2026-0804', { ...body, confirm: 'wf-order-2026-0804' }).status).toBe(200);
    const run = parseWorkflowDetail(get('executions/wf-order-2026-0804').body).execution;
    expect(run.state).toBe('failed');
    expect(run.failureReason).toBe('Cancelled by an operator');
  });

  test('a finished run, an unknown run and an action that does not apply are refused', () => {
    expect(
      post('wf-month-close-2026-07', { action: 'signal', expectedVersion: 5, event: 'x' }).body
    ).toMatchObject({
      code: 'execution_terminal',
    });
    expect(post('missing', { action: 'cancel', expectedVersion: 1 }).status).toBe(404);
    expect(
      post('wf-refund-2026-0803', { action: 'signal', expectedVersion: 9, event: 'x' }).body
    ).toMatchObject({
      code: 'execution_state',
    });
  });
});
