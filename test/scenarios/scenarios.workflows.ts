import { expect } from 'bun:test';
import { defineWorkflow } from '../../packages/sdk/src';
import type { Scenario } from './scenario';
import { until } from './scenario';
import { runReader, untilRun, workflowEngines, workflowStack } from './workflowStack';

/** Counts how often each named body ran. */
function counter() {
  const runs = new Map<string, number>();
  return {
    hit(name: string): number {
      const n = (runs.get(name) ?? 0) + 1;
      runs.set(name, n);
      return n;
    },
    count: (name: string) => runs.get(name) ?? 0,
    all: () => Object.fromEntries([...runs].sort()),
  };
}

/** Workflow engines on every transport: steps travel as jobs, and the tick keeps time and repairs. */
export const workflowScenarios: readonly Scenario[] = [
  {
    name: 'workflow: steps, a parallel group and a sub-workflow run in order, each body once',
    suite: 'workflows',
    stack: workflowStack,
    async run(s) {
      const engines = workflowEngines(s);
      const seen = counter();
      try {
        const engine = engines.engine();
        await engine.register(
          defineWorkflow('pricing').step(
            'quote',
            (ctx) => (seen.hit('quote'), Number(ctx.input) * 2)
          )
        );
        await engine.register(
          defineWorkflow('order')
            .step('reserve', () => (seen.hit('reserve'), 'R'))
            .parallel((w) =>
              w
                .step('left', () => (seen.hit('left'), 'L'))
                .step('right', () => (seen.hit('right'), 'Rt'))
            )
            .subWorkflow('pricing', () => 21)
            .step('ship', (ctx) => (seen.hit('ship'), ctx.steps['sub:pricing']))
        );
        const run = await engine.start('order', {});
        const done = await untilRun(engine, run.id, 'completed');
        expect(done.steps.ship?.result).toEqual({ quote: 42 });
        expect(seen.all()).toEqual({ left: 1, quote: 1, reserve: 1, right: 1, ship: 1 });
        const states = await s.states('__wf:steps');
        expect(Object.keys(states).every((state) => state === 'completed')).toBe(true);
      } finally {
        await engines.close();
      }
    },
  },
  {
    name: 'workflow: a signal opens a gate, and a gate with a timeout expires on the tick',
    suite: 'workflows',
    stack: workflowStack,
    async run(s) {
      const engines = workflowEngines(s);
      try {
        const engine = engines.engine();
        await engine.register(
          defineWorkflow('approval')
            .waitFor('approved')
            .step('publish', (ctx) => ctx.signals.approved)
        );
        await engine.register(
          defineWorkflow('deadline')
            .waitFor('never', { timeout: 600 })
            .step('after', () => 1)
        );
        const open = await engine.start('approval', {});
        const timed = await engine.start('deadline', {});
        await untilRun(engine, open.id, 'waiting');
        await engine.signal(open.id, 'approved', { by: 'ops' });
        const done = await untilRun(engine, open.id, 'completed');
        expect(done.steps.publish?.result).toEqual({ by: 'ops' });

        // The wait ends on the database's clock, found by the tick: late by at most a tick or two.
        const failed = await untilRun(engine, timed.id, 'failed');
        expect(failed.failureReason).toMatch(/timed out/);
        expect(failed.steps.after).toBeUndefined();
      } finally {
        await engines.close();
      }
    },
  },
  {
    name: 'workflow: a failing step rolls back the earlier ones in reverse order, once each',
    suite: 'workflows',
    stack: workflowStack,
    async run(s) {
      const engines = workflowEngines(s);
      const order: string[] = [];
      const seen = counter();
      try {
        const engine = engines.engine();
        await engine.register(
          defineWorkflow('checkout')
            .step('cart', () => 'c', { compensate: () => void order.push('cart') })
            .step('hold', () => 'h', { compensate: () => void order.push('hold') })
            .step(
              'charge',
              () => {
                seen.hit('charge');
                throw new Error('card declined');
              },
              { retry: 1 }
            )
        );
        const run = await engine.start('checkout', {});
        const done = await untilRun(engine, run.id, 'failed');
        await until('the rollback to be recorded', async () => {
          const now = await engine.getExecution(run.id);
          return now?.rollbackStatus === undefined ? null : now;
        });
        expect(done.failureReason).toMatch(/card declined/);
        expect(order).toEqual(['hold', 'cart']);
        expect(seen.count('charge')).toBe(1);
        expect((await engine.getExecution(run.id))?.rollbackStatus).toBe('completed');
      } finally {
        await engines.close();
      }
    },
  },
  {
    name: 'workflow: an engine that dies between two steps is resumed once by another, and no step repeats',
    suite: 'workflows',
    stack: workflowStack,
    timeoutMs: 90_000,
    async run(s) {
      const engines = workflowEngines(s);
      const seen = counter();
      try {
        const first = engines.engine({
          onEvent: (event) => {
            // The record of `a` is written; the node after it is not published yet.
            if (event.type === 'step:completed' && 'stepName' in event && event.stepName === 'a') {
              void first.close(true);
            }
          },
        });
        const flow = () =>
          defineWorkflow('relay')
            .step('a', () => (seen.hit('a'), 'A'))
            .step('b', () => (seen.hit('b'), 'B'))
            .step('c', () => (seen.hit('c'), 'C'));
        await first.register(flow());
        const run = await first.start('relay', {});
        const reader = runReader(s);
        await until('step a to be recorded', async () => {
          const now = await reader.getExecution(run.id);
          return now?.steps.a?.status === 'completed' ? now : null;
        });

        const second = engines.engine();
        await second.register(flow());
        const done = await untilRun(second, run.id, 'completed', 60_000);
        expect(seen.all()).toEqual({ a: 1, b: 1, c: 1 });
        expect(Object.values(done.steps).map((record) => record.attempts)).toEqual([1, 1, 1]);
      } finally {
        await engines.close();
      }
    },
  },
  {
    name: 'workflow: a rollback whose engine died is finished once by another, and only the missing undo runs',
    suite: 'workflows',
    stack: workflowStack,
    timeoutMs: 90_000,
    async run(s) {
      const engines = workflowEngines(s);
      const undone = counter();
      try {
        const first = engines.engine({
          onEvent: (event) => {
            // Right before `cart`'s undo: `hold`'s is recorded, so the survivor must not repeat it.
            if (
              event.type === 'compensation:started' &&
              'stepName' in event &&
              event.stepName === 'cart'
            ) {
              void first.close(true);
            }
          },
        });
        const flow = () =>
          defineWorkflow('refund')
            .step('cart', () => 'c', { compensate: () => void undone.hit('cart') })
            .step('hold', () => 'h', { compensate: () => void undone.hit('hold') })
            .step(
              'charge',
              () => {
                throw new Error('declined');
              },
              { retry: 1 }
            );
        await first.register(flow());
        const run = await first.start('refund', {});

        const second = engines.engine();
        await second.register(flow());
        const done = await untilRun(second, run.id, 'failed', 60_000);
        await until(
          'the rollback to be recorded',
          async () => {
            const now = await second.getExecution(run.id);
            return now?.rollbackStatus === 'completed' ? now : null;
          },
          60_000
        );
        expect(done.failureReason).toMatch(/declined/);
        expect(undone.all()).toEqual({ cart: 1, hold: 1 });
      } finally {
        await engines.close();
      }
    },
  },
];
