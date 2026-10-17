import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

describeDb('workflow: waiting for signals', () => {
  const { kit } = useWorkflowKit();

  const gate = (name: string, timeout?: number) =>
    defineWorkflow(name)
      .step('before', () => 'b')
      .waitFor('approval', timeout === undefined ? undefined : { timeout })
      .step('after', (ctx) => ({ saw: ctx.signals.approval }));

  test('a run parks at the gate and a signal resumes it with the payload', async () => {
    const engine = kit.engine();
    await engine.register(gate('approve'));
    const run = await engine.start('approve', {});
    const parked = await untilState(engine, run.id, 'waiting');
    expect(parked.steps.before?.status).toBe('completed');
    await engine.signal(run.id, 'approval', { by: 'ana' });
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.after?.result).toEqual({ saw: { by: 'ana' } });
  });

  test('a signal that arrives before the run reaches the gate is not lost', async () => {
    const engine = kit.engine();
    await engine.register(
      defineWorkflow('early')
        .step('slow', async () => {
          await Bun.sleep(150);
          return 1;
        })
        .waitFor('go')
        .step('after', (ctx) => ctx.signals.go)
    );
    const run = await engine.start('early', {});
    await engine.signal(run.id, 'go', 'now');
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.after?.result).toBe('now');
  });

  test('a second signal for the same event is refused and the first payload stays', async () => {
    const engine = kit.engine();
    await engine.register(gate('twice'));
    const run = await engine.start('twice', {});
    await untilState(engine, run.id, 'waiting');
    await engine.signal(run.id, 'approval', 'first');
    await expect(engine.signal(run.id, 'approval', 'second')).rejects.toThrow(/already received/);
    const done = await untilState(engine, run.id, 'completed');
    expect(done.signals.approval).toBe('first');
  });

  test('signalling an unknown run, or a finished one, is refused', async () => {
    const engine = kit.engine();
    await engine.register(defineWorkflow('quick').step('a', () => 1));
    await expect(engine.signal('wf_missing', 'x', 1)).rejects.toThrow(/not found/);
    const run = await engine.start('quick', {});
    await untilState(engine, run.id, 'completed');
    await expect(engine.signal(run.id, 'late', 1)).rejects.toThrow(/cannot receive/);
  });

  test('an overdue timed gate fails the run when the tick finds it', async () => {
    const engine = kit.engine();
    await engine.register(gate('timed', 60));
    const run = await engine.start('timed', {});
    await untilState(engine, run.id, 'waiting');
    await Bun.sleep(120);
    const report = await kit.sweep();
    expect(report.due).toBe(1);
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toContain('timed out after 60ms');
    expect(done.steps['__waitFor:approval']?.status).toBe('failed');
  });

  test('the tick leaves a gate alone until its deadline has passed on the store clock', async () => {
    const engine = kit.engine();
    await engine.register(gate('patient', 60_000));
    const run = await engine.start('patient', {});
    await untilState(engine, run.id, 'waiting');
    expect((await kit.sweep()).due).toBe(0);
    expect((await engine.getExecution(run.id))?.state).toBe('waiting');
  });

  test('a signal that beats the tick wins: the gate opens and the timeout is not reported', async () => {
    const events: string[] = [];
    const engine = kit.engine({ onEvent: (e) => void events.push(e.type) });
    await engine.register(gate('race', 60));
    const run = await engine.start('race', {});
    await untilState(engine, run.id, 'waiting');
    await Bun.sleep(120);
    await engine.signal(run.id, 'approval', 'in time');
    await kit.sweep();
    const done = await untilState(engine, run.id, 'completed');
    expect(done.steps.after?.result).toEqual({ saw: 'in time' });
    expect(events).not.toContain('signal:timeout');
  });

  test('the tick expires a wait that no engine is running any more', async () => {
    const first = kit.engine();
    await first.register(gate('orphaned', 60));
    const run = await first.start('orphaned', {});
    await untilState(first, run.id, 'waiting');
    await first.close(true);

    const second = kit.engine();
    await second.register(gate('orphaned', 60));
    await Bun.sleep(120);
    await kit.sweep();
    expect((await untilState(second, run.id, 'failed')).failureReason).toContain('timed out');
  });
});
