import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { keysFit, schema } from './openapiSpec';
import { completed, definition, park, seedRun, useWorkflowApi } from './workflowFixture';

// The same pin as `openapi.jobs.test.ts`, for the bodies the workflow routes serve.
describeDb('docs/openapi.yaml workflow bodies', () => {
  const w = useWorkflowApi();
  const f = w.fixture;

  const fits = async (name: string, method: string, path: string, body?: unknown) => {
    const answer = await w.api.call(method, path, body);
    expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
    expect(keysFit(answer.body, name), `${method} ${path}`).toEqual([]);
    return answer.body as Record<string, any>;
  };

  test('the list documents its overviews, definitions, warnings and summaries', async () => {
    await f.store.workflows.recordDefinition(definition('order', 'h1'));
    await seedRun(f, 'w1', { definitionHash: 'h1' });
    await seedRun(f, 'w2', { definitionHash: 'ghost' });
    await park(f, 'w1', 'approved', w.t0() + 60_000);
    const list = await fits('WorkflowList', 'GET', '/workflows');
    const [overview] = list.workflows;
    expect(keysFit(overview, 'WorkflowOverview')).toEqual([]);
    expect(overview.warnings.length).toBeGreaterThan(0);
    for (const row of overview.definitions) expect(keysFit(row, 'WorkflowDefinition')).toEqual([]);
    for (const row of overview.warnings) expect(keysFit(row, 'WorkflowWarning')).toEqual([]);
    for (const row of list.executions) expect(keysFit(row, 'WorkflowSummary')).toEqual([]);
  });

  test('a run documents its detail, steps, compensation and the steps page', async () => {
    await f.store.workflows.recordDefinition(definition('order', 'h1'));
    const steps = { charge: completed(w.t0(), { compensatable: true, result: { id: 1 } }) };
    await seedRun(f, 'w1', { definitionHash: 'h1', currentNodeIndex: 1, steps });
    await seedRun(f, 'w1-fan', {
      steps: {
        ...steps,
        ship: { status: 'pending' },
        'ship:0': { status: 'pending', loopIndex: 0 },
      },
    });
    const detail = await fits('WorkflowDetail', 'GET', '/workflows/executions/w1');
    // `WorkflowExecution` is the summary plus five fields, which `keysFit` cannot see through `allOf`.
    const extra = ['input', 'inputTruncated', 'signals', 'output', 'actions'];
    const summaryPart = Object.fromEntries(
      Object.entries(detail.execution).filter(([key]) => !extra.includes(key))
    );
    expect(keysFit(summaryPart, 'WorkflowSummary')).toEqual([]);
    for (const key of ['input', 'signals', 'output', 'actions'])
      expect(detail.execution).toHaveProperty(key);
    expect(keysFit(detail.compensation, 'WorkflowCompensation')).toEqual([]);
    for (const step of detail.steps.items) expect(keysFit(step, 'WorkflowStep')).toEqual([]);
    expect(keysFit(detail.steps, 'WorkflowStepsPage')).toEqual([]);

    const fan = await fits('WorkflowDetail', 'GET', '/workflows/executions/w1-fan');
    const fanned = fan.steps.items.find((step: any) => step.fanOut !== undefined);
    expect(keysFit(fanned.fanOut, 'WorkflowFanOut')).toEqual([]);
    await fits(
      'WorkflowStepsEnvelope',
      'GET',
      '/workflows/executions/w1-fan/steps?iterationOf=ship'
    );
  });

  test('an action documents what it answers', async () => {
    await w.parked();
    const answer = await fits('WorkflowActionResult', 'POST', '/workflows/executions/w1/actions', {
      action: 'signal',
      expectedVersion: await w.version('w1'),
      event: 'approved',
    });
    expect(answer.action).toBe('signal');
    await seedRun(f, 'w2');
    await fits('WorkflowActionResult', 'POST', '/workflows/executions/w2/actions', {
      action: 'cancel',
      expectedVersion: await w.version('w2'),
      confirm: 'w2',
    });
  });

  test('the action request schema names every field the route accepts, and no other', () => {
    expect(Object.keys(schema('WorkflowActionBody').properties ?? {}).sort()).toEqual(
      ['action', 'confirm', 'event', 'expectedVersion', 'payload', 'reason'].sort()
    );
    expect(schema('WorkflowActionBody').additionalProperties).toBe(false);
  });
});
