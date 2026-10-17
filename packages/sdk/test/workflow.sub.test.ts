import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow, WorkflowDefinitionMismatchError } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

const boom = (message: string) => () => {
  throw new Error(message);
};

describeDb('workflow: sub-workflows', () => {
  const { kit } = useWorkflowKit();

  test('a child runs to completion and the parent reads its step results', async () => {
    const child = defineWorkflow('pricing').step('quote', (ctx) => Number(ctx.input) * 2);
    const parent = defineWorkflow('order')
      .subWorkflow('pricing', (ctx) => ctx.input)
      .step('total', (ctx) => ctx.steps['sub:pricing']);
    const engine = kit.engine();
    await engine.register(child);
    await engine.register(parent);
    const run = await engine.start('order', 21);
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.total?.result).toEqual({ quote: 42 });
    const record = done.steps['sub:pricing'];
    expect(record?.status).toBe('completed');
    const kid = (await engine.getExecution(record?.childExecutionId ?? ''))!;
    expect(kid.parentExecutionId).toBe(run.id);
    expect(kid.state).toBe('completed');
  });

  test('a failing child fails the parent, and the child rolls itself back', async () => {
    const undone: string[] = [];
    const child = defineWorkflow('flaky-child')
      .step('reserve', () => 1, { compensate: () => void undone.push('reserve') })
      .step('charge', boom('card declined'), { retry: 1 });
    const parent = defineWorkflow('checkout')
      .step('cart', () => 1, { compensate: () => void undone.push('cart') })
      .subWorkflow('flaky-child', () => ({}));
    const engine = kit.engine();
    await engine.register(child);
    await engine.register(parent);
    const run = await engine.start('checkout', {});
    const done = await untilState(engine, run.id, 'failed');
    await Bun.sleep(100);
    expect(done.failureReason).toContain('flaky-child');
    expect(undone.sort()).toEqual(['cart', 'reserve']);
    const kids = (await engine.listExecutions('flaky-child')).filter(
      (exec) => exec.parentExecutionId === run.id
    );
    expect(kids).toHaveLength(1);
    expect(kids[0]?.state).toBe('failed');
  });

  test('a parent that fails after its child completed rolls the child back, once', async () => {
    const undone: string[] = [];
    const child = defineWorkflow('provision').step('vm', () => 'vm-1', {
      compensate: () => void undone.push('vm'),
    });
    const parent = defineWorkflow('launch')
      .subWorkflow('provision', () => ({}))
      .step('dns', boom('registrar down'), { retry: 1 });
    const engine = kit.engine();
    await engine.register(child);
    await engine.register(parent);
    const run = await engine.start('launch', {});
    await untilState(engine, run.id, 'failed');
    await Bun.sleep(100);
    const done = (await engine.getExecution(run.id))!;
    expect(undone).toEqual(['vm']);
    expect(done.rollbackStatus).toBe('completed');
    const kid = (await engine.getExecution(done.steps['sub:provision']?.childExecutionId ?? ''))!;
    expect(kid.rollbackStatus).toBe('completed');
  });

  test('a child that is not registered fails the parent node, not the process', async () => {
    const parent = defineWorkflow('lonely').subWorkflow('missing', () => ({}));
    const engine = kit.engine();
    await engine.register(parent);
    const run = await engine.start('lonely', {});
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toMatch(/missing/);
  });

  test('a sub-workflow node that outlives its timeout parks the parent until the child stops', async () => {
    const child = defineWorkflow('slow').waitFor('never');
    const parent = defineWorkflow('impatient').subWorkflow('slow', () => ({}), {
      timeout: 300,
      pollInterval: 20,
    });
    const engine = kit.engine();
    await engine.register(child);
    await engine.register(parent);
    const run = await engine.start('impatient', {});
    // A child that is still live cannot be rolled back, so the parent's unwind parks.
    const parked = await untilState(engine, run.id, 'compensation-stuck');
    expect(parked.failureReason).toMatch(/timed out after 300ms/);
    const childId = parked.steps['sub:slow']?.childExecutionId ?? '';
    expect((await engine.getExecution(childId))?.state).toBe('waiting');

    // The operator lets the child finish and resumes the parent's rollback.
    await engine.signal(childId, 'never', null);
    await untilState(engine, childId, 'completed');
    await engine.resumeCompensation(run.id);
    const done = await untilState(engine, run.id, 'failed');
    expect(done.rollbackStatus).toBe('completed');
  });

  test('a registered definition that differs from a live run is refused, an identical one is not', async () => {
    const v1 = defineWorkflow('versioned')
      .step('a', () => 1)
      .waitFor('go');
    const engine = kit.engine();
    await engine.register(v1);
    const run = await engine.start('versioned', {});
    await untilState(engine, run.id, 'waiting');

    const other = kit.engine();
    const v2 = defineWorkflow('versioned')
      .step('a', () => 1)
      .step('b', () => 2)
      .waitFor('go');
    await expect(other.register(v2)).rejects.toBeInstanceOf(WorkflowDefinitionMismatchError);
    const same = defineWorkflow('versioned')
      .step('a', () => 1)
      .waitFor('go');
    await other.register(same);
  });

  test('recover() drives a run its engine left behind, and reports what it did', async () => {
    const flow = defineWorkflow('orphaned')
      .step('a', () => 'A')
      .step('b', () => 'B');
    const first = kit.engine();
    await first.register(flow);
    const run = await first.start('orphaned', {});
    await first.close(true);

    const second = kit.engine();
    await second.register(flow);
    const result = await second.recover({ idleMs: 0 });
    expect(result.total).toBeGreaterThanOrEqual(0);
    const done = await untilState(second, run.id, 'completed');
    expect(done.steps.b?.result).toBe('B');
  });

  test('two restarts in a row still finish a sub-workflow once the tick re-rings the spent bell', async () => {
    const calls: string[] = [];
    const child = defineWorkflow('inner').step('work', () => void calls.push('work'));
    const parent = defineWorkflow('outer').subWorkflow('inner', () => ({}));
    const open = async () => {
      const engine = kit.engine({ concurrency: 2, heartbeatMs: 25, recoverIdleMs: 1000 });
      await engine.register(child);
      await engine.register(parent);
      return engine;
    };
    let engine = await open();
    const run = await engine.start('outer', {});
    for (let restart = 0; restart < 2; restart++) {
      await engine.close(true);
      engine = await open();
      await engine.recover({ idleMs: 0 });
    }
    const deadline = Date.now() + 10_000;
    let done = await engine.getExecution(run.id);
    while (done?.state !== 'completed' && Date.now() < deadline) {
      await kit.tick({ idleMs: 1000 });
      await Bun.sleep(50);
      done = await engine.getExecution(run.id);
    }
    expect(done?.state).toBe('completed');
    expect(calls).toEqual(['work']);
  }, 20_000);
});
