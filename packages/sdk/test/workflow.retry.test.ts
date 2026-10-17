import { expect, test } from 'bun:test';
import { describeDb } from '../../../test/support/db';
import type { Clock, WorkflowEvent } from '../src';
import { defineWorkflow, realClock, Workflow } from '../src';
import { untilState, useWorkflowKit } from './workflowSupport';

/** Retry backoff (500 ms, then 1 s, with no jitter) collapses to 5 ms; every other timer is real. */
const fastRetries: Clock = {
  ...realClock,
  random: () => 0,
  setTimeout: (fn, ms) => realClock.setTimeout(fn, ms === 500 || ms === 1000 ? 5 : ms),
};

describeDb('workflow: retries, timeouts and failure', () => {
  const { kit } = useWorkflowKit();

  test('a flaky step is retried with the same idempotency key and the attempts are recorded', async () => {
    const keys: Array<string | undefined> = [];
    const events: string[] = [];
    const flow = defineWorkflow('flaky').step(
      'charge',
      (ctx) => {
        keys.push(ctx.idempotencyKey);
        if (keys.length < 3) throw new Error(`boom ${keys.length}`);
        return 'charged';
      },
      { retry: 3 }
    );
    const engine = kit.engine({
      clock: fastRetries,
      onEvent: (e: WorkflowEvent) => void events.push(e.type),
    });
    await engine.register(flow);
    const run = await engine.start('flaky', {});
    const done = await untilState(engine, run.id, 'completed');
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toContain(run.id);
    expect(done.steps.charge?.attempts).toBe(3);
    expect(events.filter((t) => t === 'step:retry')).toHaveLength(2);
  });

  test('a step that exhausts its retries fails the run and says why', async () => {
    const flow = defineWorkflow('doomed').step(
      'always',
      () => {
        throw new Error('nope');
      },
      { retry: 2 }
    );
    const engine = kit.engine({ clock: fastRetries });
    await engine.register(flow);
    const run = await engine.start('doomed', {});
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toContain('nope');
    expect(done.steps.always?.status).toBe('failed');
    expect(done.steps.always?.attempts).toBe(2);
  });

  test('a step that outlives its timeout is failed and its signal is aborted', async () => {
    let aborted = false;
    const flow = defineWorkflow('slow').step(
      'hang',
      (ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      { retry: 1, timeout: 60 }
    );
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('slow', {});
    const done = await untilState(engine, run.id, 'failed');
    expect(done.failureReason).toMatch(/timed out|timeout/i);
    expect(aborted).toBe(true);
  });

  test('a failing run stops later steps from running', async () => {
    let later = 0;
    const flow = defineWorkflow('stops')
      .step(
        'bad',
        () => {
          throw new Error('x');
        },
        { retry: 1 }
      )
      .step('later', () => ++later);
    const engine = kit.engine();
    await engine.register(flow);
    const run = await engine.start('stops', {});
    await untilState(engine, run.id, 'failed');
    expect(later).toBe(0);
  });

  test('the builder refuses numeric bounds that could never work', () => {
    const noop = () => null;
    for (const retry of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Workflow('r').step('s', noop, { retry })).toThrow();
    }
    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Workflow('t').step('s', noop, { timeout })).toThrow();
      expect(() => new Workflow('w').waitFor('e', { timeout })).toThrow();
    }
    for (const maxIterations of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        new Workflow('l').doUntil(
          () => true,
          (w) => w.step('s', noop),
          { maxIterations }
        )
      ).toThrow();
    }
    for (const bad of [0, -5, Number.NaN]) {
      expect(() => new Workflow('c').subWorkflow('kid', () => ({}), { timeout: bad })).toThrow();
      expect(() =>
        new Workflow('p').subWorkflow('kid', () => ({}), { pollInterval: bad })
      ).toThrow();
    }
  });

  test('structural mistakes in a definition are refused at build or register time', async () => {
    expect(() => new Workflow('x').path('a', (w) => w)).toThrow(/after|follow/i);
    const engine = kit.engine();
    await expect(engine.register(defineWorkflow('empty'))).rejects.toThrow();
    const twice = defineWorkflow('twice').step('a', () => 1);
    await engine.register(twice);
    await expect(engine.register(defineWorkflow('twice').step('a', () => 1))).rejects.toThrow(
      /already/i
    );
    await expect(
      engine.register(
        defineWorkflow('dupe')
          .step('a', () => 1)
          .step('a', () => 2)
      )
    ).rejects.toThrow();
  });
});
