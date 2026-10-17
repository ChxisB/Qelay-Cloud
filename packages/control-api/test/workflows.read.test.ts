import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { StepRecord } from '@qelay-cloud/core';
import { describeDb } from '../../../test/support/db';
import type { JobsApi, JobsFixture } from './jobsFixture';
import { openJobsFixture } from './jobsFixture';
import { completed, definition, park, seedRun } from './workflowFixture';

describeDb('workflow read routes', () => {
  let f: JobsFixture;
  let api: JobsApi;
  beforeAll(async () => {
    f = await openJobsFixture();
  });
  afterAll(() => f.drop());
  beforeEach(async () => {
    await f.reset();
    api = f.api({ summaryCacheMs: 0, listPayloadBytes: 300, detailPayloadBytes: 2_000 });
  });

  const t0 = () => f.t.clock.now();

  test('capabilities turn workflows on where the schema has the workflow tables', async () => {
    const answer = await api.call('GET', '/capabilities');
    expect(answer.body.features.workflows).toBe(true);
  });

  test('an empty namespace has nothing to show', async () => {
    const answer = await api.call('GET', '/workflows');
    expect(answer).toMatchObject({
      status: 200,
      body: { ok: true, workflows: [], executions: [], total: 0, offset: 0, hasMore: false },
    });
  });

  test('the list counts runs per workflow and state, newest first, and filters and pages', async () => {
    for (const [id, name, state] of [
      ['a', 'order', 'running'],
      ['b', 'order', 'failed'],
      ['c', 'refund', 'completed'],
      ['d', 'order', 'running'],
    ] as const) {
      await seedRun(f, id, { workflowName: name, state });
      f.t.clock.advance(10);
    }
    const all = await api.call('GET', '/workflows');
    expect(all.body.executions.map((run: any) => run.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(all.body.total).toBe(4);
    const order = all.body.workflows.find((w: any) => w.name === 'order');
    expect(order).toMatchObject({ total: 3, counts: { running: 2, failed: 1 } });
    expect(all.body.workflows.map((w: any) => w.name)).toEqual(['order', 'refund']);

    const running = await api.call('GET', '/workflows?name=order&state=running');
    expect(running.body.executions.map((run: any) => run.id)).toEqual(['d', 'a']);
    expect(running.body.total).toBe(2);
    expect(running.body.workflows.map((w: any) => w.name)).toEqual(['order']);

    const page = await api.call('GET', '/workflows?limit=3&offset=3');
    expect(page.body).toMatchObject({ total: 4, limit: 3, offset: 3, hasMore: false });
    expect(page.body.executions.map((run: any) => run.id)).toEqual(['a']);
    const first = await api.call('GET', '/workflows?limit=3');
    expect(first.body.hasMore).toBe(true);
  });

  test('a summary names the version an action must send back and what a parked run waits for', async () => {
    await seedRun(f, 'w1');
    await park(f, 'w1', 'approved', t0() + 60_000);
    const { body } = await api.call('GET', '/workflows');
    expect(body.executions[0]).toMatchObject({
      id: 'w1',
      state: 'waiting',
      version: expect.any(Number),
      wait: { event: 'approved', deadlineAt: t0() + 60_000 },
    });
  });

  test('a definition no worker announced lately is not served, and live runs on it raise a warning', async () => {
    await f.store.workflows.recordDefinition(definition('order', 'old'));
    f.t.clock.advance(10 * 60_000);
    await f.store.workflows.recordDefinition(definition('order', 'new'));
    await seedRun(f, 'on-old', { definitionHash: 'old' });
    await seedRun(f, 'on-new', { definitionHash: 'new' });
    await seedRun(f, 'on-ghost', { definitionHash: 'ghost' });
    await seedRun(f, 'done', { definitionHash: 'old', state: 'completed' });

    const [order] = (await api.call('GET', '/workflows')).body.workflows;
    expect(order.definitions.map((d: any) => [d.hash, d.served, d.liveRuns])).toEqual([
      ['new', true, 1],
      ['old', false, 1],
    ]);
    expect(order.warnings.map((w: any) => [w.hash, w.runs, w.known, w.code]).sort()).toEqual([
      ['ghost', 1, false, 'unserved_definition'],
      ['old', 1, true, 'unserved_definition'],
    ]);
    expect(order.warnings[0].message).toContain('no worker serves');
  });

  test('a run shows its input, signals, last result, definition graph and the actions that would apply', async () => {
    await f.store.workflows.recordDefinition(definition('order', 'h1'));
    await seedRun(f, 'w1', {
      definitionHash: 'h1',
      steps: { charge: completed(t0(), { result: { receipt: 'r-1' }, compensatable: true }) },
      currentNodeIndex: 1,
    });
    await park(f, 'w1', 'approved');
    const { status, body } = await api.call('GET', '/workflows/executions/w1');
    expect(status).toBe(200);
    expect(body.execution).toMatchObject({
      id: 'w1',
      state: 'waiting',
      input: { orderId: 'w1' },
      signals: { total: 0, items: [] },
      output: { step: 'charge', result: { receipt: 'r-1' } },
      actions: ['signal', 'cancel'],
    });
    expect(body.definition).toMatchObject({ hash: 'h1', revision: 'rev-h1', served: true });
    expect(body.definition.graph).toHaveLength(3);
    expect(body.steps.items[0]).toMatchObject({ name: 'charge', status: 'completed' });
    expect(body.compensation).toMatchObject({ status: 'none', eligible: 1 });
    expect(body.children).toEqual({ total: 0, items: [] });
  });

  test('a finished run offers no action, and a run with no known definition shows none', async () => {
    await seedRun(f, 'w1', { state: 'completed' });
    const { body } = await api.call('GET', '/workflows/executions/w1');
    expect(body.execution.actions).toEqual([]);
    expect(body.definition).toBeNull();
  });

  test('a stuck rollback lists its failures and the two ways out', async () => {
    await seedRun(f, 'w1', {
      state: 'compensation-stuck',
      steps: {
        a: completed(t0(), { compensatable: true, compensation: { status: 'compensated', at: 1 } }),
        b: completed(t0(), {
          compensatable: true,
          compensation: { status: 'compensation-failed', at: 2, error: 'refund refused' },
        }),
        c: completed(t0(), { compensatable: true }),
      },
    });
    const { body } = await api.call('GET', '/workflows/executions/w1');
    expect(body.execution.actions).toEqual(['retry-compensation', 'abandon-compensation']);
    expect(body.compensation).toEqual({
      status: 'stuck',
      eligible: 1,
      compensated: 1,
      failed: 1,
      skipped: 0,
      failures: [{ step: 'b', error: 'refund refused' }],
    });
  });

  test('children are listed with the step that started them', async () => {
    await seedRun(f, 'parent', {
      steps: { 'send-all': { status: 'running', childExecutionId: 'child-1' } },
    });
    await seedRun(f, 'child-1', { parentExecutionId: 'parent', workflowName: 'send' });
    const { body } = await api.call('GET', '/workflows/executions/parent');
    expect(body.children).toEqual({
      total: 1,
      items: [{ step: 'send-all', executionId: 'child-1' }],
    });
    const child = await api.call('GET', '/workflows?name=send');
    expect(child.body.executions[0]).toMatchObject({ id: 'child-1', parentExecutionId: 'parent' });
  });

  test('payloads past the byte budget become truncation markers, in the input, a result and an error', async () => {
    const big = 'x'.repeat(5_000);
    await seedRun(f, 'w1', {
      input: { blob: big },
      steps: {
        charge: completed(t0(), { result: { blob: big } }),
        broken: { status: 'failed', error: 'e'.repeat(3_000), startedAt: t0() + 1 },
      },
    });
    const { body } = await api.call('GET', '/workflows/executions/w1');
    expect(body.execution.inputTruncated).toBe(true);
    expect(body.execution.input).toMatchObject({ $type: 'truncated', maxBytes: 2_000 });
    expect(JSON.stringify(body.execution.input).length).toBeLessThan(1_000);
    const [charge, broken] = body.steps.items;
    expect(charge).toMatchObject({ name: 'charge', resultTruncated: true });
    expect(charge.result.$type).toBe('truncated');
    expect(broken.errorTruncated).toBe(true);
    expect(broken.error).toHaveLength(2_000);
    expect(body.execution.output.truncated).toBe(true);

    // The one record, read by name, gets the detail budget (2,000 bytes): the result is still too big for it.
    const one = await api.call('GET', '/workflows/executions/w1/steps?name=charge');
    expect(one.body.steps.items[0].result.maxBytes).toBe(2_000);
    const small = await api.call('GET', '/workflows/executions/w1/steps?name=broken');
    expect(small.body.steps.total).toBe(1);
  });

  test('a fan-out is one entry with counts, and its iterations are read a page at a time', async () => {
    const steps: Record<string, StepRecord> = {};
    for (let n = 0; n < 250; n++) {
      steps[`ship:${n}`] = {
        status: n === 7 ? 'failed' : n < 200 ? 'completed' : 'pending',
        loopIndex: n,
        loopItem: { sku: n },
        startedAt: t0() + n,
        ...(n < 3 ? { compensatable: true, compensation: { status: 'compensated', at: 1 } } : {}),
      };
    }
    steps.ship = { status: 'pending', startedAt: t0() };
    steps.charge = completed(t0() - 1);
    await seedRun(f, 'w1', { steps });

    const { body } = await api.call('GET', '/workflows/executions/w1');
    expect(body.steps.total).toBe(2);
    expect(body.steps.items.map((s: any) => s.name)).toEqual(['charge', 'ship']);
    expect(body.steps.items[1].fanOut).toEqual({
      iterations: 250,
      byStatus: { pending: 50, running: 0, completed: 199, failed: 1 },
      compensation: { compensated: 3, failed: 0, skipped: 0 },
    });
    // Compensation counts the iterations once, not the mirror of the latest one.
    expect(body.compensation.compensated).toBe(3);

    const page = await api.call(
      'GET',
      '/workflows/executions/w1/steps?iterationOf=ship&limit=100&offset=200'
    );
    expect(page.body.steps).toMatchObject({ total: 250, limit: 100, offset: 200, hasMore: false });
    expect(page.body.steps.items).toHaveLength(50);
    expect(page.body.steps.items[0]).toMatchObject({ name: 'ship:200', loopIndex: 200 });
    const failed = await api.call(
      'GET',
      '/workflows/executions/w1/steps?iterationOf=ship&status=failed'
    );
    expect(failed.body.steps.items.map((s: any) => s.name)).toEqual(['ship:7']);
    const none = await api.call('GET', '/workflows/executions/w1/steps?iterationOf=nothing');
    expect(none.body.steps).toMatchObject({ items: [], total: 0, hasMore: false });
  });

  test('a run that does not exist is 404, and a bad query is 400', async () => {
    for (const path of ['/workflows/executions/nope', '/workflows/executions/nope/steps']) {
      const answer = await api.call('GET', path);
      expect(answer.status).toBe(404);
      expect(answer.body.error.code).toBe('execution_not_found');
    }
    expect((await api.call('GET', '/workflows?state=asleep')).status).toBe(400);
    expect((await api.call('GET', '/workflows?limit=0')).status).toBe(400);
    expect((await api.call('GET', '/workflows?offset=999999')).body.error.code).toBe(
      'offset_too_large'
    );
  });

  test('a viewer reads everything', async () => {
    await seedRun(f, 'w1');
    for (const path of [
      '/workflows',
      '/workflows/executions/w1',
      '/workflows/executions/w1/steps',
    ]) {
      expect((await api.asViewer('GET', path)).status).toBe(200);
    }
  });
});
