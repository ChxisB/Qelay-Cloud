import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import { defineWorkflow, realClock } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

const boom = (message: string) => () => {
  throw new Error(message);
};

describeDb('workflow: rollback', () => {
  const { kit } = useWorkflowKit();

  test('a failure undoes the steps newest first, the failed one too: its outcome is in doubt', async () => {
    const undone: string[] = [];
    const undo = (name: string) => ({
      retry: 1,
      compensate: () => void undone.push(name),
    });
    const flow = defineWorkflow('saga')
      .step('a', () => 1, undo('a'))
      .step('b', () => 2, undo('b'))
      .step('c', boom('c broke'), undo('c'));
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('saga', {});
    const done = await untilState(engine, run.id, 'failed');
    await Bun.sleep(50);
    const settled = (await engine.getExecution(run.id))!;
    expect(undone).toEqual(['c', 'b', 'a']);
    expect(settled.rollbackStatus).toBe('completed');
    expect(settled.steps.a?.compensation?.status).toBe('compensated');
    expect(done.failureReason).toContain('c broke');
  });

  test('a compensation sees the step result it is undoing and the forward idempotency key', async () => {
    const seen: Array<{ result: unknown; forward?: string; own?: string }> = [];
    const flow = defineWorkflow('context')
      .step('charge', () => 'ch_1', {
        compensate: (ctx) =>
          void seen.push({
            result: ctx.steps.charge,
            forward: ctx.forwardIdempotencyKey,
            own: ctx.idempotencyKey,
          }),
      })
      .step('fail', boom('x'), { retry: 1 });
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('context', {});
    const done = await untilState(engine, run.id, 'failed');
    await Bun.sleep(50);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.result).toBe('ch_1');
    expect(seen[0]?.forward).toBe(done.steps.charge?.idempotencyKey);
    expect(seen[0]?.own).not.toBe(seen[0]?.forward);
  });

  test('nothing before a pivot is undone after the pivot has been crossed', async () => {
    const undone: string[] = [];
    const flow = defineWorkflow('pivoted')
      .step('reserve', () => 1, { compensate: () => void undone.push('reserve') })
      .pivot()
      .step('ship', boom('lost the parcel'), { retry: 1 });
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('pivoted', {});
    await untilState(engine, run.id, 'failed');
    await Bun.sleep(50);
    const done = (await engine.getExecution(run.id))!;
    expect(undone).toEqual([]);
    expect(done.rollbackStatus).toBe('not-applicable');
    expect(done.committedAt).toBe(1);
  });

  test('a compensation that keeps failing parks the run, and resume finishes it once fixed', async () => {
    let broken = true;
    const undone: string[] = [];
    const flow = defineWorkflow('parked')
      .step('a', () => 1, {
        compensate: () => {
          if (broken) throw new Error('refund API down');
          undone.push('a');
        },
      })
      .step('b', boom('x'), { retry: 1 });
    const engine = kit.engine({ clock: { ...realClock, random: () => 0 } });
    await engine.register(flow);
    const run = await engine.start('parked', {});
    const stuck = await untilState(engine, run.id, 'compensation-stuck', 15_000);
    expect(stuck.rollbackStatus).toBe('stuck');
    expect(stuck.steps.a?.compensation?.status).toBe('compensation-failed');

    broken = false;
    await engine.resumeCompensation(run.id);
    const done = await untilState(engine, run.id, 'failed');
    expect(done.rollbackStatus).toBe('completed');
    expect(undone).toEqual(['a']);
  }, 20_000);

  test('abandoning a parked unwind records the outstanding steps as skipped', async () => {
    const flow = defineWorkflow('abandoned')
      .step('a', () => 1, { compensate: () => {} })
      .step('b', () => 2, { compensate: boom('never works') })
      .step('c', boom('x'), { retry: 1 });
    const engine = kit.engine({ clock: { ...realClock, random: () => 0 } });
    await engine.register(flow);
    const run = await engine.start('abandoned', {});
    await untilState(engine, run.id, 'compensation-stuck', 15_000);
    await engine.abandonCompensation(run.id);
    const done = await untilState(engine, run.id, 'failed');
    expect(done.steps.b?.compensation?.status).toBe('compensation-failed');
    expect(done.steps.a?.compensation?.status).toBe('compensation-skipped');
    expect(done.rollbackStatus).toBe('stuck');
    await expect(engine.resumeCompensation(run.id)).rejects.toThrow(/not a parked unwind/);
  }, 20_000);

  test('cancelling a parked run rolls it back and fails it with the reason', async () => {
    const undone: string[] = [];
    const flow = defineWorkflow('cancellable')
      .step('a', () => 1, { compensate: () => void undone.push('a') })
      .waitFor('never');
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('cancellable', {});
    await untilState(engine, run.id, 'waiting');
    await engine.cancel(run.id, 'customer changed their mind');
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toBe('customer changed their mind');
    expect(undone).toEqual(['a']);
    await expect(engine.cancel(run.id)).rejects.toThrow(/cannot be cancelled/);
  });
});
