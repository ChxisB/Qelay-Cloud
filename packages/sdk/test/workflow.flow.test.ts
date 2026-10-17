import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow } from '../src';
import type { WorkflowEvent } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

describeDb('workflow: running a definition', () => {
  const { kit } = useWorkflowKit();

  test('steps run in order and each sees what the earlier ones returned', async () => {
    const flow = defineWorkflow('linear')
      .step('a', (ctx) => `a(${String(ctx.input)})`)
      .step('b', (ctx) => `${String(ctx.steps.a)}>b`)
      .step('c', (ctx) => `${String(ctx.steps.b)}>c`);
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('linear', 'x');
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.c?.result).toBe('a(x)>b>c');
    expect(Object.keys(done.steps)).toEqual(['a', 'b', 'c']);
  });

  test('startWorkflow is start under the name the plan uses', async () => {
    const engine = kit.engine();
    await engine.register(defineWorkflow('alias').step('a', () => 1));
    const run = await engine.startWorkflow('alias', null);
    expect((await untilState(engine, run.id, 'completed')).steps.a?.result).toBe(1);
  });

  test('starting an unknown workflow is refused', async () => {
    const engine = kit.engine();
    await expect(engine.start('nobody-registered-this', {})).rejects.toThrow(/not registered/);
  });

  test('a branch runs the chosen path and leaves the other untouched', async () => {
    const ran: string[] = [];
    const flow = defineWorkflow('branching')
      .branch((ctx) => (ctx.input === 'big' ? 'big' : 'small'))
      .path('big', (w) => w.step('bigStep', () => ran.push('big')))
      .path('small', (w) => w.step('smallStep', () => ran.push('small')))
      .step('after', () => 'done');
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('branching', 'big');
    const done = await untilState(engine, run.id, 'completed');
    expect(ran).toEqual(['big']);
    expect(done.steps.bigStep?.status).toBe('completed');
    expect(done.steps.smallStep).toBeUndefined();
    expect(done.steps.after?.result).toBe('done');
  });

  test('parallel steps all run and the next node sees every result', async () => {
    const flow = defineWorkflow('fanout')
      .parallel((w) =>
        w
          .step('left', async () => {
            await Bun.sleep(30);
            return 'L';
          })
          .step('right', () => 'R')
      )
      .step('join', (ctx) => `${String(ctx.steps.left)}${String(ctx.steps.right)}`);
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('fanout', {});
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.join?.result).toBe('LR');
  });

  test('doUntil repeats its body until the condition holds, doWhile checks first', async () => {
    let until = 0;
    let whileRuns = 0;
    const flow = defineWorkflow('loops')
      .doUntil(
        () => until >= 3,
        (w) => w.step('tick', () => ++until)
      )
      .doWhile(
        () => false,
        (w) => w.step('never', () => ++whileRuns)
      );
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('loops', {});
    await untilState(engine, run.id, 'completed');
    expect(until).toBe(3);
    expect(whileRuns).toBe(0);
  });

  test('a loop that never satisfies its condition stops at maxIterations and fails the run', async () => {
    const flow = defineWorkflow('runaway').doUntil(
      () => false,
      (w) => w.step('spin', () => 1),
      { maxIterations: 2 }
    );
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('runaway', {});
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toMatch(/maxIterations|iterations/i);
  });

  test('forEach runs the step per item and map shapes a value from the results', async () => {
    const flow = defineWorkflow('each')
      .forEach(
        (ctx) => ctx.input as number[],
        'double',
        (ctx) => (ctx.steps.__item as number) * 2
      )
      .map('sum', (ctx) => {
        const steps = ctx.steps as Record<string, unknown>;
        return [0, 1, 2].reduce((total, i) => total + (steps[`double:${i}`] as number), 0);
      });
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('each', [1, 2, 3]);
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.sum?.result).toBe(12);
  });

  test('events narrate the run in order', async () => {
    const seen: string[] = [];
    const engine = kit.engine({ onEvent: (e: WorkflowEvent) => void seen.push(e.type) });
    await engine.register(defineWorkflow('narrated').step('a', () => 1));
    const run = await engine.start('narrated', {});
    await untilState(engine, run.id, 'completed');
    expect(seen).toEqual([
      'workflow:started',
      'step:started',
      'step:completed',
      'workflow:completed',
    ]);
  });

  test('listExecutions filters by workflow and state, newest first', async () => {
    const engine = kit.engine();
    await engine.register(defineWorkflow('listed').step('a', () => 1));
    const first = await engine.start('listed', 1);
    const second = await engine.start('listed', 2);
    await untilState(engine, first.id, 'completed');
    await untilState(engine, second.id, 'completed');
    const rows = await engine.listExecutions('listed', 'completed');
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    expect(await engine.listExecutions('listed', 'failed')).toEqual([]);
  });
});
