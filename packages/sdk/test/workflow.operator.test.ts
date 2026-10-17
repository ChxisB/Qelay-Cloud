import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow, realClock } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

const boom = (message: string) => () => {
  throw new Error(message);
};

const parkedFlow = (name: string, state: { broken: boolean; undone: string[] }) =>
  defineWorkflow(name)
    .step('a', () => 1, {
      compensate: () => {
        if (state.broken) throw new Error('refund API down');
        state.undone.push('a');
      },
    })
    .step('b', boom('x'), { retry: 1 });

describeDb('workflow: operator step jobs', () => {
  const { kit } = useWorkflowKit();
  const engineOptions = { clock: { ...realClock, random: () => 0 } };

  test('a retry-compensation job drives a parked unwind once the fault is fixed', async () => {
    const state = { broken: true, undone: [] as string[] };
    const engine = kit.engine(engineOptions);
    await engine.register(parkedFlow('retry', state));
    const run = await engine.start('retry', {});
    await untilState(engine, run.id, 'compensation-stuck', 15_000);

    state.broken = false;
    await kit.publishStep({
      executionId: run.id,
      workflowName: 'retry',
      nodeIndex: 0,
      operator: 'retry-compensation',
    });
    const done = await untilState(engine, run.id, 'failed');
    expect(done.rollbackStatus).toBe('completed');
    expect(state.undone).toEqual(['a']);
  }, 25_000);

  test('an abandon-compensation job records the outstanding steps as skipped', async () => {
    const flow = defineWorkflow('abandon')
      .step('a', () => 1, { compensate: () => {} })
      .step('b', () => 2, { compensate: boom('never works') })
      .step('c', boom('x'), { retry: 1 });
    const engine = kit.engine(engineOptions);
    await engine.register(flow);
    const run = await engine.start('abandon', {});
    await untilState(engine, run.id, 'compensation-stuck', 15_000);
    await kit.publishStep({
      executionId: run.id,
      workflowName: 'abandon',
      nodeIndex: 0,
      operator: 'abandon-compensation',
    });
    const done = await untilState(engine, run.id, 'failed');
    expect(done.steps.a?.compensation?.status).toBe('compensation-skipped');
    expect(done.rollbackStatus).toBe('stuck');
  }, 25_000);

  test('an operator job for a run that is not parked ends without touching it', async () => {
    const state = { broken: false, undone: [] as string[] };
    const engine = kit.engine();
    await engine.register(parkedFlow('settled', state));
    const run = await engine.start('settled', {});
    const done = await untilState(engine, run.id, 'failed');
    await Bun.sleep(100);
    const before = (await engine.getExecution(run.id))!;
    await kit.publishStep({
      executionId: run.id,
      workflowName: 'settled',
      nodeIndex: 0,
      operator: 'retry-compensation',
    });
    await Bun.sleep(300);
    const after = (await engine.getExecution(run.id))!;
    expect(after.version).toBe(before.version);
    expect(after.state).toBe(done.state);
    expect(state.undone).toEqual(['a']);
  });
});
